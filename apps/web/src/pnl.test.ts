import { describe, expect, it } from 'vitest';
import { holdingDays, percentOf, rMultiple, tradeCost, tradePnl, tradeReturnPercent } from './pnl';

describe('P&L percentage helpers', () => {
  it('expresses an amount as a percentage of a positive basis only', () => {
    expect(percentOf('141.50', '100000')).toBeCloseTo(0.1415, 6);
    expect(percentOf('-250', '10000')).toBeCloseTo(-2.5, 6);
    expect(percentOf('10', '0')).toBeNull();
    expect(percentOf('10', '-5')).toBeNull();
    expect(percentOf(null, '100')).toBeNull();
  });

  it('uses the filled entry as the cost basis of a trade', () => {
    expect(tradeCost({ entryPrice: '100.50', qty: 10 })).toBe(1005);
    expect(tradeCost({ entryPrice: null, qty: 10 })).toBe(0);
  });

  it('picks net P&L for closed trades and the mark-to-market figure for open ones', () => {
    expect(tradePnl({ status: 'CLOSED', netPnl: '114.00', unrealisedPnl: null })).toBe('114.00');
    expect(tradePnl({ status: 'OPEN', netPnl: null, unrealisedPnl: '27.50' })).toBe('27.50');
    expect(tradePnl({ status: 'PENDING', netPnl: null, unrealisedPnl: null })).toBeNull();
    expect(tradePnl({ status: 'CANCELLED', netPnl: null, unrealisedPnl: null })).toBeNull();
  });

  it('reports the return on deployed capital for both open and closed trades', () => {
    expect(
      tradeReturnPercent({
        status: 'OPEN',
        netPnl: null,
        unrealisedPnl: '27.50',
        entryPrice: '890.00',
        qty: 10,
      }),
    ).toBeCloseTo(0.3089, 3);
    expect(
      tradeReturnPercent({
        status: 'CLOSED',
        netPnl: '-50.00',
        unrealisedPnl: null,
        entryPrice: '100',
        qty: 10,
      }),
    ).toBeCloseTo(-5, 6);
    expect(
      tradeReturnPercent({
        status: 'PENDING',
        netPnl: null,
        unrealisedPnl: null,
        entryPrice: null,
        qty: 10,
      }),
    ).toBeNull();
  });

  it('computes R-multiples only when the original risk is positive', () => {
    expect(rMultiple('200', '100')).toBe(2);
    expect(rMultiple('-100', '100')).toBe(-1);
    expect(rMultiple('100', '0')).toBeNull();
    expect(rMultiple(null, '100')).toBeNull();
  });

  it('counts whole days held, using the exit for closed trades and now for open ones', () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(holdingDays({ entryAt: '2026-11-01T04:00:00.000Z', exitAt: null }, now)).toBe(3);
    expect(
      holdingDays({ entryAt: '2026-10-20T04:00:00.000Z', exitAt: '2026-10-25T09:00:00.000Z' }, now),
    ).toBe(5);
    expect(holdingDays({ entryAt: null, exitAt: null }, now)).toBeNull();
  });
});
