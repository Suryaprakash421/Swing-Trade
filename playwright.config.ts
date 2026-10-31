import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  timeout: 45000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:3100',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
