import { describe, expect, it } from 'vitest'
import { budgetDay, bumpedFees, GAS_POLICY, gasLimit, initialFees, pickNonce, shouldReplace } from '../src/relayer/gas'

const GWEI = 1_000_000_000n

describe('gas policy', () => {
  it('tips at least 30 gwei and caps at 2 x base + tip', () => {
    expect(initialFees(250n * GWEI, 1n * GWEI)).toEqual({
      maxPriorityFeePerGas: 30n * GWEI,
      maxFeePerGas: 530n * GWEI,
    })
    expect(initialFees(100n * GWEI, 45n * GWEI)).toEqual({
      maxPriorityFeePerGas: 45n * GWEI,
      maxFeePerGas: 245n * GWEI,
    })
  })

  it('pads the gas estimate by 20 %, rounding up', () => {
    expect(gasLimit(310_000n)).toBe(372_000n)
    expect(gasLimit(1n)).toBe(2n)
  })

  it('bumps the tip by 25 % and keeps the max fee replaceable', () => {
    const prev = { maxPriorityFeePerGas: 30n * GWEI, maxFeePerGas: 530n * GWEI }
    const same = bumpedFees(prev, 250n * GWEI)
    expect(same.maxPriorityFeePerGas).toBe(37_500_000_000n)
    expect(same.maxFeePerGas).toBe(662_500_000_000n)
    const spike = bumpedFees(prev, 400n * GWEI)
    expect(spike.maxFeePerGas).toBe(837_500_000_000n)
  })

  it('replaces after 45 s, at most 3 times', () => {
    expect(shouldReplace(0, 44_999, 0)).toBe(false)
    expect(shouldReplace(0, 45_000, 0)).toBe(true)
    expect(shouldReplace(0, 45_000, 2)).toBe(true)
    expect(shouldReplace(0, 999_999, GAS_POLICY.maxBumps)).toBe(false)
  })

  it('takes the larger nonce while txs are pending and trusts the chain otherwise', () => {
    expect(pickNonce(7, 5, true)).toBe(7)
    expect(pickNonce(5, 7, true)).toBe(7)
    expect(pickNonce(9, 7, false)).toBe(7)
    expect(pickNonce(undefined, 3, true)).toBe(3)
    expect(pickNonce(4, undefined, true)).toBe(4)
    expect(() => pickNonce(undefined, undefined, false)).toThrow()
  })

  it('keeps the budget at 3 POL a day with a 0.2 POL floor', () => {
    expect(GAS_POLICY.budgetWeiMax).toBe(3n * 10n ** 18n)
    expect(GAS_POLICY.floorWei).toBe(2n * 10n ** 17n)
    expect(budgetDay(86_400_000 * 2 + 1)).toBe(2)
  })
})
