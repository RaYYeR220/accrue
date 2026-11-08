import { describe, expect, it } from 'vitest'
import { exactTokens, nimAmount, nimExact, polUpTo, tokens } from '../src/screens/format'

describe('amounts on screen', () => {
  it('balances are floored, never rounded up past what is there', () => {
    expect(tokens(999_999n, 'USDT0')).toBe('0.99 USDT')
    expect(tokens(25_129_999n, 'USDT0')).toBe('25.12 USDT')
    expect(tokens(1_000_000n)).toBe('1.00')
    // tiny balances keep their digits instead of reading 0.00
    expect(tokens(4_321n, 'USDC')).toBe('0.004321 USDC')
    expect(tokens(0n, 'USDC')).toBe('0.00 USDC')
  })

  it('signed amounts are exact: every unit that is signed is shown', () => {
    expect(exactTokens(25_123_456n, 'USDT0')).toBe('25.123456 USDT')
    expect(exactTokens(2_500_000n, 'USDT0')).toBe('2.50 USDT')
    expect(exactTokens(1_234_560n)).toBe('1.23456')
    expect(exactTokens(1_000_000n, 'USDC')).toBe('1.00 USDC')
    expect(exactTokens(10_000_000_000n)).toBe('10,000.00')
  })

  it('NIM balances are floored; signed NIM amounts are exact', () => {
    expect(nimAmount(123_456_789n)).toBe('1,234.56 NIM')
    expect(nimAmount(125_000_000n)).toBe('1,250 NIM')
    expect(nimAmount(125_010_000n)).toBe('1,250.1 NIM')
    expect(nimAmount(99_999n)).toBe('0.99999 NIM')
    expect(nimExact(123_456_789n)).toBe('1,234.56789 NIM')
    expect(nimExact(20_000_000n)).toBe('200 NIM')
    expect(nimExact(20_000_000n, false)).toBe('200')
  })

  it('"up to X POL" rounds up, so the bound is never below the real one', () => {
    expect(polUpTo(80_000_000_000_000_000n)).toBe('0.08')
    expect(polUpTo(80_000_000_000_000_001n)).toBe('0.0801')
    expect(polUpTo(123_456_789_000_000_000n)).toBe('0.1235')
  })
})
