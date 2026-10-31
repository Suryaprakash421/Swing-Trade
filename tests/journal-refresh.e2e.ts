import { expect, test } from '@playwright/test';

for (const populated of [false, true]) {
  test(`journal keeps ${populated ? 'trade rows' : 'empty content'} visible during refresh`, async ({
    page,
  }) => {
    const trade = {
      id: 'journal-trade',
      symbol: 'SBIN',
      qty: 1,
      status: 'CLOSED',
      setupTag: '',
      createdAt: '2026-10-30T06:00:00Z',
      entryPrice: '100.00',
      exitPrice: '110.00',
      netPnl: '10.00',
      exitReason: 'TARGET',
    };
    let trades = populated ? [trade] : [];
    const requests = { account: 0, trades: 0, journal: 0, stats: 0, curve: 0 };
    let holdJournal: Promise<void> | null = null;
    let releaseJournal = () => {};
    const hold = () => {
      holdJournal = new Promise<void>((resolve) => {
        releaseJournal = resolve;
      });
    };
    await page.addInitScript(() => {
      const streams: EventTarget[] = [];
      (window as any).__streams = streams;
      Object.defineProperty(window, 'EventSource', {
        value: class extends EventTarget {
          constructor() {
            super();
            streams.push(this);
          }
          close() {
            streams.splice(streams.indexOf(this), 1);
          }
        },
      });
    });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let body: unknown;
      switch (url.pathname) {
        case '/api/auth/me':
          body = { user: { id: 'user', username: 'refresh-test' }, accountId: 'account' };
          break;
        case '/api/account':
          requests.account++;
          body = { marketOpen: false, feed: { status: 'IDLE', provider: 'test' } };
          break;
        case '/api/trades':
          if (url.search) {
            requests.journal++;
            if (holdJournal) await holdJournal;
          } else requests.trades++;
          body = { trades };
          break;
        case '/api/stats':
          requests.stats++;
          body = {};
          break;
        case '/api/stats/equity-curve':
          requests.curve++;
          body = { points: [] };
          break;
        default:
          throw new Error(`Unexpected API request: ${url.pathname}`);
      }
      await route.fulfill({ json: body });
    });
    await page.clock.install();
    await page.goto('/#journal');
    const content = populated
      ? page.getByRole('table')
      : page.getByText('A fresh page, ready for your story', { exact: true });
    await expect(content).toBeVisible();
    const original = await content.elementHandle();
    const initial = { ...requests };
    const emit = (name: string) =>
      page.evaluate((name) => {
        for (const stream of (window as any).__streams) stream.dispatchEvent(new Event(name));
      }, name);

    await emit('feed_status');
    await page.clock.runFor(600);
    await expect.poll(() => requests.account).toBe(initial.account + 1);
    expect(requests.journal).toBe(initial.journal);
    expect(requests.trades).toBe(initial.trades);
    expect(requests.stats).toBe(initial.stats);

    await emit('price');
    await page.clock.runFor(600);
    await expect.poll(() => requests.trades).toBe(initial.trades + 1);
    expect(requests.journal).toBe(initial.journal);
    expect(requests.stats).toBe(initial.stats);
    expect(requests.curve).toBe(initial.curve);

    hold();
    await page.clock.fastForward(20000);
    await page.clock.runFor(300);
    await expect.poll(() => requests.journal).toBe(initial.journal + 1);
    await expect(content).toBeVisible();
    await expect(page.getByText('Gathering your trades…')).toBeHidden();
    releaseJournal();
    holdJournal = null;
    await expect(content).toBeVisible();
    expect(await content.evaluate((node, original) => node === original, original)).toBe(true);

    // A trade event must still fetch and display changed results.
    trades = [{ ...trade, symbol: 'TCS' }];
    await emit('trade_updated');
    await page.clock.runFor(900);
    await expect(page.getByRole('table').getByText('TCS', { exact: true })).toBeVisible();

    // Filter changes use the main loader, unlike background refreshes.
    hold();
    await page.getByRole('button', { name: 'Open positions', exact: true }).click();
    await expect(page.getByText('Gathering your trades…')).toBeVisible();
    releaseJournal();
    holdJournal = null;
    await expect(page.getByText('Gathering your trades…')).toBeHidden();
  });
}
