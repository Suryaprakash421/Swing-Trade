import { readFile } from 'node:fs/promises';
import { Decimal } from '@paper/core';

export interface PriceTick {
  symbol: string;
  ltp: string;
  ts: Date;
  receivedAt: Date;
  provider: string;
  delayed: boolean;
}
export interface MarketCandle {
  symbol: string;
  ts: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  provider: string;
}
export interface PriceProvider {
  readonly name: string;
  readonly delayed: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(symbols: string[]): Promise<void>;
  unsubscribe(symbols: string[]): Promise<void>;
  getQuote(symbol: string): Promise<PriceTick>;
  getCandles(symbol: string, from: Date, to: Date, interval?: '1m' | '1d'): Promise<MarketCandle[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface YahooChart {
  meta: { regularMarketPrice?: number; regularMarketTime?: number; symbol?: string };
  timestamp?: number[];
  indicators?: {
    quote?: {
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
    }[];
  };
}

/** Unofficial, delayed Yahoo endpoint. Every value retains its exchange timestamp. */
export class YahooProvider implements PriceProvider {
  readonly name = 'yahoo';
  readonly delayed = true;
  private cache = new Map<string, { expires: number; chart: YahooChart }>();
  private retryAfter = 0;
  async start() {
    /* HTTP polling has no persistent connection. */
  }
  async stop() {
    this.cache.clear();
  }
  async subscribe(_symbols: string[]) {
    /* Demand is persisted in quote_requests. */
  }
  async unsubscribe(symbols: string[]) {
    for (const symbol of symbols) this.cache.delete(symbol);
  }

  private async chart(symbol: string, params: Record<string, string>): Promise<YahooChart> {
    if (!/^[A-Z0-9&_.-]{1,40}$/.test(symbol))
      throw new ProviderError('Invalid instrument symbol', false);
    const ticker = `${symbol}.NS`;
    const key = `${ticker}:${new URLSearchParams(params)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.chart;
    if (Date.now() < this.retryAfter)
      throw new ProviderError('Yahoo backoff is active after a rate limit or provider outage');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${new URLSearchParams(params)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
        headers: {
          'User-Agent': 'Paperlane/1.0 (personal paper-trading simulator)',
          Accept: 'application/json',
        },
      });
    } catch {
      this.retryAfter = Date.now() + 30_000;
      throw new ProviderError('Yahoo connection failed; backing off before retrying');
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : 60_000;
        this.retryAfter =
          Date.now() +
          Math.min(300_000, Math.max(30_000, Number.isFinite(seconds) ? seconds : 60_000));
      }
      throw new ProviderError(
        `Yahoo returned HTTP ${response.status}${response.status === 429 ? ' (rate limited)' : ''}`,
        response.status >= 429,
      );
    }
    const body = (await response.json()) as {
      chart?: { result?: YahooChart[]; error?: { description?: string } };
    };
    const chart = body.chart?.result?.[0];
    if (!chart)
      throw new ProviderError(body.chart?.error?.description ?? 'Yahoo returned no market data');
    this.cache.set(key, { expires: Date.now() + 10_000, chart });
    // A bounded cache prevents instrument-search demand growing worker memory forever.
    if (this.cache.size > 300) {
      for (const [entry, value] of this.cache)
        if (value.expires < Date.now()) this.cache.delete(entry);
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    }
    return chart;
  }

  async getQuote(symbol: string): Promise<PriceTick> {
    const chart = await this.chart(symbol, {
      interval: '1m',
      range: '1d',
      includePrePost: 'false',
    });
    const price = chart.meta.regularMarketPrice;
    const timestamp = chart.meta.regularMarketTime;
    if (price == null || !Number.isFinite(price) || price <= 0 || !timestamp)
      throw new ProviderError('Yahoo returned no usable quote');
    return {
      symbol,
      ltp: new Decimal(price.toString()).toFixed(2),
      ts: new Date(timestamp * 1000),
      receivedAt: new Date(),
      provider: this.name,
      delayed: true,
    };
  }

  async getCandles(
    symbol: string,
    from: Date,
    to: Date,
    interval: '1m' | '1d' = '1m',
  ): Promise<MarketCandle[]> {
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return [];
    const chart = await this.chart(symbol, {
      interval,
      period1: Math.floor(from.getTime() / 1000).toString(),
      period2: Math.ceil(to.getTime() / 1000).toString(),
      includePrePost: 'false',
    });
    const quote = chart.indicators?.quote?.[0];
    if (!quote || !chart.timestamp) return [];
    const candles: MarketCandle[] = [];
    for (let i = 0; i < chart.timestamp.length; i++) {
      const ts = new Date(chart.timestamp[i]! * 1000);
      const values = [quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i]];
      if (ts < from || ts >= to || values.some((v) => v == null || !Number.isFinite(v) || v <= 0))
        continue;
      const [open, high, low, close] = values.map((v) => new Decimal(v!.toString()).toFixed(2));
      if (
        new Decimal(high!).lt(low!) ||
        new Decimal(high!).lt(open!) ||
        new Decimal(high!).lt(close!) ||
        new Decimal(low!).gt(open!) ||
        new Decimal(low!).gt(close!)
      )
        continue;
      candles.push({
        symbol,
        ts,
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        provider: this.name,
      });
    }
    return candles.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }
}

interface FixtureData {
  quotes?: Record<string, { ltp: string | number; ts: string }>;
  candles?: Record<
    string,
    {
      ts: string;
      open: string | number;
      high: string | number;
      low: string | number;
      close: string | number;
    }[]
  >;
}

/** Explicit test provider; never silently substituted for failed Yahoo data. */
export class FixtureProvider implements PriceProvider {
  readonly name = 'fixture';
  readonly delayed = false;
  constructor(private readonly path: string) {
    if (!path) throw new Error('FIXTURE_FILE is required for PRICE_PROVIDER=fixture');
    if (process.env.NODE_ENV === 'production')
      throw new Error('Fixture provider is disabled in production');
  }
  async start() {
    await this.data();
  }
  async stop() {
    /* No open resources. */
  }
  async subscribe(_symbols: string[]) {
    /* File fixtures define available symbols. */
  }
  async unsubscribe(_symbols: string[]) {
    /* No live subscriptions. */
  }
  private async data(): Promise<FixtureData> {
    return JSON.parse(await readFile(this.path, 'utf8')) as FixtureData;
  }
  async getQuote(symbol: string): Promise<PriceTick> {
    const quote = (await this.data()).quotes?.[symbol];
    if (!quote) throw new ProviderError(`No fixture quote for ${symbol}`, false);
    const value = new Decimal(quote.ltp);
    const ts = new Date(quote.ts);
    if (!value.isFinite() || value.lte(0) || !Number.isFinite(ts.getTime()))
      throw new ProviderError('Invalid fixture quote', false);
    return {
      symbol,
      ltp: value.toFixed(2),
      ts,
      receivedAt: new Date(),
      provider: this.name,
      delayed: false,
    };
  }
  async getCandles(symbol: string, from: Date, to: Date): Promise<MarketCandle[]> {
    return ((await this.data()).candles?.[symbol] ?? [])
      .map((candle) => ({
        symbol,
        ts: new Date(candle.ts),
        open: new Decimal(candle.open).toFixed(2),
        high: new Decimal(candle.high).toFixed(2),
        low: new Decimal(candle.low).toFixed(2),
        close: new Decimal(candle.close).toFixed(2),
        provider: this.name,
      }))
      .filter((candle) => candle.ts >= from && candle.ts < to)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }
}

export function createProvider(): PriceProvider {
  const name = process.env.PRICE_PROVIDER ?? 'yahoo';
  if (name === 'yahoo') return new YahooProvider();
  if (name === 'fixture') return new FixtureProvider(process.env.FIXTURE_FILE ?? '');
  throw new Error(`Unsupported PRICE_PROVIDER=${name}; Angel One is planned for v2`);
}
