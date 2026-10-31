import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql, migrate } from '@paper/db';
import { calculateBalances } from '@paper/core';
import {
  captureEquity,
  expirePending,
  pauseTrade,
  processCandles,
  processTick,
} from '../apps/engine/src/processor.js';
import type { MarketCandle, PriceTick } from '../apps/engine/src/provider.js';

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const owners: string[] = [];
const symbols: string[] = [];
const at = (time: string) => new Date(`2026-10-30T${time}Z`);

async function seedAccount(capital = '100000', slippage = 0) {
  const id = randomUUID();
  const username = `eng_${id.replaceAll('-', '').slice(0, 20)}`;
  await sql`insert into users(id,username,password_hash) values(${id},${username},'integration-only-no-login')`;
  owners.push(id);
  const [account] =
    await sql`insert into accounts(user_id,starting_capital,slippage_bps,created_at,reset_at)
    values(${id},${capital},${slippage},${at('03:30:00')},${at('03:30:00')}) returning *`;
  return account!;
}

async function seedSymbol() {
  const symbol = `ENG${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  await sql`insert into instruments(symbol,name,yahoo_symbol) values(${symbol},'Synthetic engine integration instrument',${`${symbol}.NS`})`;
  symbols.push(symbol);
  return symbol;
}

async function seedTrade(
  accountId: string,
  symbol: string,
  overrides: Record<string, unknown> = {},
) {
  const data = {
    account_id: accountId,
    symbol,
    qty: 10,
    entry_type: 'MARKET',
    limit_price: null,
    target_price: '120',
    stop_price: '90',
    reserved_amount: '1000',
    created_at: at('04:14:00'),
    requested_market_at: at('04:14:00'),
    ...overrides,
  };
  const [trade] = await sql`insert into trades ${sql(data)} returning *`;
  return trade!;
}

function tick(symbol: string, ltp = '100', time = '04:15:00'): PriceTick {
  return { symbol, ltp, ts: at(time), receivedAt: at(time), provider: 'fixture', delayed: false };
}

function candle(symbol: string, fields: Partial<MarketCandle> = {}): MarketCandle {
  return {
    symbol,
    ts: at('04:16:00'),
    open: '100',
    high: '110',
    low: '95',
    close: '105',
    provider: 'fixture',
    ...fields,
  };
}

async function balance(accountId: string) {
  const [account] = await sql`select * from accounts where id=${accountId}`;
  const rows = await sql`select * from trades where account_id=${accountId}`;
  const quotes = await sql`select symbol,ltp from latest_quotes`;
  return calculateBalances(
    String(account!.starting_capital),
    rows.map((t) => ({
      symbol: t.symbol as string,
      status: t.status as string,
      qty: t.qty as number,
      entryPrice: t.entry_price as string | null,
      netPnl: t.net_pnl as string | null,
      charges: t.charges as string,
      reservedAmount: t.reserved_amount as string,
    })),
    Object.fromEntries(quotes.map((q) => [q.symbol as string, q.ltp as string])),
  );
}

describe.runIf(databaseEnabled)('PostgreSQL engine correctness', () => {
  beforeAll(async () => {
    await migrate();
  });
  afterEach(async () => {
    if (owners.length) await sql`delete from users where id in ${sql(owners.splice(0))}`;
    for (const symbol of symbols.splice(0)) {
      await sql`delete from latest_quotes where symbol=${symbol}`;
      await sql`delete from price_bars_1m where symbol=${symbol}`;
      await sql`delete from quote_requests where symbol=${symbol}`;
      await sql`delete from instruments where symbol=${symbol}`;
    }
  });
  it('fills once, preserves equity on reservation, and auto exits at the target with zero charges', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol);
    const before = await balance(account.id as string);
    expect(before).toMatchObject({
      cashBalance: '100000.00',
      availableCash: '99000.00',
      equity: '100000.00',
    });
    await Promise.all([
      processTick(tick(symbol), { now: at('04:15:00'), calendar: [] }),
      processTick(tick(symbol), { now: at('04:15:00'), calendar: [] }),
    ]);
    const [opened] = await sql`select * from trades where id=${trade.id}`;
    expect(opened).toMatchObject({ status: 'OPEN', charges: '0.00', reserved_amount: '0.00' });
    expect(Number(opened!.entry_price)).toBe(100);
    expect((await balance(account.id as string)).equity).toBe('100000.00');
    await processTick(tick(symbol, '121', '04:17:00'), { now: at('04:17:00'), calendar: [] });
    await processTick(tick(symbol, '121', '04:17:00'), { now: at('04:17:00'), calendar: [] });
    const [closed] = await sql`select * from trades where id=${trade.id}`;
    expect(closed).toMatchObject({
      status: 'CLOSED',
      exit_reason: 'TARGET',
      gross_pnl: '200.00',
      net_pnl: '200.00',
    });
    expect(Number(closed!.exit_price)).toBe(120);
    const events = await sql`select type from trade_events where trade_id=${trade.id} order by id`;
    expect(events.map((e) => e.type)).toEqual(['FILLED', 'EXITED']);
    expect(await balance(account.id as string)).toMatchObject({
      cashBalance: '100200.00',
      availableCash: '100200.00',
      equity: '100200.00',
    });
  });

  it('keeps ownership independent when both accounts trade the same symbol', async () => {
    const a = await seedAccount('1000'),
      b = await seedAccount('1000');
    const symbol = await seedSymbol();
    await seedTrade(a.id as string, symbol);
    await seedTrade(b.id as string, symbol);
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    const rows = await sql`select account_id,status from trades where symbol=${symbol}`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'OPEN')).toBe(true);
    expect((await balance(a.id as string)).cashBalance).toBe('0.00');
    expect((await balance(b.id as string)).cashBalance).toBe('0.00');
  });

  it('replays a limit entry and same-candle stop conservatively without duplicate outcomes', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol, {
      entry_type: 'LIMIT',
      limit_price: '100',
    });
    const bar = candle(symbol, { open: '104', high: '125', low: '89', close: '119' });
    await processCandles([bar], { now: at('04:18:00'), calendar: [] });
    await processCandles([bar], { now: at('04:18:00'), calendar: [] });
    const [closed] = await sql`select * from trades where id=${trade.id}`;
    expect(closed).toMatchObject({
      status: 'CLOSED',
      exit_reason: 'STOP',
      inferred: true,
      net_pnl: '-100.00',
    });
    expect(Number(closed!.entry_price)).toBe(100);
    expect(Number(closed!.exit_price)).toBe(90);
    const [count] =
      await sql`select count(*)::integer as count from trade_events where trade_id=${trade.id}`;
    expect(count!.count).toBe(2);
  });

  it('uses the observed price for a stop jump and books a larger loss', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol);
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    await processTick(tick(symbol, '85', '04:16:00'), { now: at('04:16:00'), calendar: [] });
    const [closed] = await sql`select * from trades where id=${trade.id}`;
    expect(closed).toMatchObject({ status: 'CLOSED', exit_reason: 'STOP', net_pnl: '-150.00' });
    expect(Number(closed!.exit_price)).toBe(85);
  });

  it('cancels unaffordable gaps and invalid opening brackets without resizing', async () => {
    const a = await seedAccount('1000'),
      b = await seedAccount('1000');
    const symbol = await seedSymbol();
    const invalid = await seedTrade(a.id as string, symbol, {
      target_price: '105',
      requested_market_at: at('03:44:00'),
      created_at: at('03:44:00'),
    });
    const expensive = await seedTrade(b.id as string, symbol, {
      target_price: '150',
      requested_market_at: at('03:44:00'),
      created_at: at('03:44:00'),
    });
    await processTick(tick(symbol, '110', '03:45:00'), { now: at('03:45:00'), calendar: [] });
    const rows = await sql`select * from trades where id in ${sql([invalid.id, expensive.id])}`;
    expect(
      rows.every(
        (row) =>
          row.status === 'CANCELLED' && Number(row.qty) === 10 && Number(row.reserved_amount) === 0,
      ),
    ).toBe(true);
    expect(rows.some((row) => String(row.rejection_reason).includes('Fill rejected'))).toBe(true);
    expect(rows.some((row) => String(row.rejection_reason).includes('Insufficient'))).toBe(true);
  });

  it('does not expire or execute a trade with unresolved recovery until acknowledged', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol, {
      entry_type: 'LIMIT',
      limit_price: '100',
      expires_at: at('04:15:00'),
    });
    await pauseTrade(trade.id as string, 'History unavailable', at('04:14:30'));
    await pauseTrade(trade.id as string, 'History unavailable', at('04:14:31'));
    await expirePending(at('04:16:00'));
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    const [paused] = await sql`select * from trades where id=${trade.id}`;
    expect(paused).toMatchObject({
      status: 'PENDING',
      recovery_paused: true,
      recovery_message: 'History unavailable',
    });
    const [count] =
      await sql`select count(*)::integer as count from trade_events where trade_id=${trade.id} and type='RECOVERY_REQUIRED'`;
    expect(count!.count).toBe(1);
  });

  it('reconstructs the bracket effective at candle time rather than applying a later stop edit', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol);
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    await sql`update trades set stop_price=105,target_price=130 where id=${trade.id}`;
    await sql`insert into trade_events(trade_id,account_id,type,payload,effective_at)
      values(${trade.id},${account.id},'MODIFIED',${JSON.stringify({ old: { targetPrice: '120', stopPrice: '90' }, new: { targetPrice: '130', stopPrice: '105' } })}::jsonb,${at('04:20:00')})`;
    await processTick(tick(symbol, '102', '04:16:00'), { now: at('04:16:00'), calendar: [] });
    await processCandles([candle(symbol, { open: '110', high: '119', low: '100', close: '112' })], {
      now: at('04:21:00'),
      calendar: [],
    });
    const [open] = await sql`select status from trades where id=${trade.id}`;
    expect(open!.status).toBe('OPEN');
  });

  it('fills from a current received delayed quote without waiting for wall-clock catch-up', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol, {
      created_at: at('04:30:00'),
      requested_market_at: at('04:15:00'),
    });
    const delayed = {
      ...tick(symbol),
      receivedAt: at('04:30:00'),
      provider: 'yahoo',
      delayed: true,
    };
    await processTick(delayed, { now: at('04:30:00'), calendar: [] });
    const [open] = await sql`select * from trades where id=${trade.id}`;
    expect(open!.status).toBe('OPEN');
    expect(new Date(open!.entry_at).toISOString()).toBe(at('04:15:00').toISOString());
  });

  it('does not use completed candles from before the position existed', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol, {
      requested_market_at: at('04:10:00'),
    });
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    await processCandles(
      [candle(symbol, { ts: at('04:12:00'), open: '100', high: '130', low: '80', close: '100' })],
      { now: at('04:17:00'), calendar: [] },
    );
    const [open] = await sql`select * from trades where id=${trade.id}`;
    expect(open!.status).toBe('OPEN');
  });

  it('finishes delayed source-session exits after the wall-clock market close', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol);
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    const delayed = {
      ...tick(symbol, '121', '09:59:00'),
      receivedAt: at('10:14:00'),
      provider: 'yahoo',
      delayed: true,
    };
    await processTick(delayed, { now: at('10:14:00'), calendar: [] });
    const [closed] = await sql`select * from trades where id=${trade.id}`;
    expect(closed).toMatchObject({ status: 'CLOSED', exit_reason: 'TARGET', net_pnl: '200.00' });
  });

  it('keeps after-hours entries pending instead of filling against a prior session quote', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    const trade = await seedTrade(account.id as string, symbol, {
      created_at: at('11:00:00'),
      requested_market_at: at('11:00:00'),
    });
    await processTick(
      { ...tick(symbol, '100', '09:59:00'), receivedAt: at('11:01:00'), delayed: true },
      { now: at('11:01:00'), calendar: [] },
    );
    const [pending] = await sql`select * from trades where id=${trade.id}`;
    expect(pending).toMatchObject({
      status: 'PENDING',
      entry_price: null,
      reserved_amount: '1000.00',
    });
  });

  it('persists session-close equity from historical marks and remains idempotent', async () => {
    const account = await seedAccount();
    const symbol = await seedSymbol();
    await seedTrade(account.id as string, symbol);
    await processTick(tick(symbol), { now: at('04:15:00'), calendar: [] });
    await sql`insert into price_bars_1m(symbol,ts,open,high,low,close,provider)
      values(${symbol},${at('09:59:00')},105,110,105,110,'fixture')`;
    await captureEquity(at('10:30:00'), []);
    await captureEquity(at('10:30:00'), []);
    const snapshots = await sql`select * from equity_snapshots where account_id=${account.id}`;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ equity: '100100.00', stale: false });
  });
});
