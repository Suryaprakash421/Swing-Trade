import { describe, expect, it } from 'vitest';
import { parseCsv } from './index.js';
import { readFile } from 'node:fs/promises';
import { marketSession } from '@paper/core';

describe('official instrument CSV parser', () => {
  it('handles BOM separately at importer, quoted commas, escaped quotes and CRLF', () => {
    expect(
      parseCsv('SYMBOL,NAME OF COMPANY,SERIES\r\nABC,"Acme, India ""Limited""",EQ\r\n'),
    ).toEqual([
      ['SYMBOL', 'NAME OF COMPANY', 'SERIES'],
      ['ABC', 'Acme, India "Limited"', 'EQ'],
    ]);
  });
  it('handles a final row without newline and ignores blank rows', () => {
    expect(parseCsv('a,b\n\n c,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('rejects truncated quoted downloads instead of importing bad instruments', () => {
    expect(() => parseCsv('a,"unterminated')).toThrow('unterminated');
  });
});

describe('reviewed NSE 2026 calendar', () => {
  it('seeds every reviewed closure, including the subsequently amended election holiday', async () => {
    const calendar = JSON.parse(
      await readFile(new URL('../calendars/nse-2026.json', import.meta.url), 'utf8'),
    );
    const migration = await readFile(
      new URL('../migrations/006_seed_nse_2026_calendar.sql', import.meta.url),
      'utf8',
    );
    expect(calendar.year).toBe(2026);
    expect(calendar.source).toBe(
      'https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',
    );
    expect(calendar.additionalSources).toContain(
      'https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf',
    );
    expect(calendar.sessions).toHaveLength(20);
    for (const session of calendar.sessions)
      expect(migration).toContain(`('${session.date}',false,`);
    expect(marketSession(new Date('2026-01-15T05:00:00Z'), calendar.sessions).open).toBe(false);
    expect(marketSession(new Date('2026-11-10T05:00:00Z'), calendar.sessions).open).toBe(false);
    expect(marketSession(new Date('2026-11-02T05:00:00Z'), calendar.sessions).open).toBe(true);
    expect(marketSession(new Date('2026-11-08T13:00:00Z'), calendar.sessions)).toMatchObject({
      open: false,
      calendarReviewRequired: true,
    });
  });
});
