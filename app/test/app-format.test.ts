import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtDays } from '../src/landing/format'
import { days, exactTokens, feeLine, nimAmount, nimExact, polUpTo, tokens } from '../src/screens/format'
import { loadAppStrings } from '../src/screens/strings'

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

describe('the check window, in days', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("whole days stay whole; a fraction keeps one decimal, in the language's own mark", () => {
    for (const f of [days, fmtDays]) {
      expect(f(7)).toBe('7')
      expect(f(6)).toBe('6')
      expect(f(5.8)).toBe('5.8')
      expect(f(5 + 5 / 6)).toBe('5.8')
      expect(f(6.96)).toBe('7')
    }
    vi.stubGlobal('window', { nimiqPay: { language: 'de' } })
    expect(days(5.8)).toBe('5,8')
    expect(fmtDays(5.8)).toBe('5,8')
  })
})

describe("a pool's fee", () => {
  it('the listed fee as a percentage; a pool that lists none says so instead of a number', async () => {
    await loadAppStrings('en')
    expect(feeLine(0.03)).toBe('fee 3%')
    expect(feeLine(0.095)).toBe('fee 9.5%')
    expect(feeLine(null)).toBe('fee not listed')
  })
})
