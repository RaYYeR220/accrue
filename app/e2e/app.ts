import { expect, type Locator, type Page } from '@playwright/test'

// Helpers for the in-app screens on the mock build. Every helper acts the way a person would:
// by visible names, never by internals.

export const SCENARIOS = ['happy', 'reject-sign', 'insufficient', 'relay-down', 'stale-nonce', 'unknown-outcome', 'htlc-only-balance', 'aave-illiquid', 'testnet'] as const

// The relay answers on a 3 s poll, so a deposit takes a few rounds to confirm.
export const SLOW = { timeout: 25_000 }

export async function open(page: Page, scenario: string, hash = '') {
  await page.goto(`/?mock=${scenario}&delay=30${hash}`)
}

export async function start(page: Page, scenario: string) {
  await open(page, scenario)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(nav(page)).toBeVisible()
}

export const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' })

export async function tab(page: Page, name: 'Home' | 'Dollars' | 'NIM' | 'Payouts' | 'Activity') {
  await nav(page).getByRole('link', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

export async function connectPolygon(page: Page) {
  await page.getByRole('button', { name: 'Connect Polygon wallet' }).first().click()
  await expect(page.getByRole('region', { name: 'USDT', exact: true }).getByText('In your wallet')).toBeVisible()
}

export const asset = (page: Page, name: 'USDT' | 'USDC') => page.getByRole('region', { name, exact: true })
export const sheet = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name })

// Amount → Review → the separate Switch to Polygon tap → Sign.
export async function signDollars(page: Page, kind: 'Deposit' | 'Withdraw', amount: string, token: 'USDT' | 'USDC' = 'USDT'): Promise<Locator> {
  await asset(page, token).getByRole('button', { name: kind, exact: true }).click()
  const d = sheet(page, `${kind} ${token}`)
  await d.getByLabel(kind === 'Deposit' ? 'Amount to deposit' : 'Amount to withdraw').fill(amount)
  await d.getByRole('button', { name: 'Review' }).click()
  await expect(d.getByText('What you sign')).toBeVisible()
  await expect(d.getByText('Paid by Accrue. You need no POL.')).toBeVisible()
  await d.getByRole('button', { name: 'Switch to Polygon' }).click()
  await d.getByRole('button', { name: kind === 'Deposit' ? 'Sign and deposit' : 'Sign and withdraw' }).click()
  return d
}

export const callsBeforeFirstTap = (page: Page) => page.evaluate(() => window.__accrueMock!.callsBeforeFirstInteraction())
export const providerCalls = (page: Page) => page.evaluate(() => window.__accrueMock!.calls.map(c => c.method))
