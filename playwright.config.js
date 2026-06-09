// Playwright config for the jx3-web-map-viewer test suite.
//
// Tests assume the server is already running on http://localhost:3015.
// We do NOT use Playwright's webServer block here because the project's
// `node server.js` writes a permanent log and is normally already running
// for the developer's manual debugging workflow.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.(js|mjs|ts)$/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:3015',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
