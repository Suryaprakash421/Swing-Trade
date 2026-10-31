import { describe, expect, it } from 'vitest';
import { estimateTrade } from './tradeEstimate';

const base = {
  entryType: 'MARKET' as const,
  quantityMode: 'amount' as const,
  quantity: '10000',
  quote: '100',
  limit: '',
  target: '110',
  stop: '95',
  tickSize: '.05',
  slippageBps: 5,
  reservationBufferBps: 200,
  availableCash: '100000',
};

describe('trade preview financial boundaries', () => {
  it('sizes amount orders using the tick-rounded slipped entry, as the API does', () => {
    const estimate = estimateTrade(base);
    expect(estimate.entry).toBe('100.05');
    expect(estimate.qty).toBe(99);
    expect(estimate.estimated).toBe('9904.95');
    expect(estimate.reserve).toBe('10103.05');
    expect(estimate.risk).toBe('499.95');
    expect(estimate.reward).toBe('985.05');
  });

  it('rounds fractional paise reservations upwards rather than understating buying power needed', () => {
    const estimate = estimateTrade({
      ...base,
      quantityMode: 'qty',
      quantity: '1',
      quote: '100.01',
      reservationBufferBps: 1,
    });
    expect(estimate.entry).toBe('100.10');
    expect(estimate.reserve).toBe('100.12');
    expect(
      estimateTrade({
        ...base,
        quantityMode: 'qty',
        quantity: '1',
        quote: '100.01',
        reservationBufferBps: 1,
        availableCash: '100.11',
      }).insufficientCash,
    ).toBe(true);
  });

  it('does not add market slippage or market reservation buffer to a limit order', () => {
    const estimate = estimateTrade({
      ...base,
      entryType: 'LIMIT',
      limit: '99.95',
      quantity: '999.50',
    });
    expect(estimate.qty).toBe(10);
    expect(estimate.entry).toBe('99.95');
    expect(estimate.reserve).toBe('999.50');
  });

  it('does not manufacture ratios or valid brackets for incomplete prices', () => {
    const estimate = estimateTrade({ ...base, quote: undefined, target: '', stop: '' });
    expect(estimate.qty).toBe(0);
    expect(estimate.hasEntry).toBe(false);
    expect(estimate.validBracket).toBe(false);
    expect(estimate.ratio).toBe(null);
  });
});
