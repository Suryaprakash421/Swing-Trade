import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureProvider, ProviderError, YahooProvider } from './provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('Yahoo price provenance', () => {
  it('preserves the exchange timestamp and explicitly labels delayed quotes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: { regularMarketPrice: 2450.25, regularMarketTime: 1793332200 },
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const quote = await new YahooProvider().getQuote('RELIANCE');
    expect(quote.ltp).toBe('2450.25');
    expect(quote.ts.getTime()).toBe(1793332200_000);
    expect(quote.receivedAt.getTime()).toBeGreaterThan(quote.ts.getTime());
    expect(quote).toMatchObject({ symbol: 'RELIANCE', provider: 'yahoo', delayed: true });
  });

  it('rejects HTTP rate limits instead of manufacturing fallback prices', async () => {
    const request = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', request);
    const provider = new YahooProvider();
    await expect(provider.getQuote('SBIN')).rejects.toThrow(ProviderError);
    await expect(provider.getQuote('RELIANCE')).rejects.toThrow('backoff');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('excludes null bars and keeps the requested historical range', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: {},
                    timestamp: [1000, 1060, 1120],
                    indicators: {
                      quote: [
                        {
                          open: [100, null, 102],
                          high: [104, null, 105],
                          low: [99, null, 101],
                          close: [101, null, 103],
                        },
                      ],
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const candles = await new YahooProvider().getCandles(
      'SBIN',
      new Date(1000_000),
      new Date(1120_000),
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      symbol: 'SBIN',
      open: '100.00',
      high: '104.00',
      low: '99.00',
      close: '101.00',
    });
  });

  it('rejects an unspecified fixture file and never enables fixtures implicitly', () => {
    expect(() => new FixtureProvider('')).toThrow('FIXTURE_FILE');
  });
});
