import { LIMITS } from '@accrue/shared'

export type AmountError = 'EMPTY' | 'FORMAT' | 'TOO_PRECISE'
export type Parsed = { ok: true; units: bigint } | { ok: false; error: AmountError }

// 10,000,000,000.000000 has 17 digits; anything far longer is a paste accident, not an amount.
const MAX_LEN = 24

// Digits and at most one decimal mark: no exponents, signs, spaces or group separators, and never
// rounding. Each language has exactly one decimal mark and the other one is refused, because it is
// that language's thousands separator: `comma` (de, es, fr, pt) reads "1,5" as one and a half and
// refuses "1.000"; English reads "1.5" and refuses "1,500".
export function parseAmount(raw: string, decimals: number, opts: { comma?: boolean } = {}): Parsed {
  const s = raw.trim()
  if (!s) return { ok: false, error: 'EMPTY' }
  if (s.length > MAX_LEN) return { ok: false, error: 'FORMAT' }
  const sep = opts.comma ? ',' : '\\.'
  const m = new RegExp(`^(\\d*)(?:${sep}(\\d*))?$`).exec(s)
  if (!m) return { ok: false, error: 'FORMAT' }
  const whole = m[1] ?? ''
  const frac = m[2] ?? ''
  if (!whole && !frac) return { ok: false, error: 'FORMAT' }
  if (frac.length > decimals) return { ok: false, error: 'TOO_PRECISE' }
  const scale = 10n ** BigInt(decimals)
  return { ok: true, units: BigInt(whole || '0') * scale + BigInt(frac.padEnd(decimals, '0') || '0') }
}

// What Max and All type into the field: every unit, in the language's own decimal mark, so it
// parses back to exactly the same amount.
export function plainUnits(units: bigint, decimals: number, comma: boolean): string {
  const scale = 10n ** BigInt(decimals)
  const frac = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${units / scale}${comma ? ',' : '.'}${frac}` : `${units / scale}`
}

export type LimitCheck = { ok: true } | { ok: false; reason: 'MIN' | 'MAX' | 'BALANCE' | 'ZERO'; limit: bigint }

// The relay's own limits, checked before the sheet offers a signature.
export function checkDeposit(units: bigint, balance: bigint | undefined): LimitCheck {
  if (units < LIMITS.minDepositUnits) return { ok: false, reason: 'MIN', limit: LIMITS.minDepositUnits }
  if (units > LIMITS.maxTxUnits) return { ok: false, reason: 'MAX', limit: LIMITS.maxTxUnits }
  if (balance !== undefined && units > balance) return { ok: false, reason: 'BALANCE', limit: balance }
  return { ok: true }
}

// Leaving is never capped (the relay has no withdraw minimum or maximum), so a typed amount behaves
// like "All": anything above zero, up to the position.
export function checkWithdraw(units: bigint, position: bigint): LimitCheck {
  if (units <= 0n) return { ok: false, reason: 'ZERO', limit: 0n }
  if (units > position) return { ok: false, reason: 'BALANCE', limit: position }
  return { ok: true }
}

export const maxDeposit = (balance: bigint) => (balance > LIMITS.maxTxUnits ? LIMITS.maxTxUnits : balance)
