import { normalizeAddress } from '@accrue/shared'

const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'
const ADDRESS_RE = new RegExp(`^NQ\\d{2}[${B32}]{32}$`)

function ibanRemainder(s: string): number {
  let rem = 0
  for (const ch of s) {
    const n = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of n) rem = (rem * 10 + Number(d)) % 97
  }
  return rem
}

/**
 * A user-friendly NIM address in any spacing or case ("NQ94UUV1..." or "NQ94 UUV1 ..."), checked
 * against its IBAN check digits, in the spaced form the RPC and the database use; null if invalid.
 */
export function parseNimAddress(input: string): string | null {
  const a = normalizeAddress(input)
  if (!ADDRESS_RE.test(a) || ibanRemainder(`${a.slice(4)}${a.slice(0, 4)}`) !== 1) return null
  return a.replace(/(.{4})(?=.)/g, '$1 ')
}

export const compactNim = (a: string) => normalizeAddress(a)
