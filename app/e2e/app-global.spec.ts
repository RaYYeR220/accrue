import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { asset, callsBeforeFirstTap, connectPolygon, open, providerCalls, SCENARIOS, sheet, start, tab } from './app'

const TABS = ['Home', 'Dollars', 'NIM', 'Payouts', 'Activity'] as const
const CONTROLS = 'button, a, input, select, textarea, [role="button"], summary'

// A control inside a <label> is hit through the whole label, so that is the size that counts.
async function undersized(page: Page) {
  return page.locator(CONTROLS).evaluateAll(els =>
    els.flatMap(el => {
      const target = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label')! : el
      const r = target.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (!r.width || !r.height || s.visibility === 'hidden' || el.closest('dialog:not([open])') || el.closest('.sr-only')) return []
      // the page behind an open sheet is inert
      const open = document.querySelector('dialog[open]')
      if (open && !open.contains(el)) return []
      return r.width < 43.5 || r.height < 43.5 ? [`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`] : []
    }),
  )
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

async function serious(page: Page) {
  const r = await new AxeBuilder({ page }).analyze()
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
}

// A sheet fades in; contrast is judged once it has, not halfway through.
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getTiming().iterations === Infinity || a.playState !== 'running'))

// Every screen and the sheets that hold the flows, each checked by `check`.
async function everyState(page: Page, run: (where: string) => Promise<void>) {
  const check = async (where: string) => {
    await settled(page)
    await run(where)
  }
  await check('start')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  for (const name of TABS) {
    await tab(page, name)
    if (name === 'Dollars' && (await page.getByRole('button', { name: 'Connect Polygon wallet' }).count())) await connectPolygon(page)
    await check(name)
  }
  await page.getByRole('link', { name: 'About, risks and privacy' }).click()
  await expect(page.getByRole('heading', { name: 'About Accrue' })).toBeVisible()
  await check('About')

  await tab(page, 'Dollars')
  await asset(page, 'USDT').getByRole('button', { name: 'Deposit', exact: true }).click()
  const d = sheet(page, 'Deposit USDT')
  await d.getByLabel('Amount to deposit').fill('1')
  await check('deposit amount')
  await d.getByRole('button', { name: 'Review' }).click()
  await expect(d.getByRole('button', { name: 'Switch to Polygon' })).toBeVisible()
  await check('deposit review')
  await d.getByRole('button', { name: 'Change amount' }).click()
  await d.getByRole('button', { name: 'Close' }).click()

  await tab(page, 'NIM')
  await page.getByRole('button', { name: 'Switch pool' }).click()
  await expect(sheet(page, 'Switch pool').getByRole('list', { name: 'The plan' })).toBeVisible()
  await check('switch sheet')
  await sheet(page, 'Switch pool').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Unstake', exact: true }).click()
  await sheet(page, 'Unstake NIM').getByRole('button', { name: 'All', exact: true }).click()
  await check('unstake sheet')
}

test.describe('in the app, in every scenario', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario}: nothing asks the wallet, and no dialog opens, before the first tap`, async ({ page }) => {
      let dialogs = 0
      page.on('dialog', d => {
        dialogs++
        void d.dismiss()
      })
      await open(page, scenario)
      await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
      await page.waitForTimeout(1_500)
      expect(await providerCalls(page)).toEqual([])
      expect(await page.locator('dialog[open]').count()).toBe(0)
      // after Start, and after reopening with the addresses remembered
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
      await page.waitForTimeout(1_500)
      expect(await callsBeforeFirstTap(page)).toBe(0)
      expect(await page.locator('dialog[open]').count()).toBe(0)
      expect(dialogs).toBe(0)
    })
  }

  test('one tap never opens two wallet dialogs: Start reads NIM only, Polygon is its own tap', async ({ page }) => {
    await open(page, 'happy')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
    expect((await providerCalls(page)).filter(m => m.startsWith('eth_'))).toEqual([])
    await tab(page, 'Dollars')
    await connectPolygon(page)
    expect((await providerCalls(page)).filter(m => m.startsWith('eth_'))).toEqual(['eth_requestAccounts'])
  })
})

test.describe('in-app layout and accessibility', () => {
  test('no horizontal scroll on any screen or sheet', async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, 'happy')
    await everyState(page, async where => {
      expect(await overflow(page), where).toBeLessThanOrEqual(0)
    })
  })

  test('every control is at least 44×44', async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, 'happy')
    await everyState(page, async where => {
      expect(await undersized(page), where).toEqual([])
    })
  })

  test('axe finds nothing serious or critical', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 'happy')
    await everyState(page, async where => {
      expect(await serious(page), where).toEqual([])
    })
  })

  test('the tab bar stays clear of the system bar', async ({ page }) => {
    await start(page, 'happy')
    const bar = page.getByRole('navigation', { name: 'Sections' })
    const pad = await bar.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom))
    expect(pad).toBeGreaterThanOrEqual(14)
    const box = (await bar.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5)
  })
})
