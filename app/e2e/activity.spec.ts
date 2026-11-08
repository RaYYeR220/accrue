import { expect, test } from '@playwright/test'
import { asset, connectPolygon, sheet, signDollars, SLOW, start, tab } from './app'

test.describe('Activity', () => {
  test('after a confirmed deposit and a cancelled one: one confirmed entry with its Polygonscan link, nothing for the cancelled one', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('Earning', { exact: true })).toBeVisible(SLOW)
    await d.getByRole('button', { name: 'Done' }).click()

    // the same phone, now with a wallet that declines
    await page.goto('/?mock=reject-sign&delay=30#dollars')
    await asset(page, 'USDT').getByRole('button', { name: 'Deposit', exact: true }).click()
    const again = sheet(page, 'Deposit USDT')
    await again.getByRole('button', { name: 'Connect Polygon wallet' }).click()
    await again.getByLabel('Amount to deposit').fill('1')
    await again.getByRole('button', { name: 'Review' }).click()
    await again.getByRole('button', { name: 'Switch to Polygon' }).click()
    await again.getByRole('button', { name: 'Sign and deposit' }).click()
    await expect(again.getByText('Cancelled — nothing was sent')).toBeVisible()
    await again.getByRole('button', { name: 'Close' }).click()

    await tab(page, 'Activity')
    const rows = page.getByRole('main').getByRole('listitem')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Deposit 1.00 USDT')
    await expect(rows.first()).toContainText('Confirmed')
    await expect(rows.first().getByRole('link', { name: 'Polygonscan' })).toHaveAttribute('href', /^https:\/\/polygonscan\.com\/tx\/0x[0-9a-f]{64}$/)
  })

  test('staking shows up with a Nimiq explorer link, rebuilt from the chain', async ({ page }) => {
    await start(page, 'htlc-only-balance')
    await tab(page, 'NIM')
    await page.getByRole('button', { name: 'Stake NIM' }).click()
    const d = sheet(page, 'Stake NIM')
    await d.getByRole('radio', { name: /Siam Pool/ }).check()
    await d.getByLabel('Amount to stake').fill('200')
    await d.getByRole('button', { name: 'Stake 200 NIM' }).click()
    await expect(d.getByText('Staked 200 NIM')).toBeVisible()
    await d.getByRole('button', { name: 'Done' }).click()
    // a fresh phone: only the chain knows about it
    await page.evaluate(() => localStorage.removeItem('accrue.nim.txs.v1'))
    await page.reload()
    await tab(page, 'Activity')
    await page.getByRole('button', { name: 'Show my NIM' }).click()
    const row = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Staked 200 NIM' })
    await expect(row).toContainText('Confirmed')
    await expect(row.getByRole('link', { name: 'Nimiq explorer' })).toHaveAttribute('href', /^https:\/\/nimiq\.watch\/#[0-9a-f]{64}$/)
  })
})
