import { expect, test } from '@playwright/test'
import { asset, callsBeforeFirstTap, connectPolygon, open, sheet, signDollars, SLOW, start, tab } from './app'

test.describe('dollars', () => {
  test('a $1 deposit ends Earning, with its Polygonscan transaction', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('Earning', { exact: true })).toBeVisible(SLOW)
    await expect(d.getByText('1.00 USDT is in Aave and earns from this block on.')).toBeVisible()
    await expect(d.getByRole('link', { name: 'View on Polygonscan' })).toHaveAttribute('href', /^https:\/\/polygonscan\.com\/tx\/0x[0-9a-f]{64}$/)
  })

  test('the USDT sheet says what is signed, to whom, what happens next, who pays gas, and why the wallet shows "Chain: undefined"', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await asset(page, 'USDT').getByRole('button', { name: 'Deposit', exact: true }).click()
    const d = sheet(page, 'Deposit USDT')
    await d.getByLabel('Amount to deposit').fill('2.5')
    await d.getByRole('button', { name: 'Review' }).click()
    await expect(d.getByText('A permit for exactly 2.50 USDT, valid for 20 minutes.', { exact: false })).toBeVisible()
    await expect(d.getByText("Accrue's router on Polygon", { exact: false })).toBeVisible()
    await expect(d.getByText("Accrue's relayer sends one transaction that puts it into Aave v3 in your name.", { exact: false })).toBeVisible()
    await expect(d.getByText('Paid by Accrue. You need no POL.')).toBeVisible()
    await expect(d.getByText('Nimiq Pay will show "Chain: undefined" for this signature.', { exact: false })).toBeVisible()
  })

  test('the amount field refuses exponents, separators and more than 6 decimals before any signature', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await asset(page, 'USDT').getByRole('button', { name: 'Deposit', exact: true }).click()
    const d = sheet(page, 'Deposit USDT')
    const field = d.getByLabel('Amount to deposit')
    const review = d.getByRole('button', { name: 'Review' })
    for (const [value, msg] of [
      ['1e3', 'Use digits and one decimal point, like 12.50.'],
      ['1,000', 'Use digits and one decimal point, like 12.50.'],
      ['1.0000001', 'At most 6 decimals.'],
      ['0.5', 'Deposits start at 1.00 USDT.'],
      ['10000.01', 'At most 10,000.00 USDT per transaction.'],
      ['26', 'That is more than the 25.00 USDT in your wallet.'],
    ]) {
      await field.fill(value!)
      await expect(d.getByText(msg!)).toBeVisible()
      await expect(review).toBeDisabled()
    }
    await d.getByRole('button', { name: 'Max' }).click()
    await expect(field).toHaveValue('25')
    await expect(review).toBeEnabled()
  })

  test('reject-sign: Cancelled — nothing was sent', async ({ page }) => {
    await start(page, 'reject-sign')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('Cancelled — nothing was sent')).toBeVisible()
    await expect(d.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('insufficient: the deposit button is disabled and says why', async ({ page }) => {
    await start(page, 'insufficient')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const usdt = asset(page, 'USDT')
    await expect(usdt.getByRole('button', { name: 'Deposit', exact: true })).toBeDisabled()
    await expect(usdt.getByText('Deposits start at 1.00 USDT. Your wallet holds 0.50 USDT on Polygon.')).toBeVisible()
  })

  test('relay down while the wallet holds POL: it keeps checking and offers to pay the fee yourself', async ({ page }) => {
    await start(page, 'relay-down')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('Checking…')).toBeVisible(SLOW)
    await expect(d.getByText("Accrue's relayer is not reachable right now.")).toBeVisible()
    // 400k gas at 100 gwei, with the 2x margin a wallet reserves: an upper bound, not a quote
    await expect(d.getByRole('button', { name: 'Pay the network fee myself, up to 0.08 POL' })).toBeVisible()
  })

  test('paying the fee yourself: the sheet says it is a transaction from your wallet and you pay up to the fee', async ({ page }) => {
    test.setTimeout(90_000)
    // slow wallet calls keep the confirm step on screen long enough to read
    await start(page, 'relay-down', '&delay=700')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await d.getByRole('button', { name: 'Pay the network fee myself, up to 0.08 POL' }).click(SLOW)
    await expect(d.getByText('Confirm the transaction in Nimiq Pay')).toBeVisible()
    await expect(d.getByText('What you send')).toBeVisible()
    await expect(d.getByText("A transaction from your wallet to Accrue's router, carrying your permit for 1.00 USDT.")).toBeVisible()
    await expect(d.getByText('Paid by you in POL: up to 0.08 POL.', { exact: false })).toBeVisible()
    await expect(d.getByText('You need no POL.')).toHaveCount(0)
    await expect(d.getByText('Earning', { exact: true })).toBeVisible(SLOW)
  })

  test('in German the decimal mark is a comma: "1.000" is refused, "1,5" is one and a half, exactly', async ({ page }) => {
    await open(page, 'happy', '', '&lang=de')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: 'Dollar', exact: true }).click()
    await page.getByRole('button', { name: 'Polygon-Wallet verbinden' }).first().click()
    await page.getByRole('region', { name: 'USDT', exact: true }).getByRole('button', { name: 'Einzahlen', exact: true }).click()
    const d = sheet(page, 'USDT einzahlen')
    const field = d.getByLabel('Betrag zum Einzahlen')
    await field.fill('1.000')
    await expect(d.getByText('Nur Ziffern und ein Dezimalkomma', { exact: false })).toBeVisible()
    await expect(d.getByRole('button', { name: 'Prüfen' })).toBeDisabled()
    await field.fill('1,5')
    await d.getByRole('button', { name: 'Prüfen' }).click()
    await expect(d.getByText('Ein Permit über genau 1,50 USDT', { exact: false })).toBeVisible()
  })

  test('stale nonce: says why and asks for a fresh signature, which then goes through', async ({ page }) => {
    await start(page, 'stale-nonce')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('This approval was already used. Sign a fresh one to continue.')).toBeVisible(SLOW)
    await d.getByRole('button', { name: 'Sign again' }).click()
    await expect(d.getByText('Earning', { exact: true })).toBeVisible(SLOW)
  })

  test('unknown outcome: "Checking…" persists, and after a reload the same job resumes to confirmed', async ({ page }) => {
    test.setTimeout(90_000)
    await start(page, 'unknown-outcome')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const d = await signDollars(page, 'Deposit', '1')
    await expect(d.getByText('Checking…')).toBeVisible(SLOW)
    await page.waitForTimeout(4_000)
    await expect(d.getByText('Checking…')).toBeVisible()
    await expect(d.getByText('Earning', { exact: true })).toHaveCount(0)
    await d.getByRole('button', { name: 'Close' }).click()
    const onTheWay = page.getByRole('region', { name: 'On their way' })
    await expect(onTheWay.getByText('Deposit 1.00 USDT')).toBeVisible()
    await expect(onTheWay.getByText('Checking…')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Dollars', level: 1 })).toBeVisible()
    // reopening reads the relay and the chain, and asks the wallet nothing
    expect(await callsBeforeFirstTap(page)).toBe(0)
    // "Details" follows the resumed job; the sheet did not start it, yet it names the amount
    await page.getByRole('region', { name: 'On their way' }).getByRole('button', { name: 'Details' }).click()
    const resumed = sheet(page, 'Deposit USDT')
    await expect(resumed.getByText('Earning', { exact: true })).toBeVisible(SLOW)
    await expect(resumed.getByText('1.00 USDT is in Aave and earns from this block on.')).toBeVisible()
    await resumed.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('region', { name: 'On their way' })).toHaveCount(0, SLOW)
    await tab(page, 'Activity')
    const row = page.getByRole('listitem').filter({ hasText: 'Deposit 1.00 USDT' })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Confirmed')).toBeVisible(SLOW)
    await expect(row.getByRole('link', { name: 'Polygonscan' })).toHaveAttribute('href', /^https:\/\/polygonscan\.com\/tx\/0x[0-9a-f]{64}$/)
  })

  test('aave illiquid: the withdrawal shows what Aave can pay out now and offers exactly that', async ({ page }) => {
    await start(page, 'aave-illiquid')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await expect(page.getByText('Right now Aave can pay out 3.00 USDT', { exact: false })).toBeVisible()
    const d = await signDollars(page, 'Withdraw', '10')
    await expect(d.getByText('Aave cannot pay out this amount right now.', { exact: false })).toBeVisible(SLOW)
    await expect(d.getByText('Available right now: 3.00 USDT')).toBeVisible()
    await d.getByRole('button', { name: 'Withdraw 3.00 USDT instead' }).click()
    await expect(d.getByText('A permit on your Aave USDT position for 3.00 USDT', { exact: false })).toBeVisible()
  })

  test("when Accrue's own figures cannot be read, the Aave balance still shows and Withdraw still works", async ({ page }) => {
    await start(page, 'happy', '&position=partial')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    const usdt = asset(page, 'USDT')
    await expect(page.getByText("Accrue's own figures can't be read right now.", { exact: false })).toBeVisible()
    await expect(usdt.getByText('25.00 USDT')).toBeVisible()
    for (const k of ['Put in through Accrue', 'Earned so far']) await expect(usdt.locator('.fact', { hasText: k }).locator('dd')).toHaveText('—')
    await expect(usdt.getByRole('button', { name: 'Withdraw', exact: true })).toBeEnabled()
    const d = await signDollars(page, 'Withdraw', '1')
    await expect(d.getByText('Back in your wallet')).toBeVisible(SLOW)
  })

  test('a returning person sees their dollars without the wallet being asked anything', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Dollars')
    await connectPolygon(page)
    await page.reload()
    await expect(asset(page, 'USDT').getByText('In Aave')).toBeVisible()
    await expect(asset(page, 'USDT').getByText('25.00 USDT')).toBeVisible()
    expect(await callsBeforeFirstTap(page)).toBe(0)
  })
})
