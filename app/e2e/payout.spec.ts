import { expect, test } from '@playwright/test'
import { start, tab } from './app'

// The six codes in their neutral wording, plus a pool the API has no verdict for yet.
const LABELS = ['Paid as promised', 'Behind schedule', 'Short', 'Not enough data', 'No payouts by design', "Can't verify — routed elsewhere", 'Not enough data yet']

test.describe('Payout Check', () => {
  test("your pool's verdict: expected against received over the window the API measured, the API's reasons, the methodology", async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Payouts')
    const card = page.getByRole('region', { name: 'Siam Pool' })
    await expect(card.getByText('Paid as promised')).toBeVisible()
    await expect(card.getByText('Over the last 6 days')).toBeVisible()
    await expect(card.getByRole('definition').nth(0)).toHaveText(/^\d+(\.\d+)? NIM$/)
    await expect(card.getByRole('definition').nth(1)).toHaveText(/^\d+(\.\d+)? NIM$/)
    await expect(card.getByText('99.2%')).toBeVisible()
    await expect(card.getByText('Paid 97.5% of earnings against 97.0% promised over 56 cycles.')).toBeVisible()
    await card.getByRole('link', { name: 'How Payout Check decides' }).click()
    await expect(page.getByRole('heading', { name: 'How Payout Check decides' })).toBeInViewport()
  })

  test('the scoreboard shows every verdict code in neutral words, with its reasons on tap', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Payouts')
    const board = page.getByRole('region', { name: 'All 8 pools' })
    for (const label of LABELS) await expect(board.getByText(label, { exact: true }).first()).toBeVisible()
    // one reason per fact: the API's ratio line and the app's own would say the same thing twice
    await board.getByRole('button', { name: /Siam Pool/ }).click()
    const siam = board.getByRole('listitem').filter({ has: page.getByRole('button', { name: /Siam Pool/ }) })
    await expect(siam.getByRole('listitem').filter({ hasText: /97\.5%/ })).toHaveCount(1)
    await expect(siam.getByText(/of earnings against/i)).toHaveCount(1)
    await board.getByRole('button', { name: /Kestrel Pool/ }).click()
    await expect(board.getByText('Paid 81.0% of earnings against 95.0% promised over 6 cycles.')).toBeVisible()
    // a free-text schedule is its own line, not run into "restakes"
    const fjord = board.getByRole('listitem').filter({ has: page.getByRole('button', { name: /Fjord Pool/ }) })
    await expect(fjord).toContainText('fee 6% · restakes')
    await expect(fjord).not.toContainText('restakes Payouts')
    await expect(fjord.getByText('Payouts over 10 NIM are instant when Fjord Pool is elected.', { exact: true })).toBeVisible()
    await board.getByRole('button', { name: /Fjord Pool/ }).click()
    // the API's own "has not looked yet" and the app's line would contradict each other: one neutral line
    await expect(board.getByText('Not checked yet', { exact: true })).toBeVisible()
    await expect(board.getByText('Payout Check has not looked at this pool yet.')).toHaveCount(0)
    await expect(board.getByText(/not enough payouts|within the hour/)).toHaveCount(0)
    // a pool with no published fee shows the API's own reason and no app line next to it
    await board.getByRole('button', { name: /Birch Pool/ }).click()
    await expect(board.getByText('The pool does not publish a fee, so there is no promised share to check its payouts against.')).toBeVisible()
    await expect(board.getByText('Not checked yet', { exact: true })).toHaveCount(1)
    await expect(board.getByRole('link', { name: 'How Payout Check decides' })).toBeVisible()
  })

  test('a pool that publishes no fee is on the board and says so', async ({ page }) => {
    await start(page, 'happy')
    await tab(page, 'Payouts')
    const board = page.getByRole('region', { name: 'All 8 pools' })
    const quarry = board.getByRole('listitem').filter({ has: page.getByRole('button', { name: /Quarry Pool/ }) })
    await expect(quarry).toContainText('fee not listed')
    await quarry.getByRole('button', { name: /Quarry Pool/ }).click()
    await expect(quarry).toContainText('Pool does not pay out; rewards are not distributed to stakers.')
  })
})
