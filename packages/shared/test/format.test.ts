import { describe, expect, it } from 'vitest'
import { adaptiveDecimals, formatFiat, parseSchedule } from '../src/index'

describe('adaptiveDecimals', () => {
  it('3.66% on $100 per year needs >= 7 digits', () => {
    expect(adaptiveDecimals((100 * 0.0366) / 31_536_000)).toBeGreaterThanOrEqual(7)
  })
  it('clamps to [2, 9]', () => {
    expect(adaptiveDecimals(5)).toBe(2)
    expect(adaptiveDecimals(1e-15)).toBe(9)
    expect(adaptiveDecimals(0)).toBe(2)
  })
})

describe('formatFiat', () => {
  it('de EUR', () => expect(formatFiat(1234.5, 'EUR', 'de')).toBe('1.234,50 €'))
  it('en USD with explicit decimals', () => expect(formatFiat(1.23456789, 'USD', 'en', 6)).toBe('$1.234568'))
  it('CRC and GMD are formatted', () => {
    expect(formatFiat(1000, 'CRC', 'es')).toContain('1')
    expect(formatFiat(10, 'GMD', 'en')).toContain('10')
  })
})

describe('parseSchedule', () => {
  it('parses intervals', () => {
    expect(parseSchedule('Every 12 hours')).toBe(43_200_000)
    expect(parseSchedule('Every 3 hours')).toBe(10_800_000)
    expect(parseSchedule('Every minute')).toBe(60_000)
    expect(parseSchedule('Every hour')).toBe(3_600_000)
    expect(parseSchedule('Every 15 minutes')).toBe(900_000)
    expect(parseSchedule('Every day')).toBe(86_400_000)
  })
  it('returns null for empty or unknown', () => {
    expect(parseSchedule('')).toBeNull()
    expect(parseSchedule('whenever')).toBeNull()
  })
})
