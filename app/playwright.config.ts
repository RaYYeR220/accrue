import { defineConfig } from '@playwright/test'

const PORT = 4317

// The landing runs against the production build (`vite preview`); /api/* is answered per test
// with page.route, so no worker is needed.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
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
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  projects: [
    {
      name: 'mobile-375',
      testMatch: /(landing|a11y)\.spec\.ts/,
      use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
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
    // a timing budget under 4x CPU throttling is machine-dependent, so it only runs on request:
    // PERF=1 pnpm e2e --project perf-375
    ...(process.env.PERF
      ? [
          {
            name: 'perf-375',
            testMatch: /perf\.spec\.ts/,
            use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
          },
        ]
      : []),
  ],
})
