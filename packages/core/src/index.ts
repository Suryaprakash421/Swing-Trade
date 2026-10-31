import { Decimal } from 'decimal.js';

// Monetary calculations never pass through native floating-point arithmetic.
Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export type MoneyInput = Decimal.Value;
export const decimal = (value: MoneyInput = 0): Decimal => new Decimal(value);
export const D = decimal;
export const money = (value: MoneyInput): string => decimal(value).toFixed(2);

export function roundToTick(
  value: MoneyInput,
  tickSize: MoneyInput = '0.05',
  direction: 'nearest' | 'up' | 'down' = 'nearest',
): string {
  const tick = decimal(tickSize);
  if (!tick.gt(0)) throw new Error('Tick size must be positive');
  const rounding =
    direction === 'up'
      ? Decimal.ROUND_CEIL
      : direction === 'down'
        ? Decimal.ROUND_FLOOR
        : Decimal.ROUND_HALF_UP;
  return decimal(value)
    .div(tick)
    .toDecimalPlaces(0, rounding)
    .mul(tick)
    .toFixed(Math.max(2, tick.decimalPlaces()));
}

export function validateBracket(
  entry: MoneyInput,
  stop: MoneyInput,
  target: MoneyInput,
  tickSize?: MoneyInput,
): { valid: boolean; errors: string[] } {
  const e = decimal(entry),
    s = decimal(stop),
    t = decimal(target);
  const errors: string[] = [];
  if (![e, s, t].every((v) => v.isFinite() && v.gt(0)))
    errors.push('Prices must be positive finite amounts');
  if (!s.lt(e) || !e.lt(t)) errors.push('Stop must be below entry and target must be above entry');
  if (s.lt(e.mul('0.5')) || t.gt(e.mul('1.5')))
    errors.push('Target and stop must be within 50% of entry');
  if (tickSize && [e, s, t].some((v) => !v.mod(tickSize).eq(0)))
    errors.push('Prices must match the instrument tick size');
  return { valid: errors.length === 0, errors };
}

export function calculateReservation(qty: number, price: MoneyInput, bufferBps = 0): string {
  if (!Number.isSafeInteger(qty) || qty < 1)
    throw new Error('Quantity must be a positive whole number');
  if (!Number.isSafeInteger(bufferBps) || bufferBps < 0)
    throw new Error('Buffer must be non-negative basis points');
  const p = decimal(price);
  if (!p.isFinite() || !p.gt(0)) throw new Error('Price must be positive');
  return p
    .mul(qty)
    .mul(decimal(1).plus(decimal(bufferBps).div(10000)))
    .toDecimalPlaces(2, Decimal.ROUND_CEIL)
    .toFixed(2);
}

export interface BalanceTrade {
  symbol: string;
  status: string;
  qty: number;
  entryPrice?: MoneyInput | null;
  netPnl?: MoneyInput | null;
  charges?: MoneyInput | null;
  reservedAmount?: MoneyInput | null;
}

export function calculateBalances(
  startingCapital: MoneyInput,
  trades: BalanceTrade[],
  quotes: Record<string, MoneyInput> = {},
) {
  let realised = decimal(0),
    invested = decimal(0),
    marks = decimal(0),
    charges = decimal(0),
    reserved = decimal(0);
  for (const trade of trades) {
    if (trade.status === 'CLOSED') realised = realised.plus(trade.netPnl ?? 0);
    if (trade.status === 'PENDING') reserved = reserved.plus(trade.reservedAmount ?? 0);
    if (trade.status === 'OPEN') {
      invested = invested.plus(decimal(trade.entryPrice ?? 0).mul(trade.qty));
      marks = marks.plus(decimal(quotes[trade.symbol] ?? trade.entryPrice ?? 0).mul(trade.qty));
      charges = charges.plus(trade.charges ?? 0);
    }
  }
  const cash = decimal(startingCapital).plus(realised).minus(invested).minus(charges);
  return {
    startingCapital: money(startingCapital),
    cashBalance: money(cash),
    reservedCash: money(reserved),
    availableCash: money(cash.minus(reserved)),
    investedValue: money(invested),
    currentValue: money(marks),
    unrealisedPnl: money(marks.minus(invested).minus(charges)),
    realisedPnl: money(realised),
    equity: money(cash.plus(marks)),
  };
}

export interface CoreTrade {
  status: string;
  entryType: 'MARKET' | 'LIMIT';
  qty: number;
  limitPrice?: MoneyInput | null;
  targetPrice: MoneyInput;
  stopPrice: MoneyInput;
  entryPrice?: MoneyInput | null;
  entryAt?: Date | null;
}
export interface Tick {
  ltp: MoneyInput;
  ts: Date;
}
export interface Candle {
  ts: Date;
  open: MoneyInput;
  high: MoneyInput;
  low: MoneyInput;
  close: MoneyInput;
}
export interface EvaluationOptions {
  slippageBps?: number;
  tickSize?: MoneyInput;
  /** Whether this is the first true session opening price, not merely the first received price. */
  sessionOpen?: boolean;
  /** A limit filled inside this candle: a pre-entry high cannot be used as a target. */
  entryInCandle?: boolean;
}
export interface Decision {
  type: 'FILL' | 'EXIT';
  price: string;
  reason?: 'TARGET' | 'STOP';
  at: Date;
  gapFill: boolean;
  inferred: boolean;
}

function slipped(value: MoneyInput, side: 'BUY' | 'SELL', opts: EvaluationOptions): string {
  const bps = decimal(opts.slippageBps ?? 5).div(10000);
  const tick = decimal(opts.tickSize ?? '.05');
  // A one-tick penny stock must not round an adverse sell to a zero price.
  const slippedPrice = Decimal.max(
    tick,
    decimal(value).mul(side === 'BUY' ? decimal(1).plus(bps) : decimal(1).minus(bps)),
  );
  return roundToTick(slippedPrice, tick, side === 'BUY' ? 'up' : 'down');
}

/** Observed prices use conservative stop fills; limits never pay above their limit. */
export function evaluateTick(
  trade: CoreTrade,
  tick: Tick,
  opts: EvaluationOptions = {},
): Decision | null {
  const price = decimal(tick.ltp);
  if (!price.isFinite() || !price.gt(0)) return null;
  if (trade.status === 'OPEN' && trade.entryAt && tick.ts < trade.entryAt) return null;
  const base = { at: tick.ts, gapFill: false, inferred: false };
  if (trade.status === 'PENDING') {
    if (trade.entryType === 'MARKET')
      return {
        ...base,
        type: 'FILL',
        price: slipped(price, 'BUY', opts),
        gapFill: !!opts.sessionOpen,
      };
    if (trade.limitPrice != null && price.lte(trade.limitPrice)) {
      const fill = opts.sessionOpen
        ? Decimal.min(price, trade.limitPrice)
        : decimal(trade.limitPrice);
      return {
        ...base,
        type: 'FILL',
        price: roundToTick(fill, opts.tickSize ?? '.05', 'down'),
        gapFill: !!opts.sessionOpen && price.lt(trade.limitPrice),
      };
    }
    return null;
  }
  if (trade.status !== 'OPEN') return null;
  if (price.lte(trade.stopPrice))
    return {
      ...base,
      type: 'EXIT',
      reason: 'STOP',
      price: slipped(Decimal.min(price, trade.stopPrice), 'SELL', opts),
      gapFill: !!opts.sessionOpen && price.lt(trade.stopPrice),
    };
  if (price.gte(trade.targetPrice))
    return {
      ...base,
      type: 'EXIT',
      reason: 'TARGET',
      price: roundToTick(
        opts.sessionOpen ? price : trade.targetPrice,
        opts.tickSize ?? '.05',
        'down',
      ),
      gapFill: !!opts.sessionOpen && price.gt(trade.targetPrice),
    };
  return null;
}

/** OHLC recovery is inferred; when ordering is unknown the stop takes precedence. */
export function evaluateCandle(
  trade: CoreTrade,
  candle: Candle,
  opts: EvaluationOptions = {},
): Decision | null {
  const open = decimal(candle.open),
    high = decimal(candle.high),
    low = decimal(candle.low),
    close = decimal(candle.close);
  if (
    [open, high, low, close].some((v) => !v.isFinite() || !v.gt(0)) ||
    high.lt(Decimal.max(open, close)) ||
    low.gt(Decimal.min(open, close))
  )
    return null;
  const base = { at: candle.ts, inferred: true, gapFill: false };
  if (trade.status === 'PENDING') {
    if (trade.entryType === 'MARKET')
      return {
        ...base,
        type: 'FILL',
        price: slipped(open, 'BUY', opts),
        gapFill: !!opts.sessionOpen,
      };
    if (trade.limitPrice == null || low.gt(trade.limitPrice)) return null;
    const limit = decimal(trade.limitPrice);
    return {
      ...base,
      type: 'FILL',
      price: roundToTick(Decimal.min(open, limit), opts.tickSize ?? '.05', 'down'),
      gapFill: !!opts.sessionOpen && open.lt(limit),
    };
  }
  if (trade.status !== 'OPEN') return null;
  if (!opts.entryInCandle) {
    if (open.lte(trade.stopPrice))
      return {
        ...base,
        type: 'EXIT',
        reason: 'STOP',
        price: slipped(open, 'SELL', opts),
        gapFill: !!opts.sessionOpen && open.lt(trade.stopPrice),
      };
    if (open.gte(trade.targetPrice))
      return {
        ...base,
        type: 'EXIT',
        reason: 'TARGET',
        price: roundToTick(
          opts.sessionOpen ? open : trade.targetPrice,
          opts.tickSize ?? '.05',
          'down',
        ),
        gapFill: !!opts.sessionOpen && open.gt(trade.targetPrice),
      };
  }
  if (low.lte(trade.stopPrice))
    return { ...base, type: 'EXIT', reason: 'STOP', price: slipped(trade.stopPrice, 'SELL', opts) };
  // For an intrabar limit entry, only the close proves the target existed after entry.
  const reachedTarget = opts.entryInCandle
    ? close.gte(trade.targetPrice)
    : high.gte(trade.targetPrice);
  if (reachedTarget)
    return {
      ...base,
      type: 'EXIT',
      reason: 'TARGET',
      price: roundToTick(trade.targetPrice, opts.tickSize ?? '.05', 'down'),
    };
  return null;
}

export interface SessionOverride {
  date: string | Date;
  is_open?: boolean;
  isOpen?: boolean;
  open_time?: string;
  close_time?: string;
  openTime?: string;
  closeTime?: string;
  review_required?: boolean;
  reviewRequired?: boolean;
}
const IST_MS = 330 * 60 * 1000;
export function istDate(date: Date): string {
  return new Date(date.getTime() + IST_MS).toISOString().slice(0, 10);
}
function overrideDate(date: string | Date): string {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date.slice(0, 10);
}
export function marketSession(now: Date = new Date(), overrides: SessionOverride[] = []) {
  const sessionDate = istDate(now);
  const day = new Date(`${sessionDate}T00:00:00Z`).getUTCDay();
  const override = overrides.find((v) => overrideDate(v.date) === sessionDate);
  const calendarReviewRequired = override?.review_required ?? override?.reviewRequired ?? false;
  const tradingDay =
    !calendarReviewRequired &&
    (override ? (override.is_open ?? override.isOpen ?? false) : day !== 0 && day !== 6);
  const openTime = override?.open_time ?? override?.openTime ?? '09:15';
  const closeTime = override?.close_time ?? override?.closeTime ?? '15:30';
  const opensAt = new Date(`${sessionDate}T${openTime.slice(0, 5)}:00+05:30`);
  const closesAt = new Date(`${sessionDate}T${closeTime.slice(0, 5)}:00+05:30`);
  return {
    open: tradingDay && now >= opensAt && now < closesAt,
    tradingDay,
    sessionDate,
    opensAt,
    closesAt,
    calendarReviewRequired,
  };
}

/** Validity counts sessions whose open has not passed at submission time. */
export function nextExpiry(now: Date, days: number, overrides: SessionOverride[] = []): Date {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error('Validity must be 1–365 sessions');
  let cursor = new Date(`${istDate(now)}T00:00:00+05:30`),
    count = 0;
  for (let i = 0; i < 1500; i++) {
    const session = marketSession(cursor, overrides);
    if (session.calendarReviewRequired)
      throw new Error(`Calendar review required for ${session.sessionDate}`);
    if (session.tradingDay && session.opensAt >= now && ++count === days) return session.closesAt;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  throw new Error('Cannot find expiry in configured calendar');
}

export function maxDrawdown(equity: MoneyInput[]): number {
  let peak = decimal(0),
    max = decimal(0);
  for (const value of equity) {
    const current = decimal(value);
    if (current.gt(peak)) peak = current;
    if (peak.gt(0)) max = Decimal.max(max, peak.minus(current).div(peak).mul(100));
  }
  return max.toDecimalPlaces(4).toNumber();
}
