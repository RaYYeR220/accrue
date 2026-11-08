import { formatFiat } from '@accrue/shared'
import { currentLang, t } from '../i18n'

const cache = new Map<string, Intl.NumberFormat>()
function nf(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${currentLang()}|${key}`
  let f = cache.get(k)
  if (!f) {
    f = new Intl.NumberFormat(currentLang(), opts)
    cache.set(k, f)
  }
  return f
}

export const fmtNum = (v: number, decimals = 0) => nf(`n${decimals}`, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v)

// 257,956,030 → "258M"; 5,263,174 → "5.3M"; 743,040 → "743K"
export const fmtCompact = (v: number) => nf(`c${v >= 1e8 ? 0 : 1}`, { notation: 'compact', maximumFractionDigits: v >= 1e8 ? 0 : 1 }).format(v)

export const fmtPct = (fraction: number, decimals = 2) => nf(`p${decimals}`, { style: 'percent', maximumFractionDigits: decimals }).format(fraction)

// A window length from the API, in days: "7", "6", "5.8"
export const fmtDays = (days: number) => nf('d', { maximumFractionDigits: 1 }).format(days)

export const fmtFee = (fee: number | null) => (fee === null ? t('landing.orbit.feeNotListed') : t('landing.orbit.fee', { pct: fmtPct(fee) }))

export function fmtNimLuna(luna: bigint): string {
  const nim = Number(luna) / 1e5
  return fmtNum(nim, nim >= 1e5 ? 0 : 2)
}

export const fmtUsd6 = (units: bigint) => formatFiat(Number(units) / 1e6, 'USD', currentLang())

export const fmtDate = (ts: number) => new Intl.DateTimeFormat(currentLang(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ts)

export const fmtDateTime = (ts: number) =>
  new Intl.DateTimeFormat(currentLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts)

// Monday is 0. 1 Jan 2024 was a Monday.
export const fmtWeekday = (d: number) => new Intl.DateTimeFormat(currentLang(), { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + d))

export function fmtAgo(ts: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(currentLang(), { numeric: 'auto' })
  const min = Math.round((ts - now) / 60_000)
  if (Math.abs(min) < 60) return rtf.format(min, 'minute')
  const h = Math.round(min / 60)
  if (Math.abs(h) < 48) return rtf.format(h, 'hour')
  return rtf.format(Math.round(h / 24), 'day')
}
