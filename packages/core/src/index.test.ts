import { describe, expect, it } from 'vitest';
import {
  calculateBalances,
  calculateReservation,
  decimal,
  evaluateCandle,
  evaluateTick,
  istDate,
  marketSession,
  maxDrawdown,
  money,
  nextExpiry,
  roundToTick,
  validateBracket,
  type CoreTrade,
} from './index.js';

const trade: CoreTrade = {
  status: 'OPEN',
  entryType: 'MARKET',
  qty: 10,
  entryPrice: '100',
  targetPrice: '110',
  stopPrice: '95',
};
const at = new Date('2026-11-02T04:00:00Z');
const pending = (type: 'MARKET' | 'LIMIT'): CoreTrade => ({
  ...trade,
  status: 'PENDING',
  entryType: type,
  limitPrice: type === 'LIMIT' ? '100' : null,
});
const bar = (open: string, high: string, low: string, close: string) => ({
  ts: at,
  open,
  high,
  low,
  close,
});

describe('decimal money and account reservations', () => {
  it('preserves decimal arithmetic and explicit rounding', () => {
    expect(money(decimal('0.1').plus('0.2'))).toBe('0.30');
    expect(roundToTick('100.011', '.05', 'up')).toBe('100.05');
    expect(roundToTick('100.049', '.05', 'down')).toBe('100.00');
    expect(roundToTick('100.03', '.05')).toBe('100.05');
  });
  it('rejects off-tick or invalid brackets', () => {
    expect(validateBracket('100', '95', '110', '.05').valid).toBe(true);
    expect(validateBracket('100', '101', '110').valid).toBe(false);
    expect(validateBracket('100', '40', '160').valid).toBe(false);
    expect(validateBracket('100', '95.01', '110', '.05').valid).toBe(false);
  });
  it('rounds reservations upward including the configured price buffer', () => {
    expect(calculateReservation(3, '99.99', 200)).toBe('305.97');
    expect(() => calculateReservation(0, '100')).toThrow();
    expect(() => calculateReservation(2, '-1')).toThrow();
  });
  it('a pending reservation reduces buying power but never equity', () => {
    expect(
      calculateBalances('100000', [
        { symbol: 'SBIN', status: 'PENDING', qty: 10, reservedAmount: '1000' },
      ]),
    ).toMatchObject({
      cashBalance: '100000.00',
      reservedCash: '1000.00',
      availableCash: '99000.00',
      equity: '100000.00',
    });
  });
  it('charges closed trade P&L once and open incurred charges once', () => {
    const account = calculateBalances(
      '100000',
      [
        { symbol: 'SBIN', status: 'CLOSED', qty: 10, netPnl: '95', charges: '5' },
        { symbol: 'SBIN', status: 'OPEN', qty: 10, entryPrice: '100', charges: '2' },
        { symbol: 'INFY', status: 'PENDING', qty: 1, reservedAmount: '1000' },
      ],
      { SBIN: '105' },
    );
    expect(account).toMatchObject({
      cashBalance: '99093.00',
      availableCash: '98093.00',
      equity: '100143.00',
      unrealisedPnl: '48.00',
      realisedPnl: '95.00',
    });
  });
  it('falls back to entry mark when a quote is unavailable without fabricating a gain', () => {
    expect(
      calculateBalances('1000', [{ symbol: 'X', status: 'OPEN', qty: 2, entryPrice: '100' }])
        .equity,
    ).toBe('1000.00');
  });
});

describe('observed tick execution', () => {
  it('fills a market buy with adverse slippage rounded to tick', () => {
    expect(evaluateTick(pending('MARKET'), { ltp: '100.01', ts: at })).toMatchObject({
      type: 'FILL',
      price: '100.10',
      inferred: false,
    });
  });
  it('waits for a limit and fills at its limit intra-session', () => {
    expect(evaluateTick(pending('LIMIT'), { ltp: '101', ts: at })).toBeNull();
    expect(evaluateTick(pending('LIMIT'), { ltp: '99', ts: at })).toMatchObject({
      type: 'FILL',
      price: '100.00',
      gapFill: false,
    });
  });
  it('improves a limit fill at a genuine opening gap', () => {
    expect(
      evaluateTick(pending('LIMIT'), { ltp: '98', ts: at }, { sessionOpen: true }),
    ).toMatchObject({ type: 'FILL', price: '98.00', gapFill: true });
  });
  it('does not book target price improvements from ordinary crossing ticks', () => {
    expect(evaluateTick(trade, { ltp: '112', ts: at })).toMatchObject({
      type: 'EXIT',
      reason: 'TARGET',
      price: '110.00',
    });
    expect(evaluateTick(trade, { ltp: '112', ts: at }, { sessionOpen: true })).toMatchObject({
      price: '112.00',
      gapFill: true,
    });
  });
  it('uses observed price on a jump through stop, plus adverse slippage', () => {
    expect(evaluateTick(trade, { ltp: '90', ts: at })).toMatchObject({
      type: 'EXIT',
      reason: 'STOP',
      price: '89.95',
    });
  });
  it('has no decision for terminal trades or invalid prices', () => {
    expect(evaluateTick({ ...trade, status: 'CLOSED' }, { ltp: '90', ts: at })).toBeNull();
    expect(evaluateTick(trade, { ltp: 'NaN', ts: at })).toBeNull();
  });
  it('does not use a quote predating the entry', () => {
    expect(
      evaluateTick({ ...trade, entryAt: new Date(at.getTime() + 1000) }, { ltp: '90', ts: at }),
    ).toBeNull();
  });
  it('keeps one-tick stop fills positive after adverse rounding', () => {
    expect(
      evaluateTick(
        { ...trade, entryPrice: '.10', stopPrice: '.05', targetPrice: '.15' },
        { ltp: '.05', ts: at },
      ),
    ).toMatchObject({ price: '0.05' });
  });
});

describe('candle reconstruction', () => {
  it('ignores invalid OHLC envelopes', () => {
    expect(evaluateCandle(trade, bar('100', '99', '98', '101'))).toBeNull();
  });
  it('uses stop first when both levels occur in one candle', () => {
    expect(evaluateCandle(trade, bar('100', '112', '94', '102'))).toMatchObject({
      reason: 'STOP',
      price: '94.95',
      inferred: true,
    });
  });
  it('preserves opening gap losses', () => {
    expect(evaluateCandle(trade, bar('90', '96', '88', '94'), { sessionOpen: true })).toMatchObject(
      { reason: 'STOP', price: '89.95', gapFill: true },
    );
  });
  it('gives opening target improvement only at actual session open', () => {
    expect(
      evaluateCandle(trade, bar('115', '116', '113', '114'), { sessionOpen: true }),
    ).toMatchObject({ reason: 'TARGET', price: '115.00', gapFill: true });
    expect(evaluateCandle(trade, bar('115', '116', '113', '114'))).toMatchObject({
      reason: 'TARGET',
      price: '110.00',
      gapFill: false,
    });
  });
  it('fills a pending limit at opening improvement or intrabar limit', () => {
    expect(
      evaluateCandle(pending('LIMIT'), bar('98', '104', '97', '103'), { sessionOpen: true }),
    ).toMatchObject({ type: 'FILL', price: '98.00', inferred: true, gapFill: true });
    expect(evaluateCandle(pending('LIMIT'), bar('102', '104', '99', '101'))).toMatchObject({
      type: 'FILL',
      price: '100.00',
    });
  });
  it('does not award a target potentially reached before intrabar limit entry', () => {
    expect(
      evaluateCandle(trade, bar('108', '112', '99', '101'), { entryInCandle: true }),
    ).toBeNull();
  });
  it('can infer a target proven by close after an intrabar limit entry', () => {
    expect(
      evaluateCandle(trade, bar('108', '112', '99', '111'), { entryInCandle: true }),
    ).toMatchObject({ reason: 'TARGET', price: '110.00' });
  });
  it('still applies the conservative stop after an intrabar fill', () => {
    expect(
      evaluateCandle(trade, bar('108', '112', '94', '111'), { entryInCandle: true }),
    ).toMatchObject({ reason: 'STOP' });
  });
});

describe('IST sessions and expiry', () => {
  it('opens at 09:15 IST and closes exactly at 15:30 IST', () => {
    expect(marketSession(new Date('2026-11-02T03:44:59Z')).open).toBe(false);
    expect(marketSession(new Date('2026-11-02T03:45:00Z')).open).toBe(true);
    expect(marketSession(new Date('2026-11-02T10:00:00Z')).open).toBe(false);
  });
  it('handles IST calendar rollover and weekends', () => {
    expect(istDate(new Date('2026-11-01T19:00:00Z'))).toBe('2026-11-02');
    expect(marketSession(new Date('2026-10-31T04:00:00Z')).tradingDay).toBe(false);
  });
  it('honors holiday closures and special weekend sessions', () => {
    expect(marketSession(at, [{ date: '2026-11-02', is_open: false }]).open).toBe(false);
    expect(
      marketSession(new Date('2026-11-01T13:00:00Z'), [
        { date: '2026-11-01', is_open: true, open_time: '18:00', close_time: '19:00' },
      ]).open,
    ).toBe(true);
  });
  it('fails closed for special sessions whose official timings require review', () => {
    const session = marketSession(new Date('2026-11-08T13:00:00Z'), [
      {
        date: '2026-11-08',
        isOpen: true,
        reviewRequired: true,
        openTime: '18:00',
        closeTime: '19:00',
      },
    ]);
    expect(session).toMatchObject({ open: false, tradingDay: false, calendarReviewRequired: true });
    expect(() =>
      nextExpiry(new Date('2026-11-06T04:00:00Z'), 1, [
        { date: '2026-11-08', isOpen: false, reviewRequired: true },
      ]),
    ).toThrow('Calendar review required for 2026-11-08');
  });
  it('counts the current session only before its open', () => {
    expect(nextExpiry(new Date('2026-11-02T03:00:00Z'), 1).toISOString()).toBe(
      '2026-11-02T10:00:00.000Z',
    );
    expect(nextExpiry(new Date('2026-11-02T04:00:00Z'), 1).toISOString()).toBe(
      '2026-11-03T10:00:00.000Z',
    );
  });
  it('skips weekends and closures for expiry', () => {
    expect(
      nextExpiry(new Date('2026-11-06T04:00:00Z'), 1, [
        { date: '2026-11-09', is_open: false },
      ]).toISOString(),
    ).toBe('2026-11-10T10:00:00.000Z');
  });
});

describe('daily mark-to-market drawdown', () => {
  it('measures loss relative to the highest prior equity, not initial capital', () => {
    expect(maxDrawdown(['100000', '120000', '90000', '105000'])).toBe(25);
    expect(maxDrawdown([])).toBe(0);
  });
});
