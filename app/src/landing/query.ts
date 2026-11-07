import { formatNimAddress, isValidNimAddress } from '@accrue/shared'
import { getAddress, isAddress, type Address } from 'viem'

export type QueryInvalidReason = 'nimChecksum' | 'nimFormat' | 'evmChecksum' | 'evmFormat' | 'unknown'

export type Query =
  | { kind: 'empty' }
  | { kind: 'nim'; address: string }
  | { kind: 'evm'; address: Address }
  | { kind: 'invalid'; reason: QueryInvalidReason }

const NIM_SHAPE = /^NQ\d{2}[0-9A-HJ-NP-VXY]{32}$/
const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/

// What the visitor pasted into the checker. A typo in a well-formed address is reported as a
// checksum problem so the message can say "check the address" rather than "unsupported".
export function classifyQuery(raw: string): Query {
  const s = raw.trim()
  if (!s) return { kind: 'empty' }
  if (/^nq/i.test(s)) {
    const compact = s.replace(/\s+/g, '').toUpperCase()
    if (!NIM_SHAPE.test(compact)) return { kind: 'invalid', reason: 'nimFormat' }
    return isValidNimAddress(compact) ? { kind: 'nim', address: formatNimAddress(compact) } : { kind: 'invalid', reason: 'nimChecksum' }
  }
  if (/^0x/i.test(s)) {
    if (!EVM_SHAPE.test(s)) return { kind: 'invalid', reason: 'evmFormat' }
    return isAddress(s) ? { kind: 'evm', address: getAddress(s) } : { kind: 'invalid', reason: 'evmChecksum' }
  }
  return { kind: 'invalid', reason: 'unknown' }
}
