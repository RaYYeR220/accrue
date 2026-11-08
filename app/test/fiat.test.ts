import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRates, hostFiat, makeFiat, parseRates, retryRates, type Rates } from '../src/fiat/useFiat'
import { extendDicts } from '../src/i18n'
import en from '../src/landing/i18n/en.json'
import { makeOrbitCopy } from '../src/landing/orbit/copy'
import { HttpError } from '../src/providers/errors'

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

describe('stale rates', () => {
  const hhmm = (ts: number, lang = 'en') => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ts)
  const asOf = Date.UTC(2026, 10, 8, 5, 12)

  it('fresh rates carry no note', () => {
    const f = makeFiat('USD', { ...rates, asOf }, false, 'en', asOf + 60_000)
    expect(f.stale).toBe(false)
    expect(f.note).toBe('')
  })

  it("a stale copy says how old its price is, the way it reads today: 'price as of 05:12'", () => {
    const f = makeFiat('EUR', { ...rates, asOf, stale: true }, false, 'en', asOf + 3 * 3_600_000)
    expect(f.stale).toBe(true)
    expect(f.note).toBe(`price as of ${hhmm(asOf)}`)
    // the values still convert: an old price is shown with its age, not dropped
    expect(f.nimToFiat(100_000n)).toBeCloseTo(0.0003 * 0.9)
  })

  it('a price from an earlier day names the day too', () => {
    const f = makeFiat('USD', { ...rates, asOf, stale: true }, false, 'en', asOf + 20 * 3_600_000)
    expect(f.note).toMatch(/^price as of .*Nov.*\d\d:\d\d|^price as of .*\d\d:\d\d.*Nov/)
  })

  it("the landing's orbit puts the age under the fiat value", () => {
    extendDicts({ en })
    const copy = makeOrbitCopy(makeFiat('USD', { ...rates, asOf, stale: true }, false, 'en', asOf + 60_000))
    expect(copy.fiat(1000)).toBe(`≈ $0.30\nprice as of ${hhmm(asOf)}`)
    expect(makeOrbitCopy(makeFiat('USD', rates, false, 'en')).fiat(1000)).toBe('≈ $0.30')
  })

  it('parses the flag, and only `true` counts', () => {
    expect(parseRates({ ...rates, stale: true }).stale).toBe(true)
    expect(parseRates({ ...rates, stale: 'yes' }).stale).toBeUndefined()
    expect(parseRates(rates).stale).toBeUndefined()
  })
})

describe('each part of the rates on its own', () => {
  const hhmm = (ts: number) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(ts)
  const priceAt = Date.UTC(2026, 10, 8, 6, 30)
  const fxAt = Date.UTC(2026, 10, 8, 5, 12)
  const body = { ...rates, asOf: fxAt, priceAsOf: priceAt, fxAsOf: fxAt, stale: true, fxStale: true, source: ['CoinGecko', 'open.er-api.com'] }

  it('reads priceAsOf, fxAsOf and which part is stale', () => {
    expect(parseRates(body)).toMatchObject({ priceAsOf: priceAt, fxAsOf: fxAt, fxStale: true })
    expect(parseRates(body).priceStale).toBeUndefined()
    // an answer with only `stale` and `asOf` reads as a stale price as of `asOf`
    expect(makeFiat('USD', parseRates({ ...rates, asOf: fxAt, stale: true }), false, 'en', priceAt).note).toBe(`price as of ${hhmm(fxAt)}`)
  })

  it('a stale exchange rate beside a fresh price only matters away from USD', () => {
    const usd = makeFiat('USD', parseRates(body), false, 'en', priceAt + 60_000)
    expect(usd.stale).toBe(false)
    expect(usd.note).toBe('')
    const eur = makeFiat('EUR', parseRates(body), false, 'en', priceAt + 60_000)
    expect(eur.stale).toBe(true)
    expect(eur.note).toBe(`exchange rate as of ${hhmm(fxAt)}`)
  })

  it('says which part is stale, so the source line can word it', () => {
    const fx = parseRates(body)
    expect(makeFiat('EUR', fx, false, 'en', priceAt + 60_000)).toMatchObject({ priceStale: false, fxStale: true })
    expect(makeFiat('USD', fx, false, 'en', priceAt + 60_000)).toMatchObject({ priceStale: false, fxStale: false })
    const price = parseRates({ ...body, priceStale: true, fxStale: undefined })
    expect(makeFiat('EUR', price, false, 'en', priceAt + 60_000)).toMatchObject({ priceStale: true, fxStale: false })
  })

  it('a stale price says the price time, whatever the fiat', () => {
    const r = parseRates({ ...body, priceStale: true, fxStale: undefined })
    expect(makeFiat('USD', r, false, 'en', priceAt + 60_000).note).toBe(`price as of ${hhmm(priceAt)}`)
  })

  it('names where the NIM price came from, the exchange pair as a thin market', () => {
    expect(makeFiat('USD', parseRates(body), false, 'en').priceSource).toBe('CoinGecko')
    expect(makeFiat('USD', parseRates({ ...body, source: ['Gate.io+Kraken', 'open.er-api.com'] }), false, 'en').priceSource).toBe('Gate.io + Kraken, a thin market')
    expect(makeFiat('USD', null, false, 'en').priceSource).toBe('')
  })
})

describe('retryRates', () => {
  it('a 503 means no rate exists right now: no retry, so nothing more goes to the console', () => {
    expect(retryRates(0, new HttpError(503, { error: 'RPC_UNAVAILABLE' }))).toBe(false)
    expect(retryRates(0, new Error('network'))).toBe(true)
    expect(retryRates(0, new HttpError(502, null))).toBe(true)
    expect(retryRates(1, new Error('network'))).toBe(false)
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

describe('fetchRates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('works in a WebView without AbortSignal.timeout, and keeps HttpError for a failed answer', async () => {
    const timeout = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true })
    try {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(rates), { status: 200 }))
      expect((await fetchRates()).nimUsd).toBe(rates.nimUsd)
      vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
      await expect(fetchRates()).rejects.toBeInstanceOf(HttpError)
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: timeout, configurable: true, writable: true })
    }
  })
})
