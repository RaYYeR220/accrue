import { expect, test } from '@playwright/test'
import { mockApi } from './fixtures'

// Only with PERF=1 (see playwright.config.ts); run it on its own so parallel tests don't skew it.
// Lighthouse's mobile profile: 150 ms RTT, 1.6 Mbps down, 750 kbps up, 4x CPU slowdown.
test('first contentful hero on a throttled phone profile', async ({ browser }, info) => {
  test.setTimeout(90_000)
  const runs: { fcp: number; lcp: number; el: string }[] = []
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    await mockApi(page)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto('/', { waitUntil: 'load' })
    await page.waitForTimeout(2500)
    runs.push(
      await page.evaluate(
        () =>
          new Promise<{ fcp: number; lcp: number; el: string }>(resolve => {
            new PerformanceObserver(list => {
              const e = list.getEntries().at(-1) as PerformanceEntry & { element?: Element }
              const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1
              resolve({ fcp: Math.round(fcp), lcp: Math.round(e.startTime), el: e.element ? `${e.element.tagName.toLowerCase()}#${e.element.id}` : '?' })
            }).observe({ type: 'largest-contentful-paint', buffered: true })
          }),
      ),
    )
    await ctx.close()
  }
  const median = [...runs].sort((a, b) => a.lcp - b.lcp)[1]!
  const line = `LCP ${runs.map(r => r.lcp).join(' / ')} ms (median ${median.lcp}), FCP ${runs.map(r => r.fcp).join(' / ')} ms, element ${median.el}`
  info.annotations.push({ type: 'lcp', description: line })
  expect(median.el, line).toBe('h1#hero-title')
  expect(median.lcp, line).toBeLessThan(2500)
})
