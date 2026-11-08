import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CHECK_LONG, CHECK_UNLISTED_LONG, LONG_NAME, LONG_POOLS, LONG_TOKEN, mockApi, SIAM_STAKER } from './fixtures'

const CONTROLS = 'button, a.btn, select, input, textarea, [role="button"], summary'

async function undersized(page: Page) {
  return page.locator(CONTROLS).evaluateAll(els =>
    els.flatMap(el => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (!r.width || !r.height || s.visibility === 'hidden' || el.closest('dialog:not([open])')) return []
      const tooSmall = r.width < 43.5 || r.height < 43.5
      return tooSmall ? [`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`] : []
    }),
  )
}

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y)
      await new Promise(r => setTimeout(r, 30))
    }
    scrollTo(0, 0)
  })
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

async function showCheckerResult(page: Page) {
  await page.getByLabel('Nimiq or Polygon address').fill(SIAM_STAKER)
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(page.locator('.checker-out .vd-lg')).toBeVisible()
}

test.describe('landing accessibility', () => {
  test('no horizontal scroll, with the snapshot and with live data and a result open', async ({ page }) => {
    await mockApi(page, { pools: 'down' })
    await page.goto('/')
    await scrollThrough(page)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

    await page.unroute('**/api/**')
    await mockApi(page, { pools: 'live' })
    await page.goto('/')
    await expect(page.locator('.board')).toHaveAttribute('data-source', 'live')
    await page.getByRole('button', { name: /Why Mint Pool reads/ }).click()
    await showCheckerResult(page)
    await scrollThrough(page)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test('no horizontal scroll when the API sends long unbroken strings', async ({ page }) => {
    await mockApi(page, { pools: LONG_POOLS, check: CHECK_UNLISTED_LONG })
    await page.goto('/')
    await expect(page.locator('.board')).toHaveAttribute('data-source', 'live')
    await page.getByRole('button', { name: new RegExp(`Why ${LONG_NAME} reads`) }).click()
    await expect(page.getByText(LONG_TOKEN)).toBeVisible()
    await page.getByLabel('Nimiq or Polygon address').fill(SIAM_STAKER)
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.locator('.checker-out')).toContainText('Staked outside the listed pools')
    await scrollThrough(page)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

    await page.unroute('**/api/**')
    await mockApi(page, { pools: LONG_POOLS, check: CHECK_LONG })
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.locator('.checker-out').getByText(LONG_TOKEN)).toBeVisible()
    await page.getByRole('button', { name: new RegExp(`Show ${LONG_NAME} in the orbit`) }).click()
    await page.waitForTimeout(800)
    await scrollThrough(page)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  })

  test('every control is at least 44 × 44 px', async ({ page }) => {
    await mockApi(page, { pools: 'live' })
    await page.goto('/')
    await expect(page.locator('.board')).toHaveAttribute('data-source', 'live')
    await showCheckerResult(page)
    expect(await undersized(page)).toEqual([])
  })

  test('the QR dialog controls are 44 px too', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the QR dialog is for computers')
    await mockApi(page)
    await page.goto('/')
    await page.locator('.hero').getByRole('link', { name: 'Open in Nimiq Pay' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await undersized(page)).toEqual([])
  })

  for (const state of ['snapshot', 'live'] as const) {
    test(`axe finds nothing serious or critical (${state} data)`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await mockApi(page, { pools: state === 'live' ? 'live' : 'down' })
      await page.goto('/')
      await expect(page.locator('.board')).toHaveAttribute('data-source', state)
      if (state === 'live') {
        await page.getByRole('button', { name: /Why Siam Pool reads/ }).click()
        await showCheckerResult(page)
      }
      const res = await new AxeBuilder({ page }).analyze()
      const bad = res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 4).join(' | ')}`)).toEqual([])
    })
  }

  test('axe finds nothing serious or critical with the QR dialog open', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the QR dialog is for computers')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mockApi(page)
    await page.goto('/')
    await page.locator('.hero').getByRole('link', { name: 'Open in Nimiq Pay' }).click()
    await expect(page.getByRole('dialog').getByRole('img')).toBeVisible()
    const res = await new AxeBuilder({ page }).analyze()
    const bad = res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    expect(bad.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 4).join(' | ')}`)).toEqual([])
  })
})
