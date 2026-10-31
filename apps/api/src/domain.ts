import { Decimal } from 'decimal.js';
export { Decimal };
import { sql } from '@paper/db';

export type Row = Record<string, any>;
// Both postgres.Sql and postgres.TransactionSql expose the same tagged-query API.
export type Db = any;
export const D = (value: Decimal.Value | null | undefined) => new Decimal(value ?? 0);
export const money = (value: Decimal.Value) => D(value).toFixed(2);
export const iso = (value: any) => (value == null ? null : new Date(value).toISOString());
export const istDate = (value = new Date()) =>
  new Date(value.getTime() + 19_800_000).toISOString().slice(0, 10);
export const dateStart = (day: string) => new Date(`${day}T00:00:00+05:30`);
export const maxQuoteDelayMs = () =>
  Math.max(60_000, Number(process.env.MAX_QUOTE_DELAY_MS ?? 1_200_000) || 1_200_000);

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function bad(message: string, code = 'VALIDATION_ERROR'): never {
  throw new ApiError(400, code, message);
}
export function missing(): never {
  throw new ApiError(404, 'NOT_FOUND', 'That trade was not found.');
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function marketState(now = new Date(), db: Db = sql) {
  const day = istDate(now);
  const [coverage] =
    await db`select year from market_calendar_years where year=${Number(day.slice(0, 4))}`;
  const [override] = await db`select * from market_sessions where date = ${day}::date`;
  const weekday = new Date(`${day}T12:00:00+05:30`).getUTCDay();
  const calendarVerified = Boolean(coverage) && !override?.review_required;
  const tradingDay =
    calendarVerified && (override ? override.is_open : weekday !== 0 && weekday !== 6);
  const opensAt = new Date(`${day}T${String(override?.open_time ?? '09:15').slice(0, 5)}:00+05:30`);
  const closesAt = new Date(
    `${day}T${String(override?.close_time ?? '15:30').slice(0, 5)}:00+05:30`,
  );
  return {
    open: tradingDay && now >= opensAt && now < closesAt,
    tradingDay,
    calendarVerified,
    sessionDate: day,
    opensAt,
    closesAt,
  };
}

export function quoteObject(row: Row | undefined, prefixed = false) {
  if (!row || (prefixed ? row.quote_ltp == null : row.ltp == null)) return null;
  return {
    ltp: String(prefixed ? row.quote_ltp : row.ltp),
    ts: iso(prefixed ? row.quote_market_at : row.market_at),
    receivedAt: iso(prefixed ? row.quote_received_at : row.received_at),
    provider: prefixed ? row.quote_provider : row.provider,
    delayed: prefixed ? row.quote_delayed : row.delayed,
  };
}

export function tradeObject(t: Row) {
  const quote = quoteObject(t, true);
  return {
    id: t.id,
    symbol: t.symbol,
    qty: t.qty,
    entryType: t.entry_type,
    limitPrice: t.limit_price == null ? null : String(t.limit_price),
    targetPrice: String(t.target_price),
    stopPrice: String(t.stop_price),
    status: t.status,
    entryPrice: t.entry_price == null ? null : String(t.entry_price),
    entryAt: iso(t.entry_at),
    exitPrice: t.exit_price == null ? null : String(t.exit_price),
    exitAt: iso(t.exit_at),
    exitReason: t.exit_reason,
    reservedAmount: String(t.reserved_amount),
    charges: String(t.charges),
    grossPnl: t.gross_pnl == null ? null : String(t.gross_pnl),
    netPnl: t.net_pnl == null ? null : String(t.net_pnl),
    initialRisk: t.initial_risk == null ? null : String(t.initial_risk),
    setupTag: t.setup_tag,
    thesis: t.thesis,
    review: t.review,
    rejectionReason: t.rejection_reason,
    inferred: t.inferred,
    gapFill: t.gap_fill,
    expiresAt: iso(t.expires_at),
    createdAt: iso(t.created_at),
    requestedMarketAt: iso(t.requested_market_at),
    updatedAt: iso(t.updated_at),
    quote,
    recoveryPaused: t.recovery_paused ?? false,
    recoveryMessage: t.recovery_message ?? null,
    unrealisedPnl:
      t.status === 'OPEN' && quote ? money(D(quote.ltp).minus(t.entry_price).times(t.qty)) : null,
  };
}

export async function accountBalance(accountId: string, db: Db = sql) {
  const [account] = await db`select * from accounts where id = ${accountId}`;
  if (!account) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in.');
  const trades = await db`
    select t.*, q.ltp as mark, q.market_at as mark_at from trades t
    left join latest_quotes q on q.symbol = t.symbol where t.account_id = ${accountId}`;
  let realised = D(0),
    invested = D(0),
    entryCharges = D(0),
    reserved = D(0),
    current = D(0);
  let hasStaleMarks = false;
  for (const t of trades) {
    if (t.status === 'CLOSED') realised = realised.plus(t.net_pnl ?? 0);
    if (t.status === 'PENDING') reserved = reserved.plus(t.reserved_amount);
    if (t.status === 'OPEN') {
      invested = invested.plus(D(t.entry_price).times(t.qty));
      entryCharges = entryCharges.plus(t.charges);
      current = current.plus(D(t.mark ?? t.entry_price).times(t.qty));
      if (!t.mark || Date.now() - new Date(t.mark_at).getTime() > maxQuoteDelayMs())
        hasStaleMarks = true;
    }
  }
  const cash = D(account.starting_capital).plus(realised).minus(invested).minus(entryCharges);
  return {
    account,
    cash,
    invested,
    reserved,
    current,
    realised,
    entryCharges,
    hasStaleMarks,
    hasRecoveryIssues: trades.some(
      (t: Row) => t.recovery_paused && ['OPEN', 'PENDING'].includes(t.status),
    ),
    available: cash.minus(reserved),
    equity: cash.plus(current),
    unrealised: current.minus(invested).minus(entryCharges),
  };
}

export async function accountObject(accountId: string) {
  const b = await accountBalance(accountId);
  const [engine] = await sql`select * from engine_state where id = 1`;
  const session = await marketState();
  const stale = !engine || Date.now() - new Date(engine.heartbeat_at).getTime() > 90_000;
  const sharedRecovery = engine?.status === 'RECOVERY_REQUIRED';
  const status = !session.calendarVerified
    ? 'CALENDAR_REQUIRED'
    : stale
      ? 'OFFLINE'
      : b.hasRecoveryIssues
        ? 'RECOVERY_REQUIRED'
        : sharedRecovery
          ? b.hasStaleMarks
            ? 'STALE'
            : session.open
              ? 'HEALTHY'
              : 'IDLE'
          : engine.status;
  const message = !session.calendarVerified
    ? `Review/import the NSE calendar and session times for ${session.sessionDate} before automated trading can start.`
    : stale
      ? 'The price engine is not responding.'
      : b.hasRecoveryIssues
        ? 'Review your paused trades to reconcile missing history.'
        : sharedRecovery
          ? session.open
            ? 'Delayed data simulation is active.'
            : 'Market is closed; pending entries wait for the next session.'
          : engine.message;
  return {
    startingCapital: money(b.account.starting_capital),
    cashBalance: money(b.cash),
    reservedCash: money(b.reserved),
    availableCash: money(b.available),
    investedValue: money(b.invested),
    currentValue: money(b.current),
    unrealisedPnl: money(b.unrealised),
    realisedPnl: money(b.realised),
    equity: money(b.equity),
    slippageBps: b.account.slippage_bps,
    limitValidityDays: b.account.limit_validity_days,
    reservationBufferBps: b.account.reservation_buffer_bps,
    hasStaleMarks: b.hasStaleMarks,
    feed: {
      status,
      provider: engine?.provider ?? 'yahoo',
      delayed: true,
      lastHeartbeatAt: iso(engine?.heartbeat_at),
      message,
    },
    marketOpen: session.open,
    calendarVerified: session.calendarVerified,
  };
}

export async function requestQuotes(symbols: string[]) {
  if (!symbols.length) return;
  await sql`
    insert into quote_requests (symbol, requested_at, expires_at)
    select unnest(${symbols}::text[]), now(), now() + interval '10 minutes'
    on conflict (symbol) do update set requested_at = now(), expires_at = now() + interval '10 minutes'`;
}

export async function findTrade(accountId: string, id: string, db: Db = sql) {
  if (!uuidPattern.test(id)) missing();
  const [t] = await db`
    select t.*, q.ltp as quote_ltp, q.market_at as quote_market_at, q.received_at as quote_received_at,
      q.provider as quote_provider, q.delayed as quote_delayed
    from trades t left join latest_quotes q on q.symbol = t.symbol
    where t.id = ${id} and t.account_id = ${accountId}`;
  if (!t) missing();
  return t as Row;
}

export async function lockedTrade(db: Db, accountId: string, id: string) {
  if (!uuidPattern.test(id)) missing();
  const [account] = await db`select * from accounts where id = ${accountId} for update`;
  const [trade] =
    await db`select * from trades where id = ${id} and account_id = ${accountId} for update`;
  if (!trade) missing();
  return { account, trade };
}

export async function event(
  db: Db,
  accountId: string,
  tradeId: string,
  type: string,
  price: string | null,
  payload: Row = {},
  effectiveAt = new Date(),
) {
  await db`insert into trade_events (account_id, trade_id, type, price, payload, effective_at)
    values (${accountId},${tradeId},${type},${price},${db.json(payload)},${effectiveAt})`;
}

export function usableQuote(
  quote: Row | undefined,
  session: Awaited<ReturnType<typeof marketState>>,
  allowClosed = false,
) {
  if (!quote || D(quote.ltp).lte(0)) return false;
  const quoteAge = Date.now() - new Date(quote.market_at).getTime();
  if (!session.open && allowClosed) return quoteAge >= -60_000 && quoteAge <= 7 * 86_400_000;
  return (
    session.open &&
    Date.now() - new Date(quote.received_at).getTime() <= 90_000 &&
    quoteAge >= -60_000 &&
    quoteAge <= (quote.delayed ? maxQuoteDelayMs() : 60_000) &&
    new Date(quote.market_at) >= session.opensAt &&
    new Date(quote.market_at) < session.closesAt &&
    istDate(new Date(quote.market_at)) === session.sessionDate
  );
}

export function validatePrice(value: unknown, name: string, tick: unknown = '0.05') {
  let d: Decimal;
  try {
    d = new Decimal(String(value));
  } catch {
    bad(`${name} must be a valid price.`);
  }
  if (!d!.isFinite() || d!.lte(0) || d!.gt(100_000_000))
    bad(`${name} must be a positive price below ₹10 crore.`);
  if (!d!.mod(String(tick)).eq(0)) bad(`${name} must use the instrument's ₹${tick} tick size.`);
  return d!;
}

export function validateBracket(entry: Decimal, stop: Decimal, target: Decimal) {
  if (!stop.lt(entry) || !target.gt(entry))
    bad('Set the stop below entry and the target above entry.');
  if (entry.minus(stop).div(entry).gt(0.5) || target.minus(entry).div(entry).gt(0.5))
    bad('Target and stop must stay within 50% of entry.');
}

export async function limitExpiry(now: Date, validity: number, db: Db = sql) {
  let candidate = new Date(now);
  let counted = 0;
  for (let i = 0; i < 370; i++) {
    const state = await marketState(candidate, db);
    if (!state.calendarVerified)
      throw new ApiError(
        409,
        'CALENDAR_REQUIRED',
        `Review/import the NSE calendar and session times for ${state.sessionDate} before placing this limit order.`,
      );
    if (state.tradingDay && (i > 0 || now < state.opensAt)) {
      counted++;
      if (counted >= validity) return state.closesAt;
    }
    candidate = new Date(dateStart(state.sessionDate).getTime() + 86_400_000 + 6 * 60 * 60_000);
  }
  throw new ApiError(503, 'CALENDAR_UNAVAILABLE', 'Could not determine order expiry.');
}
