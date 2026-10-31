import { describe, expect, it, vi, afterEach } from 'vitest';
import { D, ApiError, quoteObject, validatePrice, validateBracket, usableQuote } from './domain.js';

afterEach(() => vi.useRealTimers());

describe('API price validation', () => {
  it('accepts exact tick multiples without binary floating-point errors', () => {
    expect(validatePrice('0.15', 'Target', '0.05').toString()).toBe('0.15');
    expect(() => validatePrice('0.12', 'Target', '0.05')).toThrow(ApiError);
    expect(() => validatePrice('NaN', 'Target')).toThrow(ApiError);
    expect(() => validatePrice('Infinity', 'Target')).toThrow(ApiError);
    expect(() => validatePrice('0', 'Target')).toThrow(ApiError);
  });
  it('rejects reversed brackets and typo-sized risk', () => {
    expect(() => validateBracket(D(100), D(90), D(120))).not.toThrow();
    expect(() => validateBracket(D(100), D(110), D(120))).toThrow(ApiError);
    expect(() => validateBracket(D(100), D(40), D(120))).toThrow(ApiError);
    expect(() => validateBracket(D(100), D(90), D(151))).toThrow(ApiError);
  });
});

describe('quote usability', () => {
  const now = new Date('2026-10-30T05:30:00Z');
  const session = {
    open: true,
    tradingDay: true,
    calendarVerified: true,
    sessionDate: '2026-10-30',
    opensAt: new Date('2026-10-30T03:45:00Z'),
    closesAt: new Date('2026-10-30T10:00:00Z'),
  };
  it('accepts delayed data while requiring a healthy received timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const q = {
      ltp: '100',
      market_at: new Date(now.getTime() - 15 * 60000),
      received_at: now,
      provider: 'yahoo',
      delayed: true,
    };
    expect(usableQuote(q, session)).toBe(true);
    expect(usableQuote({ ...q, received_at: new Date(now.getTime() - 91_000) }, session)).toBe(
      false,
    );
    expect(usableQuote({ ...q, delayed: false }, session)).toBe(false);
  });
  it('never treats pre-open or prior-session data as actionable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T03:50:00Z'));
    expect(
      usableQuote(
        {
          ltp: '100',
          market_at: new Date('2026-10-30T03:40:00Z'),
          received_at: new Date(),
          delayed: true,
        },
        session,
      ),
    ).toBe(false);
    expect(
      usableQuote(
        {
          ltp: '100',
          market_at: new Date('2026-10-29T09:50:00Z'),
          received_at: new Date(),
          delayed: true,
        },
        session,
      ),
    ).toBe(false);
  });
  it('permits a recent close only for queued reference-price reservations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const q = {
      ltp: '100',
      market_at: new Date(now.getTime() - 86_400_000),
      received_at: now,
      delayed: true,
    };
    const closed = { ...session, open: false };
    expect(usableQuote(q, closed)).toBe(false);
    expect(usableQuote(q, closed, true)).toBe(true);
    expect(
      usableQuote({ ...q, market_at: new Date(now.getTime() - 8 * 86_400_000) }, closed, true),
    ).toBe(false);
  });
  it('preserves source and receipt timestamps separately in responses', () => {
    expect(
      quoteObject({
        ltp: '101.25',
        market_at: now,
        received_at: new Date(now.getTime() + 1000),
        provider: 'yahoo',
        delayed: true,
      }),
    ).toEqual({
      ltp: '101.25',
      ts: now.toISOString(),
      receivedAt: new Date(now.getTime() + 1000).toISOString(),
      provider: 'yahoo',
      delayed: true,
    });
    expect(quoteObject(undefined)).toBeNull();
  });
});
