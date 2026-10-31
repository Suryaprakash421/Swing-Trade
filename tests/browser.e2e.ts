import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { sql } from '@paper/db';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const username = `browser_${suffix}`;
const otherUsername = `other_${suffix}`;
const password = 'Browser-test-password-2026!';
const screenshotDirectory = '.local/screenshots';

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}
async function signup(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create your account', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation', exact: true }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  // Explicit test data only; no invented market values are shipped to users.
  const priorSession = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  await sql`insert into market_sessions(date,is_open,description,source) values(${today},false,'Explicit isolated browser test closure','https://example.invalid/browser-fixture')
    on conflict(date) do update set is_open=false,description=excluded.description,source=excluded.source`;
  await sql`insert into market_calendar_years(year,source) values(${Number(today.slice(0, 4))},'https://example.invalid/browser-fixture') on conflict(year) do nothing`;
  await sql`insert into latest_quotes(symbol,ltp,market_at,received_at,provider,delayed)
    values('SBIN',100,${priorSession},now(),'fixture',false)
    on conflict(symbol) do update set ltp=100,market_at=excluded.market_at,received_at=now(),provider='fixture',delayed=false`;
  await sql`insert into engine_state(id,heartbeat_at,status,message,provider)
    values(1,now(),'IDLE','Explicit browser test fixture; market is closed','fixture')
    on conflict(id) do update set heartbeat_at=now(),status='IDLE',message=excluded.message,provider='fixture'`;
});
test.afterAll(async () => {
  await sql`delete from users where username in ${sql([username, otherUsername])}`;
  await sql`delete from latest_quotes where symbol='SBIN' and provider='fixture'`;
  await sql`delete from engine_state where provider='fixture'`;
  await sql`delete from market_sessions where source='https://example.invalid/browser-fixture'`;
  await sql`delete from market_calendar_years where source='https://example.invalid/browser-fixture'`;
  await sql.end({ timeout: 2 });
});

test('desktop signup, queued trade, account isolation, cancel, settings, logout and login', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDirectory}/login-desktop.png`, fullPage: true });
  await signup(page, username);
  await expect(page.getByText('Available cash', { exact: true }).first()).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `${screenshotDirectory}/overview-desktop.png`, fullPage: true });
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'New trade' })
    .click();
  const search = page.getByRole('textbox', { name: 'Search NSE instruments' });
  await search.fill('SBIN');
  await page.getByRole('button').filter({ hasText: 'State Bank of India' }).click();
  await page.getByPlaceholder('Number of shares').fill('10');
  await page.getByPlaceholder('Your upside').fill('120');
  await page.getByPlaceholder('Your safety net').fill('90');
  await page.getByPlaceholder('e.g. Breakout, Pullback, Momentum').fill('Browser test');
  await page
    .getByPlaceholder('What do you see? What would change your mind?')
    .fill('Explicit fixture-based browser test.');
  await page.screenshot({ path: `${screenshotDirectory}/trade-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Place paper trade', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Pending', { exact: true })).toBeVisible();
  const ownTrade = await page.request.get('/api/trades');
  const tradeId = (await ownTrade.json()).trades[0].id;

  const secondContext = await browser.newContext({
    baseURL: process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:3100',
  });
  const secondPage = await secondContext.newPage();
  await signup(secondPage, otherUsername);
  const secondTrades = await secondPage.request.get('/api/trades');
  expect((await secondTrades.json()).trades).toEqual([]);
  expect((await secondPage.request.get(`/api/trades/${tradeId}`)).status()).toBe(404);
  await secondContext.close();

  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Cancel/ })
    .first()
    .click();
  // Confirm when the interface presents a confirmation action.
  const confirmCancel = page
    .getByRole('dialog')
    .getByRole('button', { name: /Confirm cancellation/ });
  if (await confirmCancel.isVisible()) await confirmCancel.click();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/trades/${tradeId}`)).json()).trade.status,
    )
    .toBe('CANCELLED');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Journal' })
    .click();
  await noOverflow(page);
  await page.screenshot({ path: `${screenshotDirectory}/journal-desktop.png`, fullPage: true });
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Insights' })
    .click();
  await noOverflow(page);
  await page.screenshot({ path: `${screenshotDirectory}/insights-desktop.png`, fullPage: true });
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByLabel('Simulated slippage', { exact: false }).fill('0');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  await page.getByRole('button', { name: 'Reset my virtual account' }).click();
  await page.getByPlaceholder('RESET', { exact: true }).fill('RESET');
  await page.getByRole('button', { name: 'Confirm account reset' }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/trades')).json()).trades.length)
    .toBe(0);
  await page.getByRole('button', { name: 'Log out', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Step into your portfolio' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile screens remain usable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await noOverflow(page);
  await page.screenshot({ path: `${screenshotDirectory}/login-mobile.png`, fullPage: true });
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Step into your portfolio' }).click();
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation', exact: true });
  await expect(mobileNav).toBeVisible();
  for (const label of ['Home', 'New trade', 'Journal', 'Insights', 'Settings']) {
    await mobileNav.getByRole('button', { name: label, exact: true }).click();
    await noOverflow(page);
    await page.screenshot({
      path: `${screenshotDirectory}/${label.toLowerCase().replaceAll(' ', '-')}-mobile.png`,
      fullPage: true,
    });
  }
});
