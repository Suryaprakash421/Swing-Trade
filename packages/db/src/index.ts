import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export const sql = postgres(
  process.env.DATABASE_URL ?? 'postgres://papertrade:papertrade@127.0.0.1:5432/papertrade',
  {
    max: Number(process.env.DB_POOL_SIZE ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  },
);
export type Database = typeof sql;

/** Transactional, checksum-checked migrations safe for simultaneous API/worker start. */
export async function migrate(database = sql): Promise<void> {
  const directory = new URL('../migrations/', import.meta.url);
  const filenames = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  await database.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(761923420)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    for (const name of filenames) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const [existing] = await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Migration ${name} was modified after application`);
        continue;
      }
      await tx.unsafe(source);
      await tx`INSERT INTO schema_migrations (name,checksum) VALUES (${name},${checksum})`;
    }
  });
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** CSV parsing handles the NSE quoted company-name fields and CRLF downloads. */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let value = '',
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push([...row]);
      row.length = 0;
      value = '';
    } else value += c;
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  if (value || row.length) {
    row.push(value.trim());
    if (row.some(Boolean)) rows.push([...row]);
  }
  return rows;
}

/** Import the official EQUITY_L.csv download; only normal EQ series are in v1. */
export async function importNseInstruments(csv: string, database = sql): Promise<number> {
  const [headers, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (!headers) throw new Error('Instrument CSV is empty');
  const index = (column: string) => headers.findIndex((v) => v.trim().toUpperCase() === column);
  const symbolIndex = index('SYMBOL'),
    nameIndex = index('NAME OF COMPANY'),
    seriesIndex = index('SERIES');
  if (symbolIndex < 0 || nameIndex < 0 || seriesIndex < 0)
    throw new Error('Expected NSE SYMBOL, NAME OF COMPANY and SERIES CSV columns');
  const records = rows
    .filter((row) => row[seriesIndex] === 'EQ')
    .map((row) => ({
      symbol: row[symbolIndex]!,
      name: row[nameIndex]!,
      yahoo_symbol: `${row[symbolIndex]}.NS`,
      active: true,
    }))
    .filter((row) => /^[A-Z0-9&_.-]{1,40}$/.test(row.symbol) && row.name.length > 0);
  if (records.length === 0) throw new Error('Instrument CSV contains no valid EQ symbols');
  await database.begin(async (tx) => {
    for (let offset = 0; offset < records.length; offset += 200) {
      await tx`INSERT INTO instruments ${tx(records.slice(offset, offset + 200), 'symbol', 'name', 'yahoo_symbol', 'active')}
        ON CONFLICT (symbol) DO UPDATE SET name=excluded.name,yahoo_symbol=excluded.yahoo_symbol,active=true,updated_at=now()`;
    }
  });
  return records.length;
}

export interface MarketSessionInput {
  date: string;
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  description?: string;
  reviewRequired?: boolean;
  source: string;
}
export async function importMarketSessions(
  entries: MarketSessionInput[],
  database = sql,
): Promise<number> {
  for (const entry of entries) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`))
    )
      throw new Error('Invalid calendar date');
    if (!entry.source?.trim()) throw new Error('Calendar source is required');
    for (const time of [entry.openTime ?? '09:15', entry.closeTime ?? '15:30']) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid market session time');
    }
    if ((entry.openTime ?? '09:15') >= (entry.closeTime ?? '15:30'))
      throw new Error('Market session must close after opening');
  }
  await database.begin(async (tx) => {
    for (const entry of entries)
      await tx`INSERT INTO market_sessions (date,is_open,open_time,close_time,description,source,review_required)
      VALUES (${entry.date},${entry.isOpen},${entry.openTime ?? '09:15'},${entry.closeTime ?? '15:30'},${entry.description ?? ''},${entry.source},${entry.reviewRequired ?? false})
      ON CONFLICT (date) DO UPDATE SET is_open=excluded.is_open,open_time=excluded.open_time,close_time=excluded.close_time,description=excluded.description,source=excluded.source,review_required=excluded.review_required`;
  });
  return entries.length;
}

/** Checking explicit annual coverage avoids silently assuming an empty calendar is valid. */
export async function calendarCoverage(
  year: number,
  database = sql,
): Promise<{ verified: boolean; source: string | null; verifiedAt: Date | null }> {
  const [row] =
    await database`SELECT source,verified_at FROM market_calendar_years WHERE year=${year}`;
  return { verified: !!row, source: row?.source ?? null, verifiedAt: row?.verified_at ?? null };
}
