// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { heroView, side } from '../src/model/hero'
import { idleOffers } from '../src/model/idle'
import { clearSwitchTarget, loadSwitchTarget, saveSwitchTarget, SWITCH_KEY } from '../src/model/switchTarget'

const USD = 1_000_000n
const NIM = 100_000n

describe('the hero total only adds what is known', () => {
  it('a side is off before its wallet is connected, loading until its value and price are known', () => {
    expect(side({ connected: false, value: 5 })).toEqual({ state: 'off' })
    expect(side({ connected: true, value: null })).toEqual({ state: 'loading' })
    expect(side({ connected: true, value: Number.NaN })).toEqual({ state: 'loading' })
    expect(side({ connected: true, value: 0 })).toEqual({ state: 'known', fiat: 0 })
  })

  it('testnet NIM has no price: not loading forever, but unpriced, and left out of the total', () => {
    expect(side({ connected: true, value: Number.NaN, priced: false })).toEqual({ state: 'unpriced' })
    expect(heroView({ state: 'known', fiat: 5 }, { state: 'unpriced' })).toEqual({ kind: 'partial', value: 5, missing: [{ side: 'nim', why: 'unpriced' }] })
  })

  it('both known: the total', () => {
    expect(heroView({ state: 'known', fiat: 101 }, { state: 'known', fiat: 0.3 })).toEqual({ kind: 'total', value: 101.3 })
  })

  it('one side unknown: the known part, marked partial with what is missing', () => {
    expect(heroView({ state: 'off' }, { state: 'known', fiat: 0.3 })).toEqual({ kind: 'partial', value: 0.3, missing: [{ side: 'dollars', why: 'off' }] })
    expect(heroView({ state: 'known', fiat: 100 }, { state: 'off' })).toEqual({ kind: 'partial', value: 100, missing: [{ side: 'nim', why: 'off' }] })
    expect(heroView({ state: 'known', fiat: 100 }, { state: 'loading' })).toEqual({ kind: 'partial', value: 100, missing: [{ side: 'nim', why: 'loading' }] })
  })

  it('nothing known is a dash, never $0.00', () => {
    expect(heroView({ state: 'off' }, { state: 'loading' })).toEqual({
      kind: 'none',
      missing: [
        { side: 'dollars', why: 'off' },
        { side: 'nim', why: 'loading' },
      ],
    })
  })
})

describe('idle balances are offered only where they can be put to work', () => {
  it('dollars from $1, the deposit minimum; below it the reason instead of a button', () => {
    expect(idleOffers({ wallet: { USDT0: 25n * USD, USDC: USD / 2n }, stakeable: undefined, staking: undefined })).toEqual([
      { key: 'USDT0', units: 25n * USD, ok: true },
      { key: 'USDC', units: USD / 2n, ok: false, reason: 'MIN_DEPOSIT' },
    ])
  })

  it('NIM: 100 NIM to start staking, any amount to add to an existing stake', () => {
    expect(idleOffers({ wallet: undefined, stakeable: 50n * NIM, staking: false })).toEqual([{ key: 'nim', units: 50n * NIM, ok: false, reason: 'MIN_STAKE' }])
    expect(idleOffers({ wallet: undefined, stakeable: 150n * NIM, staking: false })).toEqual([{ key: 'nim', units: 150n * NIM, ok: true }])
    expect(idleOffers({ wallet: undefined, stakeable: 50n * NIM, staking: true })).toEqual([{ key: 'nim', units: 50n * NIM, ok: true }])
  })

  it('nothing for empty or unknown balances', () => {
    expect(idleOffers({ wallet: { USDT0: 0n, USDC: 0n }, stakeable: 0n, staking: false })).toEqual([])
    expect(idleOffers({ wallet: undefined, stakeable: 5n * NIM, staking: undefined })).toEqual([])
  })
})

describe('the pool a switch is heading to survives the wait', () => {
  const WALLET = 'NQ68 L6GS 38D1 L6GS 38D1 L6GS 38D1 L6GS 38D1'
  const HARBOR = 'NQ20 HARB 0R00 HARB 0R00 HARB 0R00 HARB 0R00'
  afterEach(() => localStorage.clear())

  it('is kept per wallet, whatever the spacing of the address', () => {
    expect(loadSwitchTarget(WALLET)).toBeNull()
    saveSwitchTarget(WALLET, HARBOR)
    expect(loadSwitchTarget(WALLET.replace(/\s/g, '').toLowerCase())).toBe(HARBOR)
    expect(loadSwitchTarget('NQ03 NARB 5CMJ NARB 5CMJ NARB 5CMJ NARB 5CMJ')).toBeNull()
    clearSwitchTarget(WALLET)
    expect(loadSwitchTarget(WALLET)).toBeNull()
  })

  it('ignores junk in storage', () => {
    localStorage.setItem(SWITCH_KEY, 'not json')
    expect(loadSwitchTarget(WALLET)).toBeNull()
    localStorage.setItem(SWITCH_KEY, JSON.stringify({ [WALLET.replace(/\s/g, '')]: 42 }))
    expect(loadSwitchTarget(WALLET)).toBeNull()
  })
})
