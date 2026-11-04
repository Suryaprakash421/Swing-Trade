import type { Trade } from './types';

const num = (value: unknown) => Number(value ?? 0);

/** Percentage of `amount` against a positive `basis`; null when the basis cannot support a ratio. */
export function percentOf(amount: unknown, basis: unknown): number | null {
  if (amount == null) return null;
  const b = num(basis);
  if (!(b > 0) || !Number.isFinite(num(amount))) return null;
  return (num(amount) / b) * 100;
}

/** Cost basis of a filled trade: entry price × quantity. Zero before a fill. */
export function tradeCost(trade: Pick<Trade, 'entryPrice' | 'qty'>): number {
  return trade.entryPrice ? num(trade.entryPrice) * trade.qty : 0;
}

/** The P&L figure that applies to a trade's current state: net for closed, mark-to-market for open. */
export function tradePnl(trade: Pick<Trade, 'status' | 'netPnl' | 'unrealisedPnl'>): string | null {
  if (trade.status === 'CLOSED') return trade.netPnl;
  if (trade.status === 'OPEN') return trade.unrealisedPnl;
  return null;
}

/** Return on the capital deployed in the trade, in percent. */
export function tradeReturnPercent(
  trade: Pick<Trade, 'status' | 'netPnl' | 'unrealisedPnl' | 'entryPrice' | 'qty'>,
): number | null {
  return percentOf(tradePnl(trade), tradeCost(trade));
}

/** R-multiple: P&L expressed in units of the risk originally accepted at entry. */
export function rMultiple(pnl: unknown, initialRisk: unknown): number | null {
  if (pnl == null) return null;
  const risk = num(initialRisk);
  if (!(risk > 0)) return null;
  return num(pnl) / risk;
}

/** Whole calendar days a position has been (or was) held, measured in the IST trading timeline. */
export function holdingDays(
  trade: Pick<Trade, 'entryAt' | 'exitAt'>,
  now: Date = new Date(),
): number | null {
  if (!trade.entryAt) return null;
  const start = new Date(trade.entryAt).getTime();
  const end = trade.exitAt ? new Date(trade.exitAt).getTime() : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000);
}
