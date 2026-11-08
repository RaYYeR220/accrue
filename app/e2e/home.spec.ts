import { expect, test } from '@playwright/test'
import { connectPolygon, start, tab } from './app'

const hero = (page: import('@playwright/test').Page) => page.getByRole('region', { name: /^Earning now/ })

test.describe('Home', () => {
  test('the total adds only what is known and says which side is missing', async ({ page }) => {
    await start(page, 'happy')
    // NIM read, Polygon not connected yet
    await expect(hero(page).getByText('NIM only. Connect Polygon below to add your dollars.')).toBeVisible()
    await expect(hero(page).getByText('$0.30').first()).toBeVisible()

    await tab(page, 'Dollars')
    await connectPolygon(page)
    await tab(page, 'Home')
    await expect(hero(page).getByText(/^NIM only|^Dollars only/)).toHaveCount(0)
    await expect(hero(page).getByText(/\$100\.\d+/).first()).toBeVisible()

    // reopened: dollars come back without a tap, NIM needs one
    await page.reload()
    await expect(hero(page).getByText('Dollars only. Tap Show my NIM below to add your stake.')).toBeVisible()
    await expect(hero(page).getByText(/\$100\.\d+/).first()).toBeVisible()
  })

  test('the APY reads as one percent, in English and in German', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await tab(page, 'Home')
    const dollars = page.getByRole('main').getByText(/APY$/).first()
    await expect(dollars).toHaveText('3.66% APY')

    await page.goto('/?mock=happy&delay=30&lang=de#')
    await expect(page.getByRole('main').getByText(/APY$/).first()).toHaveText(/^3,66\s%\sAPY$/)
  })

  test("the last-24-hours NIM figure says which window it averaged: the check's, not a fixed week", async ({ page }) => {
    await start(page, 'happy')
    const since = page.getByRole('region', { name: 'Last 24 hours, estimated' })
    await expect(since.getByText('paid by your pool, daily average of 6 days')).toBeVisible()
    await expect(since.getByText(/NIM: what your pool paid you over 6 days, per day\.$/)).toBeVisible()
  })

  test('nothing known yet is a dash, not $0.00', async ({ page }) => {
    // no price source: a NIM-only staker has nothing that can be added up
    await start(page, 'happy', '&rates=down')
    await expect(hero(page).getByText('—', { exact: true }).first()).toBeVisible()
    await expect(hero(page).getByText('$0.00')).toHaveCount(0)
  })

  test('a stale price says how old it is, next to the NIM value and in the source line', async ({ page }) => {
    await start(page, 'happy', '&rates=stale')
    await expect(page.getByText(/^1 NIM = \$0\.000300, price as of \d\d:\d\d( [AP]M)?; the price sources are not answering right now\./)).toBeVisible()
    await expect(page.getByText(/^≈ \$0\.30 · price as of \d\d:\d\d/).first()).toBeVisible()
  })

  test('with no rate at all the app stays quiet: values in USD, nothing on the console', async ({ page }) => {
    const logged: string[] = []
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning') logged.push(`${m.type()}: ${m.text()}`)
    })
    page.on('pageerror', e => logged.push(`pageerror: ${e.message}`))
    await start(page, 'happy', '&rates=down')
    await expect(page.getByText('No exchange rate right now; values show in USD.')).toBeVisible()
    await expect(hero(page).getByText('—', { exact: true }).first()).toBeVisible()
    expect(logged).toEqual([])
  })

  test('idle balances below what can be deposited or staked say why, with no button', async ({ page }) => {
    await start(page, 'insufficient')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await tab(page, 'Home')
    const row = page.getByRole('listitem').filter({ hasText: '0.50 USDT in your wallet' })
    await expect(row.getByText('Deposits start at 1.00 USDT.')).toBeVisible()
    await expect(row.getByRole('button')).toHaveCount(0)
  })
})
