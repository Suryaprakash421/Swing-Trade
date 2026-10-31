import { readFile } from 'node:fs/promises';
import { sql, closeDb } from '@paper/db';

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('Unterminated CSV quotation.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node --import tsx scripts/import-instruments.ts EQUITY_L.csv');
  const rows = parseCsv((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const header = rows.shift()?.map((cell) => cell.toUpperCase());
  const symbolIndex = header?.indexOf('SYMBOL') ?? -1;
  const nameIndex = header?.indexOf('NAME OF COMPANY') ?? -1;
  const seriesIndex = header?.indexOf('SERIES') ?? -1;
  const tickIndex = header?.indexOf('TICK SIZE') ?? -1;
  if (symbolIndex < 0 || nameIndex < 0)
    throw new Error('Expected NSE EQUITY_L.csv with SYMBOL and NAME OF COMPANY columns.');
  const instruments = rows
    .filter((row) => seriesIndex < 0 || row[seriesIndex] === 'EQ')
    .map((row) => {
      const symbol = row[symbolIndex],
        name = row[nameIndex];
      const tick = tickIndex >= 0 && row[tickIndex] ? row[tickIndex] : '0.05';
      if (
        !symbol ||
        !/^[A-Z0-9&._-]{1,30}$/.test(symbol) ||
        !name ||
        name.length > 200 ||
        !/^\d+(\.\d{1,4})?$/.test(tick) ||
        Number(tick) <= 0
      )
        throw new Error('Invalid instrument row; no rows were imported.');
      return { symbol, name, tick };
    });
  if (!instruments.length) throw new Error('No NSE EQ instruments found.');
  await sql.begin(async (tx) => {
    for (const row of instruments)
      await tx`insert into instruments (symbol, name, yahoo_symbol, tick_size, active)
      values (${row.symbol}, ${row.name}, ${`${row.symbol}.NS`}, ${row.tick}, true)
      on conflict (symbol) do update set name = excluded.name, yahoo_symbol = excluded.yahoo_symbol,
        tick_size = excluded.tick_size, active = true`;
  });
  console.info(
    `Imported ${instruments.length} NSE EQ instruments. Existing positions and absent symbols were preserved.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Instrument import failed.');
  process.exitCode = 1;
} finally {
  await closeDb();
}
