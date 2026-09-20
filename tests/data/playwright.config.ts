import { defineConfig } from '@playwright/test';

/** Live data checks against Mapterhorn. Manual only; see CLAUDE.md. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  retries: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/data' }]] : 'list',
  outputDir: '../../test-results/data',
  use: {
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  },
});
