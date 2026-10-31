import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, migrate } from '@paper/db';
import { buildApp } from '../apps/api/src/app.js';
import { persistQuote, processTick } from '../apps/engine/src/processor.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration('API with PostgreSQL: account isolation and transactional execution', () => {
  const fixed = new Date('2026-10-30T06:00:00.000Z');
  const suffix = randomUUID().slice(0, 8);
  const usernameA = `api_a_${suffix}`,
    usernameB = `api_b_${suffix}`;
  const password = 'integration-password-only-2026';
  const markerA = `private_a_${suffix}`,
    markerB = `private_b_${suffix}`;
  let app: FastifyInstance,
    address = '',
    cookieA = '',
    cookieB = '',
    accountA = '',
    accountB = '',
    userA = '',
    userB = '';
  let pendingA = '',
    pendingB = '',
    idempotentA = '',
    closedA = '',
    closedB = '';
  let oldQuotes: Record<string, any>[] = [];
  let insertedCalendarCoverage = false;
  const previous = {
    cookie: process.env.COOKIE_SECURE,
    origin: process.env.PUBLIC_ORIGIN,
    registration: process.env.ALLOW_REGISTRATION,
    registrationAlias: process.env.REGISTRATION_ENABLED,
  };
  const cookie = (response: any) =>
    String(
      Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie'][0]
        : response.headers['set-cookie'],
    ).split(';')[0]!;
  const api = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    session?: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as any,
      headers: { ...(session ? { cookie: session } : {}), ...headers },
      remoteAddress: '192.0.2.83',
    });
  const order = (extra: Record<string, unknown> = {}) => ({
    symbol: 'SBIN',
    qty: 10,
    entryType: 'LIMIT',
    limitPrice: '100.00',
    targetPrice: '120.00',
    stopPrice: '90.00',
    setupTag: 'pullback',
    thesis: markerA,
    ...extra,
  });
  const waitUntil = async (condition: () => boolean, timeout = 6000) => {
    const started = performance.now();
    while (!condition()) {
      if (performance.now() - started > timeout)
        throw new Error('Timed out waiting for stream data');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const stream = (session: string) => {
    let text = '',
      ended = false;
    const request = http.get(
      `${address}/api/stream`,
      { headers: { Cookie: session } },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          ended = true;
        });
      },
    );
    request.on('error', () => {
      ended = true;
    });
    return { request, text: () => text, ended: () => ended };
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixed);
    process.env.COOKIE_SECURE = 'false';
    process.env.PUBLIC_ORIGIN = 'http://localhost:3000';
    process.env.ALLOW_REGISTRATION = 'true';
    process.env.REGISTRATION_ENABLED = 'true';
    await migrate();
    const [coverage] = await sql`select year from market_calendar_years where year=2026`;
    if (!coverage) {
      await sql`insert into market_calendar_years(year,source) values(2026,${`api-integration-${suffix}`})`;
      insertedCalendarCoverage = true;
    }
    oldQuotes = await sql`select * from latest_quotes where symbol in ('SBIN','TCS')`;
    for (const symbol of ['SBIN', 'TCS'])
      await persistQuote({
        symbol,
        ltp: '100.00',
        ts: fixed,
        receivedAt: fixed,
        provider: 'api-integration-fixture',
        delayed: false,
      });
    app = await buildApp({ logger: false });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
    const a = await api('POST', '/api/auth/register', undefined, {
      username: usernameA.toUpperCase(),
      password,
    });
    const b = await api('POST', '/api/auth/register', undefined, { username: usernameB, password });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    cookieA = cookie(a);
    cookieB = cookie(b);
    accountA = a.json().accountId;
    accountB = b.json().accountId;
    userA = a.json().user.id;
    userB = b.json().user.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (userA || userB)
      await sql`delete from users where id in (${userA || null},${userB || null})`;
    await sql`delete from rate_limits where key like ${`%${suffix}%`} or key like '%192.0.2.83%'`;
    await sql`delete from latest_quotes where symbol in ('SBIN','TCS') and provider='api-integration-fixture'`;
    for (const q of oldQuotes)
      await sql`insert into latest_quotes(symbol,ltp,market_at,received_at,provider,delayed)
      values(${q.symbol},${q.ltp},${q.market_at},${q.received_at},${q.provider},${q.delayed})
      on conflict(symbol) do update set ltp=excluded.ltp,market_at=excluded.market_at,received_at=excluded.received_at,provider=excluded.provider,delayed=excluded.delayed`;
    if (insertedCalendarCoverage)
      await sql`delete from market_calendar_years where year=2026 and source=${`api-integration-${suffix}`}`;
    for (const [key, value] of Object.entries({
      COOKIE_SECURE: previous.cookie,
      PUBLIC_ORIGIN: previous.origin,
      ALLOW_REGISTRATION: previous.registration,
      REGISTRATION_ENABLED: previous.registrationAlias,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.useRealTimers();
  });

  it('creates separate canonical identities with zero-charge virtual accounts', async () => {
    expect(accountA).not.toBe(accountB);
    const a = await api('GET', '/api/auth/me', cookieA),
      b = await api('GET', '/api/auth/me', cookieB);
    expect(a.json()).toMatchObject({
      user: { id: userA, username: usernameA },
      accountId: accountA,
    });
    expect(b.json()).toMatchObject({
      user: { id: userB, username: usernameB },
      accountId: accountB,
    });
    const balances = await api('GET', '/api/account', cookieA);
    expect(balances.json()).toMatchObject({
      startingCapital: '100000.00',
      availableCash: '100000.00',
      equity: '100000.00',
      realisedPnl: '0.00',
    });
    const duplicate = await api('POST', '/api/auth/register', undefined, {
      username: usernameA.toUpperCase(),
      password,
    });
    expect(duplicate.statusCode).toBe(409);
    const [count] = await sql`select count(*)::int as n from accounts where user_id=${userA}`;
    expect(count!.n).toBe(1);
  });

  it('rejects anonymous, cross-origin, non-JSON, and incorrect-password requests', async () => {
    expect((await api('GET', '/api/account')).statusCode).toBe(401);
    expect(
      (
        await api(
          'PATCH',
          '/api/account/settings',
          cookieA,
          { slippageBps: 5 },
          { origin: 'https://untrusted.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    const text = await api(
      'POST',
      '/api/auth/login',
      undefined,
      JSON.stringify({ username: usernameA, password }),
      { 'content-type': 'text/plain' },
    );
    expect(text.statusCode).toBe(415);
    const denied = await api('POST', '/api/auth/login', undefined, {
      username: usernameA,
      password: 'wrong-password-123',
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('reserves pending orders without reducing either user’s equity', async () => {
    const a = await api('POST', '/api/trades', cookieA, order());
    const b = await api('POST', '/api/trades', cookieB, order({ thesis: markerB }));
    expect(a.statusCode, a.body).toBe(202);
    expect(b.statusCode, b.body).toBe(202);
    pendingA = a.json().trade.id;
    pendingB = b.json().trade.id;
    expect(a.json().trade).toMatchObject({
      status: 'PENDING',
      qty: 10,
      charges: '0.00',
      requestedMarketAt: fixed.toISOString(),
    });
    const balance = await api('GET', '/api/account', cookieA);
    expect(balance.json()).toMatchObject({
      reservedCash: '1000.00',
      availableCash: '99000.00',
      cashBalance: '100000.00',
      equity: '100000.00',
    });
    const bBalance = await api('GET', '/api/account', cookieB);
    expect(bBalance.json().reservedCash).toBe('1000.00');
  });

  it('deduplicates market submissions and releases exactly one reservation on cancel', async () => {
    const body = order({ entryType: 'MARKET', limitPrice: undefined, qty: 5 });
    const key = `api-idempotent-${suffix}`;
    const responses = await Promise.all([
      api('POST', '/api/trades', cookieA, body, { 'idempotency-key': key }),
      api('POST', '/api/trades', cookieA, body, { 'idempotency-key': key }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(responses[0]!.json().trade.id).toBe(responses[1]!.json().trade.id);
    idempotentA = responses[0]!.json().trade.id;
    const [count] =
      await sql`select count(*)::int as n from trades where account_id=${accountA} and idempotency_key=${key}`;
    expect(count!.n).toBe(1);
    expect((await api('POST', `/api/trades/${idempotentA}/cancel`, cookieA, {})).statusCode).toBe(
      200,
    );
    const balance = await api('GET', '/api/account', cookieA);
    expect(balance.json().reservedCash).toBe('1000.00');
  });

  it('enforces ownership on lists, detail, every trade mutation, and events', async () => {
    expect((await api('GET', `/api/trades/${pendingA}`, cookieB)).statusCode).toBe(404);
    expect(
      (await api('PATCH', `/api/trades/${pendingA}`, cookieB, { review: 'not mine' })).statusCode,
    ).toBe(404);
    expect((await api('POST', `/api/trades/${pendingA}/cancel`, cookieB, {})).statusCode).toBe(404);
    expect((await api('POST', `/api/trades/${pendingA}/exit`, cookieB, {})).statusCode).toBe(404);
    expect(
      (
        await api('POST', `/api/trades/${pendingA}/reconcile`, cookieB, {
          confirm: 'RECONCILE',
          action: 'resume',
        })
      ).statusCode,
    ).toBe(404);
    const list = await api('GET', `/api/trades?account_id=${accountA}`, cookieB);
    expect(list.body).not.toContain(pendingA);
    expect(list.body).toContain(pendingB);
    const detail = await api('GET', `/api/trades/${pendingA}`, cookieA);
    expect(detail.json().events).toHaveLength(1);
    expect(detail.json().events[0].type).toBe('CREATED');
  });

  it('keeps journal exports and statistics private and neutralizes spreadsheet formulas', async () => {
    closedA = randomUUID();
    closedB = randomUUID();
    for (const [id, owner, pnl, review] of [
      [closedA, accountA, '100.00', `=2+2 ${markerA}`],
      [closedB, accountB, '-50.00', markerB],
    ]) {
      await sql`insert into trades(id,account_id,symbol,qty,entry_type,target_price,stop_price,status,entry_price,entry_at,exit_price,exit_at,exit_reason,charges,gross_pnl,net_pnl,initial_risk,setup_tag,review)
        values(${id!},${owner!},'SBIN',10,'MARKET',120,90,'CLOSED',100,${new Date(fixed.getTime() - 86_400_000)},${pnl === '100.00' ? '110' : '95'},${fixed},'MANUAL',0,${pnl!},${pnl!},100,'pullback',${review!})`;
    }
    const exportA = await api('GET', '/api/trades/export.csv', cookieA);
    expect(exportA.statusCode).toBe(200);
    expect(exportA.body).toContain(`'=2+2 ${markerA}`);
    expect(exportA.body).not.toContain(markerB);
    const exportB = await api('GET', '/api/trades/export.csv', cookieB);
    expect(exportB.body).toContain(markerB);
    expect(exportB.body).not.toContain(markerA);
    const statsA = await api('GET', '/api/stats?from=2026-10-30&to=2026-10-30', cookieA);
    expect(statsA.statusCode, statsA.body).toBe(200);
    expect(statsA.json()).toMatchObject({
      totalTrades: 1,
      wins: 1,
      losses: 0,
      expectancy: '100.00',
      netPnl: '100.00',
      profitFactor: null,
    });
    const statsB = await api('GET', '/api/stats', cookieB);
    expect(statsB.json()).toMatchObject({ totalTrades: 1, wins: 0, losses: 1, netPnl: '-50.00' });
  });

  it('streams only the authenticated owner’s events and closes on logout', async () => {
    const login = await api('POST', '/api/auth/login', undefined, {
      username: usernameB,
      password,
    });
    expect(login.statusCode).toBe(200);
    const streamCookie = cookie(login);
    const s = stream(streamCookie);
    try {
      await waitUntil(() => s.text().includes('event: snapshot'));
      const created = await api('POST', '/api/trades', cookieB, order({ qty: 1, thesis: markerB }));
      expect(created.statusCode).toBe(202);
      const id = created.json().trade.id;
      await waitUntil(() => s.text().includes(id));
      expect(s.text()).not.toContain(pendingA);
      expect(s.text()).not.toContain(closedA);
      // Stream ticks keep the connection alive without replaying unchanged data.
      await waitUntil(() => (s.text().match(/: heartbeat/g) ?? []).length >= 3, 10000);
      expect(s.text().match(/event: feed_status\n/g)).toHaveLength(1);
      const prices = [...s.text().matchAll(/event: price\ndata: ([^\n]+)/g)]
        .map((match) => JSON.parse(match[1]!))
        .filter((quote) => quote.symbol === 'SBIN');
      expect(prices).toHaveLength(1);
      const logout = await api('POST', '/api/auth/logout', streamCookie, {});
      expect(logout.statusCode).toBe(204);
      await waitUntil(s.ended, 2000);
      expect((await api('GET', '/api/auth/me', streamCookie)).statusCode).toBe(401);
      expect((await api('GET', '/api/auth/me', cookieB)).statusCode).toBe(200);
    } finally {
      s.request.destroy();
    }
  });

  it('serializes competing reservations so available cash cannot be overspent', async () => {
    const results = await Promise.all([
      api('POST', '/api/trades', cookieA, order({ qty: 600 })),
      api('POST', '/api/trades', cookieA, order({ qty: 600 })),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const balance = await api('GET', '/api/account', cookieA);
    expect(Number(balance.json().availableCash)).toBeGreaterThanOrEqual(0);
  });

  it('resets only the caller’s portfolio including snapshots and pending work', async () => {
    const bBefore = await api('GET', '/api/account', cookieB),
      bTradesBefore = await api('GET', '/api/trades', cookieB);
    await sql`insert into equity_snapshots(account_id,date,equity,stale) values(${accountA},'2026-10-29',100100,false),(${accountB},'2026-10-29',99950,false) on conflict do nothing`;
    expect(
      (await api('POST', '/api/account/reset', cookieA, { confirm: 'WRONG' })).statusCode,
    ).toBe(400);
    const reset = await api('POST', '/api/account/reset', cookieA, { confirm: 'RESET' });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({
      equity: '100000.00',
      reservedCash: '0.00',
      availableCash: '100000.00',
      realisedPnl: '0.00',
    });
    expect((await api('GET', '/api/trades', cookieA)).json().trades).toHaveLength(0);
    const bAfter = await api('GET', '/api/account', cookieB);
    expect(bAfter.json().equity).toBe(bBefore.json().equity);
    expect(bAfter.json().reservedCash).toBe(bBefore.json().reservedCash);
    expect((await api('GET', '/api/trades', cookieB)).json().trades.length).toBe(
      bTradesBefore.json().trades.length,
    );
    const [snapshots] =
      await sql`select count(*)::int as n from equity_snapshots where account_id=${accountB}`;
    expect(snapshots!.n).toBe(1);
    expect((await api('GET', `/api/trades/${closedA}`, cookieA)).statusCode).toBe(404);
  });

  it('books only one exit when a manual exit races the auto-target worker', async () => {
    const created = await api(
      'POST',
      '/api/trades',
      cookieA,
      order({
        symbol: 'TCS',
        qty: 2,
        entryType: 'MARKET',
        limitPrice: undefined,
        targetPrice: '110.00',
      }),
    );
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().trade.id;
    await processTick(
      {
        symbol: 'TCS',
        ltp: '100.00',
        ts: fixed,
        receivedAt: fixed,
        provider: 'api-integration-fixture',
        delayed: false,
      },
      { now: fixed, calendar: [] },
    );
    const opened = await api('GET', `/api/trades/${id}`, cookieA);
    expect(opened.json().trade.status).toBe('OPEN');
    const exitTime = new Date(fixed.getTime() + 1000);
    vi.setSystemTime(exitTime);
    const tick = {
      symbol: 'TCS',
      ltp: '111.00',
      ts: exitTime,
      receivedAt: exitTime,
      provider: 'api-integration-fixture',
      delayed: false,
    };
    await persistQuote(tick);
    const [manual] = await Promise.all([
      api('POST', `/api/trades/${id}/exit`, cookieA, {}),
      processTick(tick, { now: exitTime, calendar: [] }),
    ]);
    expect([200, 409]).toContain(manual.statusCode);
    const final = await api('GET', `/api/trades/${id}`, cookieA);
    expect(final.json().trade.status).toBe('CLOSED');
    expect(Number(final.json().trade.charges)).toBe(0);
    const [count] =
      await sql`select count(*)::int as n from trade_events where trade_id=${id} and type='EXITED'`;
    expect(count!.n).toBe(1);
    const [notifications] =
      await sql`select count(*)::int as n from outbox where trade_id=${id} and kind='EXIT'`;
    expect(notifications!.n).toBe(1);
    const [row] = await sql`select entry_price,exit_price,qty,net_pnl from trades where id=${id}`;
    expect(Number(row!.net_pnl)).toBeCloseTo(
      (Number(row!.exit_price) - Number(row!.entry_price)) * row!.qty,
      2,
    );
  });

  it('requires explicit reconciliation before a paused trade can be manually exited', async () => {
    const id = randomUUID();
    await sql`insert into trades(id,account_id,symbol,qty,entry_type,target_price,stop_price,status,entry_price,entry_at,initial_risk,recovery_paused,recovery_message)
      values(${id},${accountA},'TCS',1,'MARKET',120,90,'OPEN',100,${fixed},10,true,'History missing in test')`;
    expect((await api('POST', `/api/trades/${id}/exit`, cookieA, {})).statusCode).toBe(409);
    expect(
      (await api('PATCH', `/api/trades/${id}`, cookieA, { stopPrice: '95.00' })).statusCode,
    ).toBe(409);
    const reconciled = await api('POST', `/api/trades/${id}/reconcile`, cookieA, {
      confirm: 'RECONCILE',
      action: 'close',
      exitPrice: '105.00',
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().trade).toMatchObject({
      status: 'CLOSED',
      inferred: true,
      recoveryPaused: false,
    });
    const detail = await api('GET', `/api/trades/${id}`, cookieA);
    expect(detail.json().events.some((e: any) => e.type === 'RECONCILED')).toBe(true);
  });
});
