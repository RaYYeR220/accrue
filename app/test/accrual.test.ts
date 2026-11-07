import { adaptiveDecimals } from '@accrue/shared'
import { describe, expect, it } from 'vitest'
import { accrue, perSecond, RAY, scaledFromBalance } from '../src/features/dollars/accrual'

const APR = (pct: number) => (BigInt(Math.round(pct * 1e6)) * RAY) / 100_000_000n
const LAST = 1_762_500_000 // reserve lastUpdateTimestamp, unix seconds
const INDEX = 1_123_456_789_000_000_000_000_000_000n // 1.123456789 ray

// scaled balance that is worth exactly `units` at the last reserve update
const scaledFor = (units: bigint) => (units * RAY) / INDEX

describe('accrue', () => {
  it('100 USDT0 at 3.66 % grows by about 1.16e-7 USD in one second', () => {
    const scaled = scaledFor(100_000_000n)
    const t0 = LAST * 1000
    const a = accrue(scaled, INDEX, APR(3.66), LAST, t0)
    const b = accrue(scaled, INDEX, APR(3.66), LAST, t0 + 1000)
    expect(a).toBeCloseTo(100, 5)
    const growth = b - a
    const expected = (100 * 0.0366) / 31_536_000
    expect(expected).toBeCloseTo(1.16e-7, 9)
    expect(Math.abs(growth - expected) / expected).toBeLessThan(0.05)
  })

  it('is linear in time like Aave between reserve updates', () => {
    const scaled = scaledFor(1_000_000_000n)
    const day = accrue(scaled, INDEX, APR(5), LAST, (LAST + 86_400) * 1000) - accrue(scaled, INDEX, APR(5), LAST, LAST * 1000)
    expect(day).toBeCloseTo((1000 * 0.05) / 365, 6)
  })

  it('never runs backwards when the device clock is behind the reserve update', () => {
    const scaled = scaledFor(100_000_000n)
    expect(accrue(scaled, INDEX, APR(3.66), LAST, (LAST - 3600) * 1000)).toBe(accrue(scaled, INDEX, APR(3.66), LAST, LAST * 1000))
  })

  it('accepts a lastUpdate given in milliseconds', () => {
    const scaled = scaledFor(100_000_000n)
    const now = (LAST + 60) * 1000
    expect(accrue(scaled, INDEX, APR(3.66), LAST * 1000, now)).toBe(accrue(scaled, INDEX, APR(3.66), LAST, now))
  })

  it('a zero balance stays zero', () => {
    expect(accrue(0n, INDEX, APR(3.66), LAST, Date.now())).toBe(0)
  })

  it('perSecond feeds adaptiveDecimals so the last digit moves about once a second', () => {
    const scaled = scaledFor(100_000_000n)
    const v = perSecond(scaled, INDEX, APR(3.66))
    expect(v).toBeCloseTo(1.1606e-7, 10)
    expect(adaptiveDecimals(v)).toBe(7)
  })

  it('scaledFromBalance inverts accrue at the read time', () => {
    const at = (LAST + 3600) * 1000
    const scaled = scaledFromBalance(250_000_000n, INDEX, APR(4), LAST, at)
    expect(accrue(scaled, INDEX, APR(4), LAST, at)).toBeCloseTo(250, 5)
  })
})
