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

// A window length from the API, in days: "7", "6", "5.8"
export const days = (v: number) => num(v, 0, 1)

// Copy that counts days: its `.one` form when the number shown reads 1, plural for any other
// number, fractions included ("0.5 days", "1.5 days").
export function daysText(key: string, v: number, vars: Record<string, string | number> = {}): string {
  const shown = days(v)
  return t(shown === days(1) ? `${key}.one` : key, { ...vars, days: shown })
}

// "fee 3 %", "fee 9.5 %": one decimal only when the fee has one; a pool may list none
export const feeLine = (fee: number | null) =>
  fee === null ? t('pool.feeNotListed') : t('pool.fee', { pct: pct(fee, Math.round(fee * 1000) % 10 === 0 ? 0 : 1) })

// What people call the token. USDT0 is Tether's USDT on Polygon.
export const SYMBOL: Record<AssetKey, string> = { USDT0: 'USDT', USDC: 'USDC' }

const decimalMark = () => nf('mark', { minimumFractionDigits: 1 }).formatToParts(1.5).find(p => p.type === 'decimal')?.value ?? '.'

// `digits` decimals of a fixed-point amount, cut off (never rounded), built from the integer so
// nothing is lost on the way through a float.
function fixed(units: bigint, scale: number, digits: number): string {
  const neg = units < 0n
  const abs = neg ? -units : units
  const base = 10n ** BigInt(scale)
  const whole = num(Number(abs / base), 0, 0)
  const frac = (abs % base).toString().padStart(scale, '0').slice(0, digits)
  return `${neg ? '-' : ''}${whole}${digits ? decimalMark() + frac : ''}`
}

// Decimals needed to show every unit, never fewer than `min`.
function exactDigits(units: bigint, scale: number, min: number): number {
  const frac = ((units < 0n ? -units : units) % 10n ** BigInt(scale)).toString().padStart(scale, '0').replace(/0+$/, '')
  return Math.max(min, frac.length)
}

// Balances (6-decimal token units): two decimals, floored so a balance never reads as more than it
// is; more digits only when the amount is tiny.
export function tokens(units: bigint, asset?: AssetKey, decimals?: number): string {
  const abs = units < 0n ? -units : units
  const s = fixed(units, 6, decimals ?? (abs !== 0n && abs < 10_000n ? 6 : 2))
  return asset ? `${s} ${SYMBOL[asset]}` : s
}

// Amounts that are signed or sent: every unit, trailing zeros trimmed to two decimals.
export function exactTokens(units: bigint, asset?: AssetKey): string {
  const s = fixed(units, 6, exactDigits(units, 6, 2))
  return asset ? `${s} ${SYMBOL[asset]}` : s
}

// NIM balances: floored to at most two decimals from 1,000 NIM up, every luna below that.
export function nimAmount(luna: bigint, withUnit = true): string {
  const big = (luna < 0n ? -luna : luna) >= 100_000_000n
  const digits = exactDigits(luna, 5, 0)
  const s = fixed(luna, 5, big ? Math.min(2, digits) : digits)
  return withUnit ? `${s} NIM` : s
}

// NIM that is signed or sent: every luna.
export function nimExact(luna: bigint, withUnit = true): string {
  const s = fixed(luna, 5, exactDigits(luna, 5, 0))
  return withUnit ? `${s} NIM` : s
}

// "Up to X POL": rounded up to 4 decimals, so the bound is never below the real one.
export function polUpTo(wei: bigint): string {
  const tenThousandths = (wei + 10n ** 14n - 1n) / 10n ** 14n
  return fixed(tenThousandths, 4, exactDigits(tenThousandths, 4, 2))
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
