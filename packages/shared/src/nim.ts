export const LUNA_PER_NIM = 100_000n
export const MIN_STAKE_LUNA = 10_000_000n
export const BATCH_BLOCKS = 60
export const EPOCH_BLOCKS = 43_200
export const COINBASE_ADDRESS = 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000'
export const STAKING_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'

// RPC shape: luna amounts come as plain numbers, timestamps in ms.
export interface NimTx {
  hash: string
  blockNumber: number
  timestamp: number
  from: string
  to: string
  fromType: number
  toType: number
  value: number
  fee: number
  senderData: string
  recipientData: string
  relatedAddresses: string[]
}

export interface Staker {
  address: string
  activeLuna: bigint
  delegation: string
  inactiveLuna: bigint
  inactiveFrom: number | null
  retiredLuna: bigint
}

export function lunaToNim(l: bigint): string {
  const neg = l < 0n
  const abs = neg ? -l : l
  const whole = abs / LUNA_PER_NIM
  const frac = (abs % LUNA_PER_NIM).toString().padStart(5, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** NIM for people to read: thousands separators, rounded to at most two decimals ("4,629.98"). */
export function formatNim(l: bigint): string {
  const neg = l < 0n
  const cents = ((neg ? -l : l) + LUNA_PER_NIM / 200n) / (LUNA_PER_NIM / 100n)
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${neg && cents > 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

export function nimToLuna(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,5}))?$/.exec(s.trim())
  if (!m) throw new Error(`invalid NIM amount: ${s}`)
  const luna = BigInt(m[2]!) * LUNA_PER_NIM + BigInt((m[3] ?? '').padEnd(5, '0') || '0')
  return m[1] ? -luna : luna
}

const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

export function normalizeAddress(a: string): string {
  return a.replace(/\s+/g, '').toUpperCase()
}

function ibanCheck(s: string): number {
  let rem = 0
  for (const ch of s) {
    const n = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of n) rem = (rem * 10 + Number(d)) % 97
  }
  return rem
}

const ADDRESS_RE = new RegExp(`^NQ\\d{2}[${B32}]{32}$`)

// User-friendly form: "NQ" + two IBAN check digits + 32 base32 characters, spaces optional.
export function isValidNimAddress(s: string): boolean {
  const a = normalizeAddress(s)
  return ADDRESS_RE.test(a) && ibanCheck(`${a.slice(4)}${a.slice(0, 4)}`) === 1
}

export function formatNimAddress(s: string): string {
  return normalizeAddress(s).replace(/(.{4})/g, '$1 ').trim()
}

// 20 raw address bytes (hex) -> "NQxx XXXX ..." user-friendly form.
export function addressFromBytesHex(hex: string): string {
  const h = hex.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error('address must be 20 bytes of hex')
  let bits = ''
  for (let i = 0; i < 40; i += 2) bits += parseInt(h.slice(i, i + 2), 16).toString(2).padStart(8, '0')
  let body = ''
  for (let i = 0; i < 160; i += 5) body += B32[parseInt(bits.slice(i, i + 5), 2)]
  const check = String(98 - ibanCheck(`${body}NQ00`)).padStart(2, '0')
  return `NQ${check}${body}`.replace(/(.{4})/g, '$1 ').trim()
}
