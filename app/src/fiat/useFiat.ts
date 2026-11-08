import { formatFiat, LUNA_PER_NIM, type Fiat } from '@accrue/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { currentLang, t } from '../i18n'
import { fetchJson } from '../lib/api'
import { HttpError } from '../providers/errors'

export const FIATS = ['USD', 'EUR', 'CRC', 'GMD'] as const satisfies readonly Fiat[]

// GET /api/rates: USD-based FX plus the NIM price, with where they came from. `stale`: the
// sources did not answer and this is the last good copy, as old as `asOf` says.
export interface Rates {
  asOf: number
  nimUsd: number
  fx: Partial<Record<Fiat, number>>
  source: string[]
  stale?: true
}

export interface FiatApi {
  fiat: Fiat
  toFiat(usd: number): number
  nimToFiat(luna: bigint): number
  format(n: number, decimals?: number): string
  asOf: number | null
  source: string[]
  stale: boolean
  /** "price as of 05:12" while the rates are a stale copy, else '' */
  note: string
  /** the API has no rate at all right now (it answered 503): USD values, no NIM fiat */
  unavailable: boolean
}

const isFiat = (v: unknown): v is Fiat => typeof v === 'string' && (FIATS as readonly string[]).includes(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function hostFiat(w: Window | undefined = typeof window === 'undefined' ? undefined : window): Fiat {
  const f: unknown = w?.nimiqPay?.userFiat
  return isFiat(f) ? f : 'USD'
}

export function parseRates(body: unknown): Rates {
  if (typeof body !== 'object' || body === null) throw new Error('rates: not an object')
  const b = body as Record<string, unknown>
  if (!finite(b.asOf) || !finite(b.nimUsd) || b.nimUsd <= 0) throw new Error('rates: bad asOf or nimUsd')
  if (typeof b.fx !== 'object' || b.fx === null) throw new Error('rates: bad fx')
  const fx: Partial<Record<Fiat, number>> = {}
  for (const [k, v] of Object.entries(b.fx)) {
    if (!isFiat(k)) continue
    if (!finite(v)) throw new Error(`rates: bad fx.${k}`)
    fx[k] = v
  }
  const source = Array.isArray(b.source) ? b.source.filter((s): s is string => typeof s === 'string') : []
  return { asOf: b.asOf, nimUsd: b.nimUsd, fx, source, ...(b.stale === true ? { stale: true as const } : {}) }
}

// "05:12" today, "Nov 7, 05:12" for an earlier day (a stale copy can be up to a day old)
function asOfText(ts: number, now: number, locale: string): string {
  const sameDay = new Date(ts).toDateString() === new Date(now).toDateString()
  const opts: Intl.DateTimeFormatOptions = sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(locale, opts).format(ts)
}

// Unknown is NaN (rendered as a dash), never a wrong number. When the rate source
// failed, or has no usable rate for the host fiat, values fall back to USD.
export function makeFiat(host: Fiat, rates: Rates | null, failed: boolean, locale: string, now = Date.now()): FiatApi {
  const rate = host === 'USD' ? 1 : rates?.fx[host]
  const usable = finite(rate) && rate > 0
  const fiat: Fiat = usable || (!rates && !failed) ? host : 'USD'
  const factor = usable ? rate : fiat === 'USD' ? 1 : NaN
  const nimUsd = rates?.nimUsd ?? NaN
  const stale = rates?.stale === true
  return {
    fiat,
    toFiat: usd => usd * factor,
    nimToFiat: luna => (Number(luna) / Number(LUNA_PER_NIM)) * nimUsd * factor,
    format: (n, decimals) => (Number.isFinite(n) ? formatFiat(n, fiat, locale, decimals) : '—'),
    asOf: rates?.asOf ?? null,
    source: rates?.source ?? [],
    stale,
    unavailable: failed && !rates,
    note: stale && rates ? t('fiat.asOf', { time: asOfText(rates.asOf, now, locale) }) : '',
  }
}

export async function fetchRates(): Promise<Rates> {
  return parseRates(await fetchJson('/api/rates', {}, 8_000))
}

// A 503 is the API saying no rate exists right now (no source answered for a day): asking again at
// once changes nothing. Values then show in USD, without fiat for NIM, until the next refetch.
export const retryRates = (failures: number, err: unknown) => !(err instanceof HttpError && err.status === 503) && failures < 1

export function useFiat(): FiatApi {
  const q = useQuery({ queryKey: ['rates'], queryFn: fetchRates, staleTime: 5 * 60_000, refetchInterval: 5 * 60_000, retry: retryRates })
  const host = hostFiat()
  const locale = currentLang()
  return useMemo(() => makeFiat(host, q.data ?? null, q.isError, locale), [host, q.data, q.isError, locale])
}
