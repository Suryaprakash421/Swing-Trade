import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import pino from 'pino';
import { sql, migrate, importNseInstruments, parseCsv } from '@paper/db';
import { istDate, marketSession } from '@paper/core';
import type { SessionOverride } from '@paper/core';
import {
  captureEquity,
  expirePending,
  loadCalendar,
  pauseTrade,
  persistQuote,
  processCandles,
  processTick,
  setProcessingGuard,
} from './processor.js';
import { createProvider } from './provider.js';
import type { MarketCandle, PriceProvider, PriceTick } from './provider.js';

const log = pino({
  name: 'paperlane-engine',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['token', 'password', 'telegram_chat_id'],
});
const ADVISORY_LOCK_ID = 741936210;
const MAX_DELAY_MS = Number(process.env.MAX_QUOTE_DELAY_MS ?? 1_200_000);
const MINUTE = 60_000;

export interface CycleResult {
  requested: number;
  quotes: number;
  candles: number;
  errors: number;
  status: string;
}

function clock(provider: PriceProvider): Date {
  if (provider.name === 'fixture' && process.env.FIXTURE_NOW) {
    const date = new Date(process.env.FIXTURE_NOW);
    if (!Number.isFinite(date.getTime())) throw new Error('FIXTURE_NOW must be an ISO date');
    return date;
  }
  return new Date();
}

export async function heartbeat(status: string, message: string, provider: string): Promise<void> {
  await sql`insert into engine_state(id,heartbeat_at,status,message,provider)
    values(1,now(),${status},${message},${provider}) on conflict(id) do update
    set heartbeat_at=now(),status=excluded.status,message=excluded.message,provider=excluded.provider`;
}

function tradingOverlap(from: Date, to: Date, calendar: SessionOverride[]) {
  if (from >= to) return false;
  // A retention failure is handled separately; inspect at most the last 31 days.
  let day = new Date(Math.max(from.getTime(), to.getTime() - 31 * 86400_000));
  for (let count = 0; count < 33 && day <= to; count++, day = new Date(day.getTime() + 86400_000)) {
    const session = marketSession(day, calendar);
    if (
      session.tradingDay &&
      Math.min(to.getTime(), session.closesAt.getTime()) -
        Math.max(from.getTime(), session.opensAt.getTime()) >=
        MINUTE
    )
      return true;
  }
  return false;
}

/** One bounded worker iteration. Exported so integration tests can control the clock/provider. */
export async function runCycle(
  provider: PriceProvider,
  now = clock(provider),
): Promise<CycleResult> {
  const calendar = await loadCalendar();
  const session = marketSession(now, calendar);
  const active = await sql`
    select symbol,min(coalesce(last_candle_at+interval '1 minute',requested_market_at,created_at)) as from_at
    from trades where status in ('OPEN','PENDING') and not recovery_paused group by symbol
  `;
  const reviewed = await sql`select year from market_calendar_years`;
  const reviewedYears = new Set(reviewed.map((row) => Number(row.year)));
  const requiredYears = new Set([Number(session.sessionDate.slice(0, 4))]);
  for (const trade of active) {
    const firstYear = Number(istDate(new Date(trade.from_at as Date)).slice(0, 4));
    for (let year = firstYear; year <= Number(session.sessionDate.slice(0, 4)); year++)
      requiredYears.add(year);
  }
  const missingYears = [...requiredYears].filter((year) => !reviewedYears.has(year));
  const earliestDate = active.length
    ? active.reduce((earliest, row) => {
        const date = istDate(new Date(row.from_at as Date));
        return date < earliest ? date : earliest;
      }, session.sessionDate)
    : session.sessionDate;
  const unresolvedSessions = await sql`select date::text from market_sessions where review_required
    and date>=${earliestDate}::date and date<=${session.sessionDate}::date order by date`;
  const calendarReady =
    provider.name === 'fixture' || (!missingYears.length && !unresolvedSessions.length);
  const requests =
    await sql`select symbol from quote_requests where expires_at>now() order by requested_at desc limit 100`;
  const symbols = [
    ...new Set([
      ...active.map((r) => r.symbol as string),
      ...requests.map((r) => r.symbol as string),
    ]),
  ];
  await provider.subscribe(symbols);
  await heartbeat('SYNCING', 'Checking quotes and available completed candles', provider.name);
  const ticks: PriceTick[] = [];
  const candles: MarketCandle[] = [];
  let errors = 0;
  let incomplete = 0;
  // Four requests at a time: bounded memory and polite to the unofficial provider.
  for (let offset = 0; offset < symbols.length; offset += 4) {
    await Promise.all(
      symbols.slice(offset, offset + 4).map(async (symbol) => {
        const row = active.find((a) => a.symbol === symbol);
        try {
          const tick = await provider.getQuote(symbol);
          ticks.push(tick);
          await persistQuote(tick);
        } catch (error) {
          errors++;
          log.warn(
            { symbol, error: error instanceof Error ? error.message : 'Provider request failed' },
            'Quote unavailable',
          );
        }
        if (!row || !calendarReady) return;
        const from = new Date(row.from_at as Date);
        const expectedTo = new Date(now.getTime() - (provider.delayed ? MAX_DELAY_MS : MINUTE));
        if (!tradingOverlap(from, new Date(now.getTime() - MINUTE), calendar)) return;
        // Yahoo limits 1-minute retention; never pretend old unavailable history was checked.
        if (provider.name === 'yahoo' && from.getTime() < now.getTime() - 7 * 86400_000) {
          incomplete++;
          const affected =
            await sql`select id from trades where symbol=${symbol} and status in ('OPEN','PENDING') and not recovery_paused`;
          for (const trade of affected)
            await pauseTrade(
              trade.id as string,
              'Required one-minute history exceeds the Yahoo recovery window; reconcile this trade manually',
              now,
            );
          return;
        }
        try {
          const history = await provider.getCandles(
            symbol,
            new Date(Math.floor(from.getTime() / MINUTE) * MINUTE),
            now,
            '1m',
          );
          const observedMarketTime =
            ticks.find((tick) => tick.symbol === symbol)?.ts ??
            new Date(now.getTime() - (provider.delayed ? MAX_DELAY_MS : MINUTE));
          const completed = history.filter(
            (c) =>
              c.ts.getTime() + MINUTE <= Math.min(now.getTime(), observedMarketTime.getTime()) &&
              marketSession(c.ts, calendar).open,
          );
          candles.push(...completed);
          // A returned empty history after trading time elapsed is explicitly unresolved.
          const missingRequiredHistory =
            tradingOverlap(from, expectedTo, calendar) &&
            (!completed.length ||
              tradingOverlap(
                new Date(completed.at(-1)!.ts.getTime() + MINUTE),
                expectedTo,
                calendar,
              ) ||
              tradingOverlap(from, completed[0]!.ts, calendar) ||
              completed.some(
                (bar, index) =>
                  index > 0 &&
                  tradingOverlap(
                    new Date(completed[index - 1]!.ts.getTime() + MINUTE),
                    bar.ts,
                    calendar,
                  ),
              ));
          if (missingRequiredHistory && provider.name !== 'fixture') {
            incomplete++;
            const affected =
              await sql`select id from trades where symbol=${symbol} and status in ('OPEN','PENDING') and not recovery_paused`;
            for (const trade of affected)
              await pauseTrade(
                trade.id as string,
                'Provider returned incomplete candles for a required historical trading interval; reconcile before automation resumes',
                now,
              );
          }
        } catch (error) {
          errors++;
          log.warn(
            { symbol, error: error instanceof Error ? error.message : 'History request failed' },
            'History unavailable',
          );
          // First outage is visible as stale; once an unresolved historical interval exists, pause automation.
          if (tradingOverlap(from, expectedTo, calendar) && provider.name !== 'fixture') {
            incomplete++;
            const affected =
              await sql`select id from trades where symbol=${symbol} and status in ('OPEN','PENDING') and not recovery_paused`;
            for (const trade of affected)
              await pauseTrade(
                trade.id as string,
                'Historical candles unavailable after a feed gap; manual reconciliation required',
                now,
              );
          }
        }
      }),
    );
    await heartbeat(
      'SYNCING',
      'Receiving delayed data; replay precedes current quotes',
      provider.name,
    );
  }

  // Completed bars from all symbols are replayed in market-time order before new quotes.
  if (calendarReady) {
    await processCandles(candles, { now, calendar });
    for (const tick of ticks.sort(
      (a, b) => a.ts.getTime() - b.ts.getTime() || a.symbol.localeCompare(b.symbol),
    )) {
      await processTick(tick, { now, calendar });
    }
    // Delayed mode must finish the session's last candles before expiring its pending orders.
    await expirePending(new Date(now.getTime() - (provider.delayed ? MAX_DELAY_MS : 0)));
    await captureEquity(
      new Date(now.getTime() - (provider.delayed ? MAX_DELAY_MS : MINUTE)),
      calendar,
      provider.name === 'fixture' ? undefined : reviewedYears,
    );
  }
  await sql`delete from quote_requests where expires_at<now()-interval '1 hour'`;
  const staleTicks = ticks.filter(
    (tick) =>
      session.open &&
      (istDate(tick.ts) !== session.sessionDate ||
        now.getTime() - tick.ts.getTime() > (provider.delayed ? MAX_DELAY_MS : MINUTE)),
  ).length;
  const paused =
    await sql`select count(*)::integer as count from trades where status in ('OPEN','PENDING') and recovery_paused`;
  const needsReview = incomplete > 0 || Number(paused[0]?.count ?? 0) > 0;
  const stale = errors > 0 || staleTicks > 0;
  const status = !calendarReady
    ? 'CALENDAR_REQUIRED'
    : needsReview
      ? 'RECOVERY_REQUIRED'
      : stale
        ? 'STALE'
        : session.open && symbols.length
          ? 'HEALTHY'
          : 'IDLE';
  const message = !calendarReady
    ? missingYears.length
      ? `Import reviewed NSE calendar coverage for ${missingYears.join(', ')} before automated trading can run`
      : `Confirm NSE special-session timings for ${unresolvedSessions.map((row) => row.date).join(', ')} before automated trading can run`
    : needsReview
      ? 'Some trades need manual history reconciliation; affected automation is paused'
      : stale
        ? 'Market data is unavailable or older than the configured usable-data threshold'
        : !symbols.length
          ? 'Engine ready; search for an instrument to request a market quote'
          : session.open
            ? `${provider.delayed ? 'Delayed Yahoo' : 'Fixture'} data connected; simulation only`
            : 'Market is closed; pending entries wait for the next eligible session';
  await heartbeat(status, message, provider.name);
  return {
    requested: symbols.length,
    quotes: ticks.length,
    candles: candles.length,
    errors,
    status,
  };
}

/** Refresh a validated NSE EQ list without deactivating instruments on import failure. */
export async function refreshInstruments(): Promise<number> {
  const response = await fetch('https://archives.nseindia.com/content/equities/EQUITY_L.csv', {
    signal: AbortSignal.timeout(12_000),
    headers: { 'User-Agent': 'Paperlane/1.0', Accept: 'text/csv' },
  });
  if (!response.ok) throw new Error(`NSE instruments returned HTTP ${response.status}`);
  const source = await response.text();
  const rows = parseCsv(source);
  const header =
    rows.shift()?.map((value) =>
      value
        .replace(/^\uFEFF/, '')
        .trim()
        .toUpperCase(),
    ) ?? [];
  const symbolIndex = header.indexOf('SYMBOL'),
    nameIndex = header.indexOf('NAME OF COMPANY'),
    seriesIndex = header.indexOf('SERIES');
  if (symbolIndex < 0 || nameIndex < 0)
    throw new Error('NSE CSV headers changed; keeping existing instrument list');
  const instruments = rows.filter(
    (row) =>
      (!row[seriesIndex] || row[seriesIndex] === 'EQ') &&
      /^[A-Z0-9&_.-]{1,40}$/.test(row[symbolIndex] ?? ''),
  );
  if (instruments.length < 500)
    throw new Error('NSE instrument list is unexpectedly incomplete; keeping existing list');
  return await importNseInstruments(source);
}

async function enqueueServiceAlert(kind: string, message: string, key: string) {
  await sql`insert into outbox(account_id,kind,payload,dedupe_key)
    select p.account_id,${kind},${JSON.stringify({ message })}::jsonb,${key}||':'||p.account_id::text
    from notification_preferences p where p.enabled and p.verified and p.telegram_chat_id is not null
    on conflict(dedupe_key) do nothing`;
}

/** Per-user outbox delivery. Disabled unless an operator explicitly configures a bot token. */
export async function deliverOutbox(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const jobs =
    await sql`select o.*,p.telegram_chat_id from outbox o join notification_preferences p on p.account_id=o.account_id
    where o.delivered_at is null and o.next_attempt_at<=now() and o.attempts<8
      and p.enabled and p.verified and p.telegram_chat_id is not null order by o.id limit 5`;
  for (const job of jobs) {
    const payload = job.payload as Record<string, unknown>;
    const text = payload.message
      ? `Paperlane: ${String(payload.message)}`
      : `Paperlane · ${String(job.kind)}\n${String(payload.symbol ?? '')} × ${String(payload.qty ?? '')} at ₹${String(payload.price ?? '')}${payload.reason ? `\n${String(payload.reason)}` : ''}${payload.pnl != null ? ` · P&L ₹${String(payload.pnl)}` : ''}${payload.inferred ? '\nEstimated candle-based fill' : ''}`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: job.telegram_chat_id, text }),
        signal: AbortSignal.timeout(8_000),
      });
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || !result.ok)
        throw new Error(`Telegram delivery failed (${response.status})`);
      await sql`update outbox set delivered_at=now(),attempts=attempts+1,last_error=null where id=${job.id}`;
    } catch (error) {
      const attempts = Number(job.attempts) + 1;
      const next = new Date(Date.now() + Math.min(3600_000, 10_000 * 2 ** attempts));
      await sql`update outbox set attempts=${attempts},next_attempt_at=${next},last_error=${error instanceof Error ? error.message.slice(0, 200) : 'Delivery failed'} where id=${job.id}`;
    }
  }
}

/** A dedicated PostgreSQL connection owns the process-wide engine lease. */
export async function runEngine(signal?: AbortSignal): Promise<void> {
  await migrate();
  const provider = createProvider();
  let lostLease = false;
  const lockClient = postgres(
    process.env.DATABASE_URL ?? 'postgres://papertrade:papertrade@127.0.0.1:5432/papertrade',
    {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 10,
      onnotice: () => {},
      onclose: () => {
        lostLease = true;
      },
    },
  );
  const connection = await lockClient.reserve();
  const leasePid = (await connection`select pg_backend_pid() as pid`)[0]!.pid;
  const [lock] = await connection`select pg_try_advisory_lock(${ADVISORY_LOCK_ID}) as acquired`;
  if (!lock?.acquired) {
    connection.release();
    await lockClient.end();
    throw new Error('Another engine already owns the advisory lock');
  }
  setProcessingGuard(() => {
    if (lostLease) throw new Error('Engine advisory-lock connection was lost; processing stopped');
  });
  let failures = 0,
    lastImport = '',
    wasStale = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    await provider.start();
    await heartbeat('STARTING', 'Engine started; reconciling available history', provider.name);
    await enqueueServiceAlert(
      'ENGINE_RESTART',
      'Engine restarted; historical recovery runs before current quote evaluation',
      `restart:${randomUUID()}`,
    );
    while (!controller.signal.aborted) {
      try {
        // postgres.js may reconnect after a backend loss; PID mismatch proves this process lost its lease.
        const [lease] =
          await connection`select pg_backend_pid() as pid,exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted) as held`;
        if (lease?.pid !== leasePid || !lease?.held) {
          lostLease = true;
          throw new Error('Engine advisory lock was lost; refusing to process');
        }
        const now = clock(provider);
        const today = istDate(now);
        if (provider.name === 'yahoo' && today !== lastImport) {
          lastImport = today;
          try {
            log.info({ count: await refreshInstruments() }, 'NSE instrument list refreshed');
          } catch (error) {
            log.warn(
              { error: error instanceof Error ? error.message : 'Import failed' },
              'Using existing NSE instrument list; manual import is available',
            );
          }
        }
        const result = await runCycle(provider, now);
        if (result.status === 'STALE' && !wasStale) {
          await enqueueServiceAlert(
            'FEED_STALE',
            'Market data is stale or unavailable; check the dashboard for affected trades',
            `stale:${randomUUID()}`,
          );
        }
        wasStale = result.status === 'STALE';
        await deliverOutbox();
        failures = result.errors ? failures + 1 : 0;
        log.info(result, 'Worker cycle completed');
      } catch (error) {
        failures++;
        log.error(
          { error: error instanceof Error ? error.message : 'Worker failure' },
          'Worker cycle failed',
        );
        if (lostLease) throw error;
        await heartbeat('STALE', 'Worker error; retrying with backoff', provider.name).catch(
          () => {},
        );
      }
      const interval = Math.max(
        provider.name === 'fixture' ? 250 : 5_000,
        Number(process.env.POLL_INTERVAL_MS ?? 20_000),
      );
      await delay(Math.min(300_000, interval * 2 ** Math.min(failures, 4)), undefined, {
        signal: controller.signal,
      }).catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
    }
  } finally {
    setProcessingGuard();
    signal?.removeEventListener('abort', abort);
    await provider.stop();
    if (!lostLease) await heartbeat('STOPPED', 'Engine stopped', provider.name).catch(() => {});
    await connection`select pg_advisory_unlock(${ADVISORY_LOCK_ID})`.catch(() => {});
    connection.release();
    await lockClient.end({ timeout: 3 });
  }
}
