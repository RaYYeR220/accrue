import { expect, test, type Page } from '@playwright/test'
import { CHECK_SIAM, EVM_OWNER, LIVE_POOLS, mockApi, SIAM, SIAM_STAKER } from './fixtures'

const DEEP_LINK = 'https://nimpay.app/miniapps/open/localhost:4317'

const canvasHash = (page: Page) =>
  page.locator('canvas.orbit-canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let h = 0
    let ink = 0
    for (let i = 0; i < d.length; i += 4) {
      h = (h * 31 + d[i]! + d[i + 1]! * 7 + d[i + 2]! * 13 + d[i + 3]! * 17) | 0
      if (d[i + 3]! > 0) ink++
    }
    return { h, ink }
  })

test.describe('landing outside Nimiq Pay', () => {
  test('shows the claim and every "Open in Nimiq Pay" points at the deep link', async ({ page }) => {
    const chunks: string[] = []
    page.on('request', r => chunks.push(new URL(r.url()).pathname))
    await mockApi(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your NIM and dollars, earning.')
    const open = page.getByRole('link', { name: 'Open in Nimiq Pay' })
    await expect(open.first()).toBeVisible()
    for (const href of await open.evaluateAll(els => els.map(e => e.getAttribute('href')))) expect(href).toBe(DEEP_LINK)
    expect(await open.count()).toBe(3)
    // the wallet side is never downloaded on the landing
    expect(chunks.filter(p => /MiniApp-/.test(p))).toEqual([])
    await expect(page.getByText('Aave v3 on Polygon · 21 Nimiq pools · open source')).toBeVisible()
  })

  test('opens no dialog and calls no checker endpoint on load', async ({ page }) => {
    let dialogs = 0
    page.on('dialog', d => {
      dialogs++
      void d.dismiss()
    })
    const calls = await mockApi(page)
    await page.goto('/')
    await page.waitForTimeout(1500)
    expect(dialogs).toBe(0)
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    expect(calls.filter(p => /\/api\/(check|position)\//.test(p))).toEqual([])
  })

  test('without the API, the scoreboard shows the dated snapshot and no verdicts', async ({ page }) => {
    await mockApi(page, { pools: 'down' })
    await page.goto('/')
    const board = page.locator('.board')
    await expect(board).toHaveAttribute('data-source', 'snapshot')
    await expect(board).toContainText('Pool facts from the Nimiq validators API as of Nov 7, 2026')
    await expect(board.locator('tbody tr')).toHaveCount(21)
    await expect(board.getByText('Not enough data yet')).toHaveCount(21)
    await expect(board.locator('.vd-btn')).toHaveCount(0)
  })

  test('live pools replace the snapshot; each verdict opens its reasons', async ({ page }) => {
    await mockApi(page, { pools: 'live' })
    await page.goto('/')
    const board = page.locator('.board')
    await expect(board).toHaveAttribute('data-source', 'live')
    await expect(board.getByRole('heading', { name: 'All 6 listed pools' })).toBeVisible()
    for (const label of ['Paid as promised', 'Behind schedule', 'Short', 'Not enough data', 'No payouts by design', "Can't verify — routed elsewhere"]) {
      await expect(board.locator('.vd-btn', { hasText: label })).toHaveCount(1)
    }
    const why = board.getByRole('button', { name: /Why Siam Pool reads/ })
    await why.click()
    await expect(why).toHaveAttribute('aria-expanded', 'true')
    await expect(board.getByText('Paid 97.5% of earnings against 97.0% promised.')).toBeVisible()
    await expect(board.getByText('Paid 97.5% of earnings against 97% promised.')).toBeVisible()
  })

  test('tapping a pool on the scoreboard turns the orbit to it', async ({ page }) => {
    await mockApi(page, { pools: 'live' })
    await page.goto('/')
    await expect(page.locator('.board')).toHaveAttribute('data-source', 'live')
    await page.getByRole('button', { name: 'Show Siam Pool in the orbit above' }).click()
    await expect(page.getByRole('combobox', { name: 'All 6 pools' })).toHaveValue(SIAM)
    const desc = page.viewportSize()!.width <= 760 ? page.locator('.pline') : page.locator('.tip')
    await expect(desc).toContainText('Siam Pool')
    await expect(desc).toContainText('Payout Check: Paid as promised')
  })

  test('the checker gives a verdict for a NIM address', async ({ page }) => {
    await mockApi(page, { pools: 'live' })
    await page.goto('/')
    const input = page.getByLabel('Nimiq or Polygon address')
    await input.fill(SIAM_STAKER.toLowerCase())
    const req = page.waitForRequest(r => r.url().includes('/api/check/'))
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    expect(new URL((await req).url()).pathname).toBe('/api/check/NQ94UUV1JPTMXN2K5AH9SH6YMGUAMDHKF3ST')
    const out = page.locator('.checker-out')
    await expect(out.locator('.vd-lg')).toHaveText('Paid as promised')
    await expect(out).toContainText('Your payouts, last 7 days')
    await expect(out).toContainText('12.50')
    await expect(out).toContainText('12.40')
    await expect(out).toContainText('99.2%')
    await expect(out).toContainText('Siam Pool overall')
    await expect(out).toContainText('Paid 97.5% of earnings against 97.0% promised.')
  })

  test('without a verdict from the API the checker shows none, only "Not enough data yet"', async ({ page }) => {
    await mockApi(page, { pools: 'live', check: { ...CHECK_SIAM, verdict: undefined, pct: null, expectedLuna: undefined, receivedLuna: undefined } })
    await page.goto('/')
    await page.getByLabel('Nimiq or Polygon address').fill(SIAM_STAKER)
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    const badge = page.locator('.checker-out .vd-lg')
    await expect(badge).toHaveText('Not enough data yet')
    await expect(badge).toHaveAttribute('data-verdict', 'pending')
  })

  test('the checker shows the Aave position for a 0x address', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.getByLabel('Nimiq or Polygon address').fill(EVM_OWNER.toLowerCase())
    const req = page.waitForRequest(r => r.url().includes('/api/position/'))
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    expect(new URL((await req).url()).pathname).toBe(`/api/position/${EVM_OWNER}`)
    const out = page.locator('.checker-out')
    await expect(out).toContainText('Aave v3 on Polygon')
    await expect(out).toContainText('USDT0')
    await expect(out).toContainText('$12.35')
    await expect(out).toContainText('$12.00')
    await expect(out).toContainText('$0.35')
    await expect(out).not.toContainText('USDC')
  })

  test('the checker refuses bad input before asking the API', async ({ page }) => {
    const calls = await mockApi(page)
    await page.goto('/')
    const check = page.getByRole('button', { name: 'Check', exact: true })
    await check.click()
    await expect(page.getByRole('alert')).toHaveText('Paste an address first.')
    await page.getByLabel('Nimiq or Polygon address').fill('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3SU')
    await check.click()
    await expect(page.getByRole('alert')).toContainText('has a typo')
    await expect(page.getByLabel('Nimiq or Polygon address')).toHaveAttribute('aria-invalid', 'true')
    await page.getByLabel('Nimiq or Polygon address').fill('alice.eth')
    await check.click()
    await expect(page.getByRole('alert')).toContainText('Paste a Nimiq address (NQ…) or a Polygon address (0x…)')
    expect(calls.filter(p => /\/api\/(check|position)\//.test(p))).toEqual([])
  })

  test('the checker explains a not-staking address and a service failure', async ({ page }) => {
    await mockApi(page, { check: { staker: null, windowDays: 7 } })
    await page.goto('/')
    await page.getByLabel('Nimiq or Polygon address').fill(SIAM_STAKER)
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.locator('.checker-out')).toContainText('No stake on this address')

    await page.unroute('**/api/**')
    await mockApi(page, { checkStatus: 500, check: { error: 'INTERNAL' } })
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.locator('.checker-out')).toContainText("The Payout Check isn't answering right now")
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('the hero object is alive', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.waitForTimeout(600)
    const a = await canvasHash(page)
    await page.waitForTimeout(1000)
    const b = await canvasHash(page)
    expect(a.ink).toBeGreaterThan(1000)
    expect(b.h).not.toBe(a.h)
  })

  test('a pool claiming millions of stakers does not stall the hero', async ({ page }) => {
    const pools = { ...LIVE_POOLS, pools: LIVE_POOLS.pools.map((p, i) => (i === 0 ? { ...p, stakers: 5_000_000 } : p)) }
    await mockApi(page, { pools })
    await page.goto('/')
    await expect(page.locator('.board')).toHaveAttribute('data-source', 'live')
    await expect(page.locator('.board')).toContainText('5,000,000')
    const fps = await page.evaluate(
      () =>
        new Promise<number>(resolve => {
          let n = 0
          const t0 = performance.now()
          const tick = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(tick)) : resolve(n))
          requestAnimationFrame(tick)
        }),
    )
    // one dot per claimed staker would take seconds per frame; capped, the loop keeps running
    expect(fps).toBeGreaterThan(5)
    const a = await canvasHash(page)
    await page.waitForTimeout(500)
    expect((await canvasHash(page)).h).not.toBe(a.h)
  })

  test('with reduced motion the hero holds still', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mockApi(page)
    await page.goto('/')
    await page.waitForTimeout(800)
    const a = await canvasHash(page)
    await page.waitForTimeout(1000)
    const b = await canvasHash(page)
    expect(a.ink).toBeGreaterThan(1000)
    expect(b.h).toBe(a.h)
  })

  test('on a computer "Open in Nimiq Pay" shows a QR code of the deep link', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones follow the link into Nimiq Pay')
    await mockApi(page)
    await page.goto('/')
    const cta = page.locator('.hero').getByRole('link', { name: 'Open in Nimiq Pay' })
    await cta.click()
    const dialog = page.getByRole('dialog', { name: 'Scan to open in Nimiq Pay' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('img', { name: `QR code that opens ${DEEP_LINK}` })).toBeVisible()
    await expect(dialog.locator('svg[role="img"] path')).toHaveCount(1)
    await expect(dialog.getByRole('link', { name: 'Open the link on this device' })).toHaveAttribute('href', DEEP_LINK)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(cta).toBeFocused()
    // and the closing section carries the same code without a click
    await expect(page.locator('#open').getByRole('img', { name: `QR code that opens ${DEEP_LINK}` })).toBeAttached()
  })

  test('on a phone there is no QR, the link just opens Nimiq Pay', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'computers get the QR code')
    await mockApi(page)
    await page.goto('/')
    await expect(page.locator('.qr-inline')).toHaveCount(0)
    await expect(page.locator('.hero').getByRole('link', { name: 'Open in Nimiq Pay' })).toHaveAttribute('href', DEEP_LINK)
  })

  test('speaks German with ?lang=de', async ({ page }) => {
    await mockApi(page)
    await page.goto('/?lang=de')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deine NIM und Dollar, am Arbeiten.')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.getByRole('link', { name: 'In Nimiq Pay öffnen' }).first()).toHaveAttribute('href', DEEP_LINK)
    await expect(page.locator('.board')).toContainText('Noch zu wenig Daten')
  })
})

test('inside Nimiq Pay the landing is never downloaded', async ({ page }) => {
  const files: string[] = []
  page.on('request', r => files.push(new URL(r.url()).pathname))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'nimiqPay', { value: { language: 'en', userFiat: 'USD' }, configurable: true })
  })
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  expect(files.some(f => /\/assets\/MiniApp-/.test(f))).toBe(true)
  expect(files.filter(f => /\/assets\/Landing-|\/fonts\/GeistMono/.test(f))).toEqual([])
})
