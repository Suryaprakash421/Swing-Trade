import { readFile } from 'node:fs/promises';
import { sql, closeDb } from '@paper/db';

type Session = {
  date: string;
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  description: string;
};
type Calendar = { source: string; year: number; sessions: Session[] };
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

try {
  const file = process.argv[2];
  if (!file || process.argv[3] !== '--source-reviewed')
    throw new Error(
      'Usage: node --import tsx scripts/import-calendar.ts calendar.json --source-reviewed',
    );
  const calendar = JSON.parse(await readFile(file, 'utf8')) as Calendar;
  if (!Number.isInteger(calendar.year) || calendar.year < 2020 || calendar.year > 2100)
    throw new Error('Invalid calendar year.');
  if (typeof calendar.source !== 'string' || !calendar.source.startsWith('https://'))
    throw new Error('Provide the HTTPS source used to verify the calendar.');
  new URL(calendar.source);
  if (!Array.isArray(calendar.sessions) || calendar.sessions.length > 366)
    throw new Error('Provide at most one session override per date.');
  const dates = new Set<string>();
  for (const entry of calendar.sessions) {
    if (
      typeof entry.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      !entry.date.startsWith(`${calendar.year}-`) ||
      new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10) !== entry.date
    )
      throw new Error(`Invalid date: ${entry.date}`);
    if (dates.has(entry.date)) throw new Error(`Duplicate date: ${entry.date}`);
    dates.add(entry.date);
    if (
      typeof entry.isOpen !== 'boolean' ||
      typeof entry.description !== 'string' ||
      entry.description.length > 500
    )
      throw new Error(`Invalid session: ${entry.date}`);
    const open = entry.openTime ?? '09:15',
      close = entry.closeTime ?? '15:30';
    if (!timePattern.test(open) || !timePattern.test(close) || open >= close)
      throw new Error(`Invalid session times: ${entry.date}`);
  }
  await sql.begin(async (tx) => {
    for (const entry of calendar.sessions) {
      await tx`insert into market_sessions (date, is_open, open_time, close_time, description, source)
        values (${entry.date}, ${entry.isOpen}, ${entry.openTime ?? '09:15'}, ${entry.closeTime ?? '15:30'}, ${entry.description}, ${calendar.source})
        on conflict (date) do update set is_open = excluded.is_open, open_time = excluded.open_time,
          close_time = excluded.close_time, description = excluded.description, source = excluded.source`;
    }
  });
  console.info(
    `Imported ${calendar.sessions.length} reviewed session overrides for ${calendar.year}. Weekdays without overrides retain normal hours.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Calendar import failed.');
  process.exitCode = 1;
} finally {
  await closeDb();
}
