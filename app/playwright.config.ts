import { defineConfig } from '@playwright/test'

const PORT = 4317
const MOCK_PORT = 4319

const phone = { deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const APP_SPECS = /(home|dollars|nim|payout|activity|app-global)\.spec\.ts/

// The landing runs against the production build (`vite preview`); /api/* is answered per test
// with page.route, so no worker is needed. The in-app screens run against the mock build
// (`build:mock`), where ?mock=<scenario> stands in for Nimiq Pay, its wallet and the API.
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm run build && pnpm exec vite preview --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      command: `pnpm run build:mock && pnpm exec vite preview --mode mock --port ${MOCK_PORT} --strictPort`,
      url: `http://localhost:${MOCK_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
  projects: [
    {
      name: 'mobile-375',
      testMatch: /(landing|a11y)\.spec\.ts/,
      use: { viewport: { width: 375, height: 812 }, ...phone },
    },
    {
      name: 'desktop-1440',
      testMatch: /(landing|a11y)\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'wide-1920',
      testMatch: /(landing|a11y)\.spec\.ts/,
      use: { viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'app-375',
      testMatch: APP_SPECS,
      use: { baseURL: `http://localhost:${MOCK_PORT}`, viewport: { width: 375, height: 812 }, ...phone },
    },
    {
      name: 'app-430',
      testMatch: APP_SPECS,
      use: { baseURL: `http://localhost:${MOCK_PORT}`, viewport: { width: 430, height: 932 }, ...phone },
    },
    // a timing budget under 4x CPU throttling is machine-dependent, so it only runs on request:
    // PERF=1 pnpm e2e --project perf-375
    ...(process.env.PERF
      ? [
          {
            name: 'perf-375',
            testMatch: /perf\.spec\.ts/,
            use: { viewport: { width: 375, height: 812 }, ...phone },
          },
        ]
      : []),
  ],
})
