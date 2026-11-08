import { type AssetKey } from '@accrue/shared'
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

export const num = (v: number, min = 0, max = min) => nf(`n${min}-${max}`, { minimumFractionDigits: min, maximumFractionDigits: max }).format(v)

export const pct = (fraction: number, decimals = 2) => nf(`p${decimals}`, { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(fraction)

// What people call the token. USDT0 is Tether's USDT on Polygon.
export const SYMBOL: Record<AssetKey, string> = { USDT0: 'USDT', USDC: 'USDC' }

// 6-decimal token units: two decimals, more only when the amount is tiny.
export function tokens(units: bigint, asset?: AssetKey, decimals?: number): string {
  const v = Number(units) / 1e6
  const d = decimals ?? (v !== 0 && Math.abs(v) < 0.01 ? 6 : 2)
  const s = num(v, d, d)
  return asset ? `${s} ${SYMBOL[asset]}` : s
}

// Luna to NIM: whole NIM for big amounts, up to 5 decimals below 1,000.
export function nimAmount(luna: bigint, withUnit = true): string {
  const v = Number(luna) / 1e5
  const s = Math.abs(v) >= 1000 ? num(v, 0, 2) : num(v, 0, 5)
  return withUnit ? `${s} NIM` : s
}

// A signed change, for "since your last visit".
export const signed = (s: string, negative: boolean) => (negative ? `−${s.replace(/^-/, '')}` : `+${s}`)

export const time = (ts: number) => new Intl.DateTimeFormat(currentLang(), { hour: '2-digit', minute: '2-digit' }).format(ts)

export function when(ts: number, now = Date.now()): string {
  const sameDay = new Date(ts).toDateString() === new Date(now).toDateString()
  return sameDay
    ? time(ts)
    : new Intl.DateTimeFormat(currentLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts)
}

// "about 21 h", "about 5 min": a countdown that does not pretend to be exact.
export function about(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return t('fmt.minutes', { n: min })
  const h = Math.round(min / 60)
  if (h < 48) return t('fmt.hours', { n: h })
  return t('fmt.days', { n: Math.round(h / 24) })
}

export function every(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return min <= 1 ? t('fmt.everyMinute') : t('fmt.everyMinutes', { n: min })
  const h = Math.round(min / 60)
  if (h < 24) return h === 1 ? t('fmt.everyHour') : t('fmt.everyHours', { n: h })
  const d = Math.round(h / 24)
  return d === 1 ? t('fmt.everyDay') : t('fmt.everyDays', { n: d })
}

export function ago(ts: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(currentLang(), { numeric: 'auto' })
  const min = Math.round((ts - now) / 60_000)
  if (Math.abs(min) < 60) return rtf.format(min, 'minute')
  const h = Math.round(min / 60)
  if (Math.abs(h) < 48) return rtf.format(h, 'hour')
  return rtf.format(Math.round(h / 24), 'day')
}

export const short = (a: string) => (a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : `${a.slice(0, 9)}…${a.slice(-4)}`)

// Decimal comma languages accept "1,5" in amount fields.
export const commaDecimal = () => currentLang() !== 'en'
