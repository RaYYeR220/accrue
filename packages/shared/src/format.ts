export type Fiat = 'USD' | 'EUR' | 'CRC' | 'GMD'

// Enough digits that the last shown digit changes about once a second.
export function adaptiveDecimals(valuePerSecond: number): number {
  if (!(valuePerSecond > 0) || !Number.isFinite(valuePerSecond)) return 2
  return Math.min(9, Math.max(2, Math.ceil(-Math.log10(valuePerSecond))))
}

export function formatFiat(amount: number, fiat: Fiat, locale: string, decimals?: number): string {
  const opts: Intl.NumberFormatOptions = { style: 'currency', currency: fiat }
  if (decimals !== undefined) {
    opts.minimumFractionDigits = decimals
    opts.maximumFractionDigits = decimals
  }
  return new Intl.NumberFormat(locale, opts).format(amount)
}

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const

// Pool "payout schedule" labels such as "Every 12 hours".
export function parseSchedule(s: string): number | null {
  const m = /^\s*every\s+(?:(\d+)\s+)?(minute|hour|day)s?\s*$/i.exec(s)
  if (!m) return null
  const n = m[1] ? Number(m[1]) : 1
  return n > 0 ? n * UNIT_MS[m[2]!.toLowerCase() as keyof typeof UNIT_MS] : null
}
