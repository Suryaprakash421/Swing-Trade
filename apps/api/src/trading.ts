import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@paper/db';
import { auth } from './auth.js';
import {
  ApiError,
  D,
  Decimal,
  accountBalance,
  accountObject,
  bad,
  dateStart,
  event,
  findTrade,
  limitExpiry,
  lockedTrade,
  marketState,
  money,
  quoteObject,
  requestQuotes,
  tradeObject,
  usableQuote,
  validateBracket,
  validatePrice,
  type Db,
  type Row,
} from './domain.js';

const numeric = z.union([z.string().regex(/^\d+(?:\.\d{1,8})?$/), z.number().finite().positive()]);
const params = (request: any) => request.params as { id: string; symbol: string };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const p = schema.safeParse(value);
  if (!p.success) bad(p.error.issues[0]?.message ?? 'Check the submitted values.');
  return p.data;
};

export interface TradeFilters {
  status?: string;
  symbol?: string;
  tag?: string;
  from?: string;
  to?: string;
  exit_reason?: string;
}
export function filters(raw: any): TradeFilters {
  const q = parse(
    z.object({
      status: z.enum(['PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'EXPIRED']).optional(),
      symbol: z.string().max(30).optional(),
      tag: z.string().max(80).optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      exit_reason: z.enum(['TARGET', 'STOP', 'MANUAL']).optional(),
    }),
    Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== '')),
  );
  for (const day of [q.from, q.to])
    if (
      day &&
      (Number.isNaN(dateStart(day).getTime()) ||
        day !== new Date(dateStart(day).getTime() + 19_800_000).toISOString().slice(0, 10))
    )
      bad('Use valid calendar dates.');
  if (q.from && q.to && q.from > q.to) bad('The start date must be before the end date.');
  return q;
}

export async function selectTrades(accountId: string, query: TradeFilters = {}) {
  const start = query.from ? dateStart(query.from) : null;
  const end = query.to ? new Date(dateStart(query.to).getTime() + 86_400_000) : null;
  return await sql`
    select t.*, q.ltp as quote_ltp, q.market_at as quote_market_at, q.received_at as quote_received_at,
      q.provider as quote_provider, q.delayed as quote_delayed
    from trades t left join latest_quotes q on q.symbol = t.symbol
    where t.account_id = ${accountId}
      and (${query.status ?? null}::text is null or t.status::text = ${query.status ?? null})
      and (${query.symbol ?? null}::text is null or t.symbol = ${query.symbol ?? null})
      and (${query.tag ?? null}::text is null or t.setup_tag = ${query.tag ?? null})
      and (${query.exit_reason ?? null}::text is null or t.exit_reason::text = ${query.exit_reason ?? null})
      and (${start}::timestamptz is null or coalesce(t.exit_at,t.created_at) >= ${start})
      and (${end}::timestamptz is null or coalesce(t.exit_at,t.created_at) < ${end})
    order by t.created_at desc limit 10000`;
}

async function notifyExit(
  db: Db,
  t: Row,
  price: string,
  pnl: string,
  inferred = false,
  quoteAt?: Date,
) {
  const payload = {
    symbol: t.symbol,
    qty: t.qty,
    price,
    pnl,
    reason: 'MANUAL',
    inferred,
    ...(quoteAt ? { sourceTimestamp: new Date(quoteAt).toISOString() } : {}),
    processedAt: new Date().toISOString(),
  };
  await event(
    db,
    t.account_id,
    t.id,
    'EXITED',
    price,
    payload,
    quoteAt ? new Date(quoteAt) : new Date(),
  );
  await db`insert into outbox (account_id,trade_id,kind,payload,dedupe_key)
    values (${t.account_id},${t.id},'EXIT',${db.json(payload)},${`exit:${t.id}`}) on conflict (dedupe_key) do nothing`;
}

export async function registerTrading(app: FastifyInstance) {
  app.get('/api/account', async (request) => accountObject(auth(request).accountId));
  app.patch('/api/account/settings', async (request) => {
    const body = parse(
      z
        .object({
          startingCapital: numeric.optional(),
          slippageBps: z.number().int().min(0).max(100).optional(),
          limitValidityDays: z.number().int().min(1).max(30).optional(),
        })
        .strict(),
      request.body,
    );
    const accountId = auth(request).accountId;
    await sql.begin(async (db) => {
      const [account] = await db`select * from accounts where id = ${accountId} for update`;
      if (body.startingCapital !== undefined) {
        if (D(body.startingCapital).lt(1000) || D(body.startingCapital).gt(1_000_000_000))
          bad('Starting capital must be between ₹1,000 and ₹100 crore.');
        const [count] =
          await db`select count(*)::int as n from trades where account_id = ${accountId}`;
        if (count.n)
          throw new ApiError(
            409,
            'CAPITAL_LOCKED',
            'Reset your portfolio before changing starting capital.',
          );
        await db`delete from equity_snapshots where account_id = ${accountId}`;
        await db`update accounts set reset_at=now() where id=${accountId}`;
      }
      await db`update accounts set starting_capital = ${body.startingCapital === undefined ? account.starting_capital : money(body.startingCapital)},
        slippage_bps = ${body.slippageBps ?? account.slippage_bps},
        limit_validity_days = ${body.limitValidityDays ?? account.limit_validity_days} where id = ${accountId}`;
    });
    return accountObject(accountId);
  });
  app.post('/api/account/reset', async (request) => {
    parse(z.object({ confirm: z.literal('RESET') }).strict(), request.body);
    const accountId = auth(request).accountId;
    await sql.begin(async (db) => {
      await db`select id from accounts where id = ${accountId} for update`;
      await db`delete from outbox where account_id = ${accountId}`;
      await db`delete from trade_events where account_id = ${accountId}`;
      await db`delete from trades where account_id = ${accountId}`;
      await db`delete from equity_snapshots where account_id = ${accountId}`;
      await db`update accounts set generation = generation + 1,reset_at=now() where id = ${accountId}`;
    });
    return accountObject(accountId);
  });

  app.get('/api/market', async () => ({
    ...(await marketState()),
    provider: 'yahoo',
    delayed: true,
  }));
  app.get('/api/instruments', async (request) => {
    const q = parse(z.object({ q: z.string().max(80).default('') }), request.query).q.trim();
    const rows =
      await sql`select i.*,q.ltp as quote_ltp,q.market_at as quote_market_at,q.received_at as quote_received_at,
      q.provider as quote_provider,q.delayed as quote_delayed from instruments i
      left join latest_quotes q on q.symbol = i.symbol
      where i.active = true and (i.symbol ilike ${`${q.replace(/[%_\\]/g, '\\$&')}%`} or i.name ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`})
      order by case when i.symbol = ${q.toUpperCase()} then 0 else 1 end,i.symbol limit 25`;
    await requestQuotes(rows.map((r) => r.symbol));
    return {
      instruments: rows.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        tickSize: String(r.tick_size),
        quote: quoteObject(r, true),
      })),
    };
  });
  app.get('/api/quotes/:symbol', async (request) => {
    const symbol = params(request).symbol.toUpperCase();
    const [instrument] =
      await sql`select symbol from instruments where symbol = ${symbol} and active = true`;
    if (!instrument) throw new ApiError(404, 'SYMBOL_NOT_FOUND', 'Choose a supported NSE equity.');
    await requestQuotes([symbol]);
    const [q] = await sql`select * from latest_quotes where symbol = ${symbol}`;
    if (!q)
      throw new ApiError(503, 'QUOTE_PENDING', 'Requesting a price. Please try again in a moment.');
    return { symbol, ...quoteObject(q) };
  });

  // Register CSV before the id route so exports cannot be mistaken for a trade ID.
  app.get('/api/trades/export.csv', async (request, reply) => {
    const rows = await selectTrades(auth(request).accountId, {
      ...filters(request.query),
      status: 'CLOSED',
    });
    const cell = (value: unknown, untrusted = false) => {
      let s = String(value ?? '');
      if (untrusted && /^[=+\-@\t\r\n]/.test(s.trimStart())) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = [
      'symbol',
      'qty',
      'entry_price',
      'entry_at',
      'exit_price',
      'exit_at',
      'exit_reason',
      'charges',
      'gross_pnl',
      'net_pnl',
      'setup_tag',
      'thesis',
      'review',
      'inferred',
    ];
    const csv = [
      header.join(','),
      ...rows.map((r) =>
        header
          .map((key) =>
            cell(
              r[key] instanceof Date ? r[key].toISOString() : r[key],
              ['setup_tag', 'thesis', 'review', 'symbol'].includes(key),
            ),
          )
          .join(','),
      ),
    ].join('\r\n');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="paperlane-journal.csv"')
      .send(csv);
  });
  app.get('/api/trades', async (request) => ({
    trades: (await selectTrades(auth(request).accountId, filters(request.query))).map(tradeObject),
  }));
  app.get('/api/trades/:id', async (request) => {
    const accountId = auth(request).accountId;
    const t = await findTrade(accountId, params(request).id);
    const events =
      await sql`select * from trade_events where trade_id = ${t.id} and account_id = ${accountId} order by effective_at,id`;
    return {
      trade: tradeObject(t),
      events: events.map((e) => ({
        id: String(e.id),
        type: e.type,
        price: e.price == null ? null : String(e.price),
        payload: e.payload,
        effectiveAt: new Date(e.effective_at).toISOString(),
        createdAt: new Date(e.created_at).toISOString(),
      })),
    };
  });

  app.post('/api/trades', async (request, reply) => {
    const body = parse(
      z
        .object({
          symbol: z
            .string()
            .min(1)
            .max(30)
            .transform((v) => v.toUpperCase()),
          qty: z.number().int().min(1).max(10_000_000).optional(),
          amount: numeric.optional(),
          entryType: z.enum(['MARKET', 'LIMIT']),
          limitPrice: numeric.optional(),
          targetPrice: numeric,
          stopPrice: numeric,
          setupTag: z.string().trim().max(80).default(''),
          thesis: z.string().max(5000).default(''),
        })
        .strict(),
      request.body,
    );
    if ((body.qty === undefined) === (body.amount === undefined))
      bad('Enter either a quantity or an investment amount.');
    if (body.entryType === 'LIMIT' && body.limitPrice === undefined) bad('Enter a limit price.');
    const accountId = auth(request).accountId;
    const keyHeader = request.headers['idempotency-key'];
    const key = typeof keyHeader === 'string' ? keyHeader : null;
    if (key && (key.length < 8 || key.length > 128))
      bad('Use an idempotency key of 8–128 characters.');
    const id = await sql.begin(async (db) => {
      const [account] = await db`select * from accounts where id = ${accountId} for update`;
      if (key) {
        const [existing] =
          await db`select id from trades where account_id = ${accountId} and idempotency_key = ${key}`;
        if (existing) return existing.id;
      }
      const [instrument] =
        await db`select * from instruments where symbol = ${body.symbol} and active = true`;
      if (!instrument) bad('Choose a supported NSE equity.');
      const [q] = await db`select * from latest_quotes where symbol = ${body.symbol}`;
      const session = await marketState(new Date(), db);
      if (body.entryType === 'MARKET' && !usableQuote(q, session, true))
        throw new ApiError(
          503,
          'PRICE_UNAVAILABLE',
          'A usable price is needed to reserve cash. Wait for the price engine and try again.',
        );
      if (session.open && !usableQuote(q, session))
        throw new ApiError(
          503,
          'PRICE_UNAVAILABLE',
          'Wait for a usable session price before placing the order.',
        );
      const requestedMarketAt = session.open ? new Date(q.market_at) : new Date();
      const tick = D(instrument.tick_size);
      const entry =
        body.entryType === 'LIMIT'
          ? validatePrice(body.limitPrice, 'Limit price', tick)
          : D(q.ltp)
              .times(D(1).plus(D(account.slippage_bps).div(10000)))
              .div(tick)
              .ceil()
              .times(tick);
      const target = validatePrice(body.targetPrice, 'Target', tick),
        stop = validatePrice(body.stopPrice, 'Stop loss', tick);
      validateBracket(entry, stop, target);
      const qty = body.qty ?? D(body.amount!).div(entry).floor().toNumber();
      if (qty < 1 || qty > 10_000_000)
        bad('The amount must cover at least one share, up to 1 crore shares.');
      const reservation = entry
        .times(qty)
        .times(
          body.entryType === 'MARKET' ? D(1).plus(D(account.reservation_buffer_bps).div(10000)) : 1,
        )
        .toDecimalPlaces(2, 0);
      const balance = await accountBalance(accountId, db);
      if (reservation.gt(balance.available))
        throw new ApiError(
          409,
          'INSUFFICIENT_CASH',
          'Not enough available cash, including the price buffer.',
        );
      const id = randomUUID();
      const expiry =
        body.entryType === 'LIMIT'
          ? await limitExpiry(new Date(), account.limit_validity_days, db)
          : null;
      await db`insert into trades (id,account_id,symbol,qty,entry_type,limit_price,target_price,stop_price,reserved_amount,
        setup_tag,thesis,expires_at,idempotency_key,generation,requested_market_at)
        values (${id},${accountId},${body.symbol},${qty},${body.entryType},${body.entryType === 'LIMIT' ? String(entry) : null},
        ${String(target)},${String(stop)},${reservation.toFixed(2)},${body.setupTag},${body.thesis},${expiry},${key},${account.generation},${requestedMarketAt})`;
      await event(
        db,
        accountId,
        id,
        'CREATED',
        String(entry),
        {
          entryType: body.entryType,
          qty,
          targetPrice: String(target),
          stopPrice: String(stop),
          referencePrice: String(entry),
          reservationBufferBps: account.reservation_buffer_bps,
          sourceTimestamp: requestedMarketAt.toISOString(),
        },
        requestedMarketAt,
      );
      return id;
    });
    await requestQuotes([body.symbol]);
    return reply.code(202).send({ trade: tradeObject(await findTrade(accountId, String(id))) });
  });

  app.patch('/api/trades/:id', async (request) => {
    const body = parse(
      z
        .object({
          targetPrice: numeric.optional(),
          stopPrice: numeric.optional(),
          setupTag: z.string().trim().max(80).optional(),
          thesis: z.string().max(5000).optional(),
          review: z.string().max(10000).optional(),
        })
        .strict(),
      request.body,
    );
    const accountId = auth(request).accountId,
      id = params(request).id;
    await sql.begin(async (db) => {
      const { trade: t } = await lockedTrade(db, accountId, id);
      const bracket = body.targetPrice !== undefined || body.stopPrice !== undefined;
      if (bracket && t.status !== 'OPEN')
        throw new ApiError(
          409,
          'TRADE_NOT_OPEN',
          'Target and stop can only be changed on an open trade.',
        );
      if (bracket && t.recovery_paused)
        throw new ApiError(
          409,
          'RECONCILIATION_REQUIRED',
          'Review the missing-history interval before changing execution levels.',
        );
      let effectiveAt = new Date();
      if (bracket) {
        const [quote] = await db`select * from latest_quotes where symbol=${t.symbol}`;
        const session = await marketState(new Date(), db);
        if (session.open) {
          if (!usableQuote(quote, session) || new Date(quote.market_at) < new Date(t.entry_at))
            throw new ApiError(
              503,
              'PRICE_UNAVAILABLE',
              'A usable session price is needed before changing execution levels.',
            );
          effectiveAt = new Date(quote.market_at);
        }
      }
      const [instrument] = await db`select tick_size from instruments where symbol = ${t.symbol}`;
      const target =
        body.targetPrice === undefined
          ? D(t.target_price)
          : validatePrice(body.targetPrice, 'Target', instrument.tick_size);
      const stop =
        body.stopPrice === undefined
          ? D(t.stop_price)
          : validatePrice(body.stopPrice, 'Stop loss', instrument.tick_size);
      if (!stop.lt(target)) bad('Stop loss must stay below the target.');
      await db`update trades set target_price=${String(target)},stop_price=${String(stop)},setup_tag=${body.setupTag ?? t.setup_tag},
        thesis=${body.thesis ?? t.thesis},review=${body.review ?? t.review},updated_at=now() where id=${id} and account_id=${accountId}`;
      await event(
        db,
        accountId,
        id,
        'MODIFIED',
        null,
        {
          old: {
            targetPrice: String(t.target_price),
            stopPrice: String(t.stop_price),
            setupTag: t.setup_tag,
            thesis: t.thesis,
            review: t.review,
          },
          new: {
            targetPrice: String(target),
            stopPrice: String(stop),
            setupTag: body.setupTag ?? t.setup_tag,
            thesis: body.thesis ?? t.thesis,
            review: body.review ?? t.review,
          },
          fields: Object.keys(body),
          targetPrice: String(target),
          stopPrice: String(stop),
          sourceTimestamp: effectiveAt.toISOString(),
        },
        effectiveAt,
      );
    });
    return { trade: tradeObject(await findTrade(accountId, id)) };
  });

  app.post('/api/trades/:id/cancel', async (request) => {
    const accountId = auth(request).accountId,
      id = params(request).id;
    await sql.begin(async (db) => {
      const { trade: t } = await lockedTrade(db, accountId, id);
      if (t.status !== 'PENDING')
        throw new ApiError(409, 'TRADE_NOT_PENDING', 'Only a pending order can be cancelled.');
      await db`update trades set status='CANCELLED',reserved_amount=0,updated_at=now(),rejection_reason='Cancelled by user' where id=${id} and account_id=${accountId}`;
      await event(db, accountId, id, 'CANCELLED', null, { reason: 'Cancelled by user' });
    });
    return { trade: tradeObject(await findTrade(accountId, id)) };
  });

  app.post('/api/trades/:id/exit', async (request) => {
    const accountId = auth(request).accountId,
      id = params(request).id;
    await sql.begin(async (db) => {
      const { trade: t, account } = await lockedTrade(db, accountId, id);
      if (t.status !== 'OPEN')
        throw new ApiError(409, 'TRADE_NOT_OPEN', 'Only an open trade can be exited.');
      if (t.recovery_paused)
        throw new ApiError(
          409,
          'RECONCILIATION_REQUIRED',
          'Review the missing-history interval and explicitly reconcile before closing this trade.',
        );
      const session = await marketState(new Date(), db);
      if (!session.open)
        throw new ApiError(
          409,
          'MARKET_CLOSED',
          'Manual exits are available during the market session.',
        );
      const [q] = await db`select * from latest_quotes where symbol=${t.symbol}`;
      if (!usableQuote(q, session))
        throw new ApiError(
          503,
          'PRICE_UNAVAILABLE',
          'Wait for a usable session price before exiting.',
        );
      if (new Date(q.market_at) < new Date(t.entry_at))
        throw new ApiError(
          503,
          'PRICE_UNAVAILABLE',
          'Wait for a quote newer than the entry before exiting.',
        );
      const [instrument] = await db`select tick_size from instruments where symbol=${t.symbol}`;
      const tick = D(instrument.tick_size);
      const price = Decimal.max(
        tick,
        D(q.ltp)
          .times(D(1).minus(D(t.slippage_bps ?? account.slippage_bps).div(10000)))
          .div(tick)
          .floor()
          .times(tick),
      );
      const pnl = price.minus(t.entry_price).times(t.qty).minus(t.charges);
      await db`update trades set status='CLOSED',exit_price=${String(price)},exit_at=${q.market_at},exit_reason='MANUAL',
        gross_pnl=${money(price.minus(t.entry_price).times(t.qty))},net_pnl=${money(pnl)},reserved_amount=0,
        recovery_paused=false,recovery_message=null,updated_at=now() where id=${id} and account_id=${accountId}`;
      await notifyExit(db, t, String(price), money(pnl), false, q.market_at);
    });
    return { trade: tradeObject(await findTrade(accountId, id)) };
  });

  app.post('/api/trades/:id/reconcile', async (request) => {
    const body = parse(
      z
        .object({
          confirm: z.literal('RECONCILE'),
          action: z.enum(['resume', 'close']),
          exitPrice: numeric.optional(),
        })
        .strict(),
      request.body,
    );
    const accountId = auth(request).accountId,
      id = params(request).id;
    await sql.begin(async (db) => {
      const { trade: t } = await lockedTrade(db, accountId, id);
      if (!t.recovery_paused || !['OPEN', 'PENDING'].includes(t.status))
        throw new ApiError(409, 'NOT_PAUSED', 'This trade does not need reconciliation.');
      if (body.action === 'close') {
        if (t.status !== 'OPEN') bad('Pending orders must be cancelled or resumed.');
        if (body.exitPrice === undefined) bad('Enter your reconciled exit price.');
        const [instrument] = await db`select tick_size from instruments where symbol=${t.symbol}`;
        const price = validatePrice(body.exitPrice, 'Exit price', instrument.tick_size),
          gross = price.minus(t.entry_price).times(t.qty),
          pnl = gross.minus(t.charges);
        await db`update trades set status='CLOSED',exit_price=${String(price)},exit_at=now(),exit_reason='MANUAL',gross_pnl=${money(gross)},net_pnl=${money(pnl)},
          inferred=true,recovery_paused=false,recovery_message=null,reserved_amount=0,updated_at=now() where id=${id} and account_id=${accountId}`;
        await notifyExit(db, t, String(price), money(pnl), true);
      } else {
        const session = await marketState(new Date(), db);
        const [quote] = await db`select * from latest_quotes where symbol=${t.symbol}`;
        if (session.open && !usableQuote(quote, session))
          throw new ApiError(
            503,
            'PRICE_UNAVAILABLE',
            'Wait for a usable session price before resuming automation.',
          );
        const checkpoint = session.open ? new Date(quote.market_at) : new Date();
        await db`update trades set recovery_paused=false,recovery_message=null,last_candle_at=date_trunc('minute',${checkpoint}::timestamptz),last_checked_at=${checkpoint},updated_at=now()
          where id=${id} and account_id=${accountId}`;
      }
      await event(
        db,
        accountId,
        id,
        'RECONCILED',
        body.exitPrice === undefined ? null : String(body.exitPrice),
        {
          action: body.action,
          previousMessage: t.recovery_message,
          acknowledgedMissingHistory: true,
        },
      );
    });
    return { trade: tradeObject(await findTrade(accountId, id)) };
  });
}
