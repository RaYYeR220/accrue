import { describe, expect, it } from 'vitest'
import { hostFiat, makeFiat, parseRates, type Rates } from '../src/fiat/useFiat'

const rates: Rates = { asOf: 1_762_500_000_000, nimUsd: 0.0003, fx: { USD: 1, EUR: 0.9, CRC: 500, GMD: 70 }, source: ['test'] }
const NIM = 100_000n
const sp = (s: string) => s.replace(/ /g, ' ')

describe('makeFiat', () => {
  it('converts USD and NIM into the host fiat', () => {
    const f = makeFiat('EUR', rates, false, 'de')
    expect(f.fiat).toBe('EUR')
    expect(f.toFiat(10)).toBeCloseTo(9)
    expect(f.nimToFiat(1000n * NIM)).toBeCloseTo(1000 * 0.0003 * 0.9)
    expect(sp(f.format(9))).toBe('9,00 €')
    expect(sp(f.format(0.000123, 6))).toBe('0,000123 €')
    expect(f.asOf).toBe(rates.asOf)
    expect(f.source).toEqual(['test'])
  })

  it('USD needs no FX rate', () => {
    const f = makeFiat('USD', null, false, 'en')
    expect(f.toFiat(12.5)).toBe(12.5)
    expect(f.nimToFiat(NIM)).toBeNaN()
  })

  it('while rates load, non-USD values are unknown rather than wrong', () => {
    const f = makeFiat('CRC', null, false, 'es')
    expect(f.fiat).toBe('CRC')
    expect(f.toFiat(1)).toBeNaN()
    expect(f.format(f.toFiat(1))).toBe('—')
  })

  it('falls back to USD when the rate source fails', () => {
    const f = makeFiat('GMD', null, true, 'en')
    expect(f.fiat).toBe('USD')
    expect(f.toFiat(3)).toBe(3)
    expect(f.format(3)).toBe('$3.00')
  })

  it('falls back to USD when the host fiat has no usable rate', () => {
    const f = makeFiat('EUR', { ...rates, fx: { ...rates.fx, EUR: 0 } }, false, 'en')
    expect(f.fiat).toBe('USD')
    expect(f.toFiat(2)).toBe(2)
  })
})

describe('hostFiat', () => {
  it('reads nimiqPay.userFiat and defaults to USD', () => {
    expect(hostFiat({ nimiqPay: { userFiat: 'CRC' } } as unknown as Window)).toBe('CRC')
    expect(hostFiat({ nimiqPay: { userFiat: 'JPY' } } as unknown as Window)).toBe('USD')
    expect(hostFiat({} as Window)).toBe('USD')
  })
})

describe('parseRates', () => {
  it('accepts the /api/rates shape', () => {
    expect(parseRates({ ...rates, extra: 1 })).toEqual(rates)
  })

  it('tolerates a missing currency, which then falls back to USD', () => {
    const partial = parseRates({ ...rates, fx: { USD: 1, EUR: 0.9 } })
    expect(makeFiat('GMD', partial, false, 'en').fiat).toBe('USD')
    expect(makeFiat('EUR', partial, false, 'en').fiat).toBe('EUR')
  })

  it('rejects malformed payloads', () => {
    expect(() => parseRates({ nimUsd: 1 })).toThrow()
    expect(() => parseRates({ ...rates, nimUsd: 'x' })).toThrow()
    expect(() => parseRates({ ...rates, fx: 'x' })).toThrow()
    expect(() => parseRates({ ...rates, fx: { ...rates.fx, EUR: 'x' } })).toThrow()
  })
})
