import { getAddress, isAddress, type Address } from 'viem'
import { isRecord } from '../lib/util'

// The addresses this phone connected before. Only addresses: they let a reopened app read public
// data (Aave position, relay jobs) without asking the wallet anything until the next tap.
export interface Session {
  nim: string | null
  evm: Address | null
}

export const SESSION_KEY = 'accrue.session.v1'

export function loadSession(): Session {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
    if (!isRecord(raw)) return { nim: null, evm: null }
    return {
      nim: typeof raw.nim === 'string' && raw.nim ? raw.nim : null,
      evm: typeof raw.evm === 'string' && isAddress(raw.evm, { strict: false }) ? getAddress(raw.evm) : null,
    }
  } catch {
    return { nim: null, evm: null }
  }
}

export function saveSession(s: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    // without storage the next open simply starts with the Start screen again
  }
}
