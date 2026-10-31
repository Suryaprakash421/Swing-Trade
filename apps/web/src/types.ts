export type Money = string;
export type Page = 'overview' | 'trade' | 'journal' | 'insights' | 'settings';
export interface User {
  id: string;
  username: string;
}
export interface Auth {
  user: User;
  accountId: string;
}
export interface Quote {
  symbol?: string;
  ltp: Money;
  ts: string;
  receivedAt: string;
  provider: string;
  delayed: boolean;
}
export interface Account {
  startingCapital: Money;
  cashBalance: Money;
  reservedCash: Money;
  availableCash: Money;
  investedValue: Money;
  currentValue: Money;
  unrealisedPnl: Money;
  realisedPnl: Money;
  equity: Money;
  slippageBps: number;
  limitValidityDays: number;
  reservationBufferBps: number;
  feed: {
    status: string;
    provider: string;
    delayed: boolean;
    lastHeartbeatAt: string | null;
    message: string | null;
  };
  marketOpen: boolean;
  hasStaleMarks?: boolean;
}
export interface Instrument {
  symbol: string;
  name: string;
  tickSize: Money;
  quote: Quote | null;
}
export interface Trade {
  id: string;
  symbol: string;
  qty: number;
  entryType: 'MARKET' | 'LIMIT';
  limitPrice: Money | null;
  targetPrice: Money;
  stopPrice: Money;
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';
  entryPrice: Money | null;
  entryAt: string | null;
  exitPrice: Money | null;
  exitAt: string | null;
  exitReason: string | null;
  reservedAmount: Money;
  charges: Money;
  grossPnl: Money | null;
  netPnl: Money | null;
  initialRisk: Money | null;
  setupTag: string;
  thesis: string;
  review: string;
  rejectionReason: string | null;
  inferred: boolean;
  gapFill: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  quote: Quote | null;
  unrealisedPnl: Money | null;
  recoveryPaused?: boolean;
  recoveryMessage?: string | null;
}
export interface TradeEvent {
  id: string | number;
  type: string;
  price: Money | null;
  payload: Record<string, unknown>;
  effectiveAt: string;
  createdAt: string;
}
export interface TradeDetail {
  trade: Trade;
  events: TradeEvent[];
}
export interface EquityPoint {
  date: string;
  equity: Money;
  stale: boolean;
}
export interface EquityCurve {
  points: EquityPoint[];
  initialCapital: Money;
}
export interface Stats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  averageWin: Money;
  averageLoss: Money;
  expectancy: Money;
  profitFactor: number | null;
  averageR: number | null;
  averageHoldingDays: number;
  maxDrawdown: number;
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  drawdownBasis?: 'DAILY_EQUITY' | 'FILTERED_CLOSED_TRADES';
  byTag: { tag: string; totalTrades: number; winRate: number; netPnl: Money; expectancy: Money }[];
}
