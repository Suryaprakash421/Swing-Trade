import { sql } from '@paper/db';
import {
  Decimal,
  calculateBalances,
  evaluateCandle,
  evaluateTick,
  istDate,
  marketSession,
  money,
  validateBracket,
} from '@paper/core';
import type { CoreTrade, Decision, EvaluationOptions, SessionOverride } from '@paper/core';
import type { TransactionSql } from 'postgres';
import type { MarketCandle, PriceTick } from './provider.js';

type Tx = TransactionSql<Record<string, never>>;
export interface TradeRow {
  id: string;
  account_id: string;
  symbol: string;
  qty: number;
  entry_type: 'MARKET' | 'LIMIT';
  limit_price: string | null;
  target_price: string;
  stop_price: string;
  status: string;
  entry_price: string | null;
  entry_at: Date | null;
  exit_price: string | null;
  reserved_amount: string;
  charges: string;
  net_pnl: string | null;
  initial_risk: string | null;
  slippage_bps: number | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_checked_at: Date | null;
  last_candle_at: Date | null;
  generation: number;
  recovery_paused: boolean;
  recovery_message: string | null;
  requested_market_at: Date | null;
}
interface AccountRow {
  id: string;
  starting_capital: string;
  slippage_bps: number;
  generation: number;
  reset_at: Date;
  created_at: Date;
}
let processingGuard: (() => void) | undefined;
export function setProcessingGuard(guard?: () => void) {
  processingGuard = guard;
}

export const coreTrade = (trade: TradeRow): CoreTrade => ({
  status: trade.status,
  entryType: trade.entry_type,
  qty: trade.qty,
  limitPrice: trade.limit_price,
  targetPrice: trade.target_price,
  stopPrice: trade.stop_price,
  entryPrice: trade.entry_price,
  entryAt: trade.entry_at,
});

export async function loadCalendar(): Promise<SessionOverride[]> {
  return await sql<
    SessionOverride[]
  >`select date::text, is_open, open_time, close_time,review_required from market_sessions`;
}

export async function persistQuote(tick: PriceTick): Promise<void> {
  if (!new Decimal(tick.ltp).isFinite() || new Decimal(tick.ltp).lte(0)) return;
  await sql`
    insert into latest_quotes(symbol,ltp,market_at,received_at,provider,delayed)
    values(${tick.symbol},${tick.ltp},${tick.ts},${tick.receivedAt},${tick.provider},${tick.delayed})
    on conflict(symbol) do update set ltp=excluded.ltp, market_at=excluded.market_at,
      received_at=excluded.received_at,provider=excluded.provider,delayed=excluded.delayed
    where latest_quotes.market_at <= excluded.market_at or latest_quotes.provider <> excluded.provider
  `;
}

async function event(
  tx: Tx,
  trade: TradeRow,
  type: string,
  price: string | null,
  at: Date,
  payload: Record<string, unknown>,
) {
  await tx`insert into trade_events(trade_id,account_id,type,price,payload,effective_at)
    values(${trade.id},${trade.account_id},${type},${price},${JSON.stringify(payload)}::jsonb,${at})`;
  await tx`select pg_notify('trade_events', ${trade.account_id})`;
}

async function queueAlert(tx: Tx, trade: TradeRow, kind: string, payload: Record<string, unknown>) {
  await tx`insert into outbox(account_id,trade_id,kind,payload,dedupe_key)
    values(${trade.account_id},${trade.id},${kind},${JSON.stringify(payload)}::jsonb,${`${trade.id}:${kind}`})
    on conflict(dedupe_key) do nothing`;
}

async function cancelLocked(
  tx: Tx,
  trade: TradeRow,
  reason: string,
  at: Date,
  status: 'CANCELLED' | 'EXPIRED' = 'CANCELLED',
) {
  await tx`update trades set status=${status},reserved_amount=0,rejection_reason=${reason},updated_at=now()
    where id=${trade.id} and status='PENDING'`;
  await event(tx, trade, status, null, at, { reason });
}

async function pauseLocked(tx: Tx, trade: TradeRow, message: string, at: Date) {
  if (trade.recovery_paused) return;
  await tx`update trades set recovery_paused=true,recovery_message=${message},updated_at=now() where id=${trade.id}`;
  await event(tx, trade, 'RECOVERY_REQUIRED', null, at, { message });
}

async function applyDecision(
  tx: Tx,
  account: AccountRow,
  trade: TradeRow,
  decision: Decision,
  tickSize: string,
  provenance: Record<string, unknown> = {},
): Promise<TradeRow | null> {
  if (decision.type === 'FILL') {
    const bracket = validateBracket(decision.price, trade.stop_price, trade.target_price, tickSize);
    if (!bracket.valid) {
      await cancelLocked(tx, trade, `Fill rejected: ${bracket.errors.join('; ')}`, decision.at);
      return null;
    }
    const rows =
      await tx`select symbol,status,qty,entry_price,net_pnl,charges,reserved_amount from trades where account_id=${account.id}`;
    const balances = calculateBalances(
      account.starting_capital,
      rows.map((row) => ({
        symbol: row.symbol as string,
        status: row.status as string,
        qty: row.qty as number,
        entryPrice: row.entry_price as string | null,
        netPnl: row.net_pnl as string | null,
        charges: row.charges as string,
        reservedAmount: row.reserved_amount as string,
      })),
    );
    const available = new Decimal(balances.availableCash).plus(trade.reserved_amount);
    const cost = new Decimal(decision.price).mul(trade.qty);
    if (cost.gt(available)) {
      await cancelLocked(
        tx,
        trade,
        'Insufficient available cash at fill; quantity was not resized',
        decision.at,
      );
      return null;
    }
    const initialRisk = money(new Decimal(decision.price).minus(trade.stop_price).mul(trade.qty));
    const [filled] = await tx<
      TradeRow[]
    >`update trades set status='OPEN',entry_price=${decision.price},entry_at=${decision.at},
      reserved_amount=0,charges=0,initial_risk=${initialRisk},slippage_bps=${account.slippage_bps},
      inferred=${decision.inferred},gap_fill=${decision.gapFill},last_checked_at=${decision.at},updated_at=now()
      where id=${trade.id} and status='PENDING' returning *`;
    if (!filled) return null;
    await event(tx, trade, 'FILLED', decision.price, decision.at, {
      symbol: trade.symbol,
      qty: trade.qty,
      targetPrice: trade.target_price,
      stopPrice: trade.stop_price,
      slippageBps: account.slippage_bps,
      inferred: decision.inferred,
      gapFill: decision.gapFill,
      ...provenance,
    });
    await queueAlert(tx, trade, 'FILL', {
      symbol: trade.symbol,
      qty: trade.qty,
      price: decision.price,
      inferred: decision.inferred,
    });
    return filled;
  }
  if (trade.status !== 'OPEN' || !trade.entry_price || !decision.reason) return null;
  const pnl = money(new Decimal(decision.price).minus(trade.entry_price).mul(trade.qty));
  await tx`update trades set status='CLOSED',exit_price=${decision.price},exit_at=${decision.at},exit_reason=${decision.reason},
    gross_pnl=${pnl},net_pnl=${pnl},charges=0,reserved_amount=0,inferred=(inferred or ${decision.inferred}),
    gap_fill=(gap_fill or ${decision.gapFill}),last_checked_at=${decision.at},updated_at=now()
    where id=${trade.id} and status='OPEN'`;
  await event(tx, trade, 'EXITED', decision.price, decision.at, {
    symbol: trade.symbol,
    qty: trade.qty,
    price: decision.price,
    pnl,
    reason: decision.reason,
    inferred: decision.inferred,
    gapFill: decision.gapFill,
    ...provenance,
  });
  await queueAlert(tx, trade, 'EXIT', {
    symbol: trade.symbol,
    qty: trade.qty,
    price: decision.price,
    pnl,
    reason: decision.reason,
    inferred: decision.inferred,
  });
  return null;
}

async function withTrade(
  id: string,
  operation: (tx: Tx, account: AccountRow, trade: TradeRow, tickSize: string) => Promise<void>,
) {
  processingGuard?.();
  const [owner] = await sql`select account_id from trades where id=${id}`;
  if (!owner) return;
  await sql.begin(async (transaction) => {
    const tx = transaction as Tx;
    const [account] = await tx<
      AccountRow[]
    >`select * from accounts where id=${owner.account_id} for update`;
    if (!account) return;
    const [trade] = await tx<
      TradeRow[]
    >`select * from trades where id=${id} and account_id=${account.id} for update`;
    if (
      !trade ||
      trade.generation !== account.generation ||
      !['OPEN', 'PENDING'].includes(trade.status)
    )
      return;
    processingGuard?.();
    const [instrument] = await tx`select tick_size from instruments where symbol=${trade.symbol}`;
    await operation(tx, account, trade, String(instrument?.tick_size ?? '.05'));
  });
}

/** Used by recovery errors and by the engine's outage watchdog. */
export async function pauseTrade(id: string, message: string, at = new Date()) {
  await withTrade(id, async (tx, _account, trade) => {
    await pauseLocked(tx, trade, message, at);
  });
}

export interface ProcessingOptions {
  now?: Date;
  calendar?: SessionOverride[];
}

/** Store a quote and apply it once to each eligible owner's trade. */
export async function processTick(tick: PriceTick, options: ProcessingOptions = {}): Promise<void> {
  await persistQuote(tick);
  const calendar = options.calendar ?? (await loadCalendar());
  const now = options.now ?? new Date();
  const tickSession = marketSession(tick.ts, calendar);
  const nowSession = marketSession(now, calendar);
  // Never fill an order from yesterday's closing price, a pre-open value, or a future tick.
  const maxDelay = tick.delayed ? Number(process.env.MAX_QUOTE_DELAY_MS ?? 1_200_000) : 60_000;
  if (
    !tickSession.open ||
    !nowSession.tradingDay ||
    tickSession.sessionDate !== nowSession.sessionDate ||
    tick.ts > now ||
    now < nowSession.opensAt ||
    now.getTime() > nowSession.closesAt.getTime() + maxDelay
  )
    return;
  if (now.getTime() - tick.ts.getTime() > maxDelay) return;
  const candidates =
    await sql`select id from trades where symbol=${tick.symbol} and status in ('OPEN','PENDING') order by created_at,id`;
  for (const candidate of candidates) {
    await withTrade(candidate.id as string, async (tx, account, trade, tickSize) => {
      const eligibleAt =
        trade.status === 'OPEN'
          ? (trade.entry_at ?? trade.created_at)
          : (trade.requested_market_at ?? trade.created_at);
      if (
        trade.recovery_paused ||
        tick.ts < eligibleAt ||
        (trade.last_checked_at && tick.ts <= trade.last_checked_at)
      )
        return;
      if (trade.expires_at && tick.ts >= trade.expires_at && trade.status === 'PENDING') {
        await cancelLocked(tx, trade, 'Limit entry validity expired', trade.expires_at, 'EXPIRED');
        return;
      }
      const sessionOpening = tick.ts.getTime() - tickSession.opensAt.getTime() < 60_000;
      // Large overnight moves require review instead of a potentially false stop due to a split.
      if (
        trade.status === 'OPEN' &&
        trade.entry_price &&
        trade.last_checked_at &&
        istDate(trade.last_checked_at) < tickSession.sessionDate
      ) {
        const [prior] =
          await tx`select close from price_bars_1m where symbol=${trade.symbol} and ts<${tickSession.opensAt} order by ts desc limit 1`;
        const reference = String(prior?.close ?? trade.entry_price);
        if (new Decimal(tick.ltp).minus(reference).abs().div(reference).gt('.30')) {
          await pauseLocked(
            tx,
            trade,
            'Overnight price move exceeds 30%; review corporate actions or a genuine gap before resuming',
            tick.ts,
          );
          return;
        }
      }
      const levels =
        trade.status === 'OPEN' ? await historicalLevels(tx, trade, tick.ts) : coreTrade(trade);
      const decision = evaluateTick(levels, tick, {
        slippageBps: trade.slippage_bps ?? account.slippage_bps,
        tickSize,
        sessionOpen: sessionOpening,
      });
      if (decision) {
        const provenance = {
          provider: tick.provider,
          sourceAt: tick.ts.toISOString(),
          receivedAt: tick.receivedAt.toISOString(),
          delayed: tick.delayed,
        };
        const filled = await applyDecision(tx, account, trade, decision, tickSize, provenance);
        if (filled) {
          const immediate = evaluateTick(coreTrade(filled), tick, {
            slippageBps: filled.slippage_bps ?? account.slippage_bps,
            tickSize,
          });
          if (immediate) await applyDecision(tx, account, filled, immediate, tickSize, provenance);
        }
      }
      await tx`update trades set last_checked_at=greatest(coalesce(last_checked_at,${tick.ts}),${tick.ts}) where id=${trade.id}`;
    });
  }
}

async function historicalLevels(tx: Tx, trade: TradeRow, at: Date): Promise<CoreTrade> {
  const reconstructed = coreTrade(trade);
  const changes =
    await tx`select payload from trade_events where trade_id=${trade.id} and type='MODIFIED'
    and effective_at>${at} order by effective_at desc,id desc`;
  for (const change of changes) {
    const payload = change.payload as {
      old?: { targetPrice?: string; stopPrice?: string };
      oldTargetPrice?: string;
      oldStopPrice?: string;
    };
    if (payload.old?.targetPrice ?? payload.oldTargetPrice)
      reconstructed.targetPrice = (payload.old?.targetPrice ?? payload.oldTargetPrice)!;
    if (payload.old?.stopPrice ?? payload.oldStopPrice)
      reconstructed.stopPrice = (payload.old?.stopPrice ?? payload.oldStopPrice)!;
  }
  return reconstructed;
}

/** Replay in chronological order across symbols, preserving per-account affordability. */
export async function processCandles(
  candles: MarketCandle[],
  options: ProcessingOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const calendar = options.calendar ?? (await loadCalendar());
  const ordered = [...candles].sort(
    (a, b) => a.ts.getTime() - b.ts.getTime() || a.symbol.localeCompare(b.symbol),
  );
  for (const candle of ordered) {
    const end = new Date(candle.ts.getTime() + 60_000);
    if (end > now || !marketSession(candle.ts, calendar).open) continue;
    await sql`insert into price_bars_1m(symbol,ts,open,high,low,close,provider)
      values(${candle.symbol},${candle.ts},${candle.open},${candle.high},${candle.low},${candle.close},${candle.provider})
      on conflict(symbol,ts) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,provider=excluded.provider`;
    const candidates =
      await sql`select id from trades where symbol=${candle.symbol} and status in ('OPEN','PENDING')
      and coalesce(last_candle_at,'epoch'::timestamptz)<${candle.ts}
      and coalesce(requested_market_at,created_at)<${end} order by created_at,id`;
    for (const candidate of candidates) {
      await withTrade(candidate.id as string, async (tx, account, trade, tickSize) => {
        if (trade.recovery_paused || (trade.last_candle_at && trade.last_candle_at >= candle.ts))
          return;
        if (trade.status === 'OPEN' && trade.entry_at && trade.entry_at >= end) {
          await tx`update trades set last_candle_at=${candle.ts} where id=${trade.id}`;
          return;
        }
        if (
          trade.status === 'PENDING' &&
          candle.ts < (trade.requested_market_at ?? trade.created_at)
        ) {
          // A candle opening before submit cannot be used as a market entry price.
          // Leave the candle eligible after a later observed intrabar fill.
          return;
        }
        if (trade.status === 'PENDING' && trade.expires_at && candle.ts >= trade.expires_at) {
          await cancelLocked(
            tx,
            trade,
            'Limit entry validity expired',
            trade.expires_at,
            'EXPIRED',
          );
          return;
        }
        const session = marketSession(candle.ts, calendar);
        const sessionOpen = candle.ts.getTime() === session.opensAt.getTime();
        if (sessionOpen && trade.status === 'OPEN' && trade.entry_price) {
          const [prior] =
            await tx`select close from price_bars_1m where symbol=${trade.symbol} and ts<${candle.ts} order by ts desc limit 1`;
          const reference = String(prior?.close ?? trade.entry_price);
          if (new Decimal(candle.open).minus(reference).abs().div(reference).gt('.30')) {
            await pauseLocked(
              tx,
              trade,
              'Opening move exceeds 30%; review corporate actions before resuming',
              candle.ts,
            );
            return;
          }
        }
        const opts: EvaluationOptions = {
          slippageBps: trade.slippage_bps ?? account.slippage_bps,
          tickSize,
          sessionOpen,
          entryInCandle: !!trade.entry_at && trade.entry_at > candle.ts,
        };
        const historical = await historicalLevels(tx, trade, candle.ts);
        const decision = evaluateCandle(historical, candle, opts);
        if (decision) {
          const provenance = {
            provider: candle.provider,
            sourceAt: candle.ts.toISOString(),
            interval: '1m',
          };
          const filled = await applyDecision(tx, account, trade, decision, tickSize, provenance);
          if (filled) {
            const intrabarLimit =
              trade.entry_type === 'LIMIT' && new Decimal(candle.open).gt(trade.limit_price!);
            const exit = evaluateCandle(coreTrade(filled), candle, {
              ...opts,
              entryInCandle: intrabarLimit,
            });
            if (exit) await applyDecision(tx, account, filled, exit, tickSize, provenance);
          }
        }
        await tx`update trades set last_candle_at=${candle.ts},last_checked_at=greatest(coalesce(last_checked_at,${end}),${end}) where id=${trade.id}`;
      });
    }
  }
}

/** Expiry cannot race an entry, cancellation, reset or another account operation. */
export async function expirePending(now = new Date()) {
  const rows =
    await sql`select id from trades where status='PENDING' and not recovery_paused and expires_at<=${now} order by expires_at,created_at`;
  for (const row of rows)
    await withTrade(row.id as string, async (tx, _account, trade) => {
      if (trade.status === 'PENDING' && trade.expires_at && trade.expires_at <= now)
        await cancelLocked(tx, trade, 'Limit entry validity expired', trade.expires_at, 'EXPIRED');
    });
}

/** Backfill durable session-close points from effective fills and stored market marks. */
export async function captureEquity(
  now = new Date(),
  calendar?: SessionOverride[],
  reviewedYears?: Set<number>,
) {
  const sessions = calendar ?? (await loadCalendar());
  const accounts = await sql<AccountRow[]>`select * from accounts`;
  for (const account of accounts) {
    const start = new Date(`${istDate(account.reset_at ?? account.created_at)}T00:00:00+05:30`);
    const known = await sql`select date::text from equity_snapshots where account_id=${account.id}`;
    const recorded = new Set(known.map((row) => row.date as string));
    for (let day = start; day <= now; day = new Date(day.getTime() + 86400_000)) {
      const session = marketSession(day, sessions);
      if (reviewedYears && !reviewedYears.has(Number(session.sessionDate.slice(0, 4)))) continue;
      if (!session.tradingDay || session.closesAt > now || recorded.has(session.sessionDate))
        continue;
      await sql.begin(async (tx) => {
        const [locked] = await tx<
          AccountRow[]
        >`select * from accounts where id=${account.id} for update`;
        if (
          !locked ||
          locked.generation !== account.generation ||
          locked.reset_at > session.closesAt
        )
          return;
        const trades =
          await tx`select * from trades where account_id=${account.id} and entry_at<=${session.closesAt}`;
        const balancesAtClose = trades.map((trade) => ({
          symbol: trade.symbol as string,
          qty: trade.qty as number,
          status:
            trade.exit_at && new Date(trade.exit_at as Date) <= session.closesAt
              ? 'CLOSED'
              : 'OPEN',
          entryPrice: trade.entry_price as string,
          netPnl: trade.net_pnl as string | null,
          charges: trade.charges as string,
          reservedAmount: '0',
        }));
        const open = balancesAtClose.filter((trade) => trade.status === 'OPEN');
        const marks: Record<string, string> = {};
        let stale = false;
        for (const trade of open) {
          const [bar] = await tx`select close,ts from price_bars_1m where symbol=${trade.symbol}
            and ts>=${session.opensAt} and ts<${session.closesAt} order by ts desc limit 1`;
          const [quote] =
            await tx`select ltp,market_at from latest_quotes where symbol=${trade.symbol}
            and market_at>=${session.opensAt} and market_at<=${session.closesAt}`;
          const barTime = bar ? new Date(bar.ts as Date).getTime() + 60_000 : 0;
          const quoteTime = quote ? new Date(quote.market_at as Date).getTime() : 0;
          const latest = Math.max(barTime, quoteTime);
          marks[trade.symbol] =
            quoteTime > barTime ? String(quote!.ltp) : bar ? String(bar.close) : trade.entryPrice;
          if (latest < session.closesAt.getTime() - 2 * 60_000) stale = true;
        }
        const balances = calculateBalances(locked.starting_capital, balancesAtClose, marks);
        await tx`insert into equity_snapshots(account_id,date,equity,stale)
          values(${account.id},${session.sessionDate}::date,${balances.equity},${stale}) on conflict do nothing`;
      });
    }
  }
}
