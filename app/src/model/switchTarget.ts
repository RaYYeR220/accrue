import { normalizeAddress } from '@accrue/shared'
import { isRecord } from '../lib/util'

// A pool switch spans a 12–24 h wait between "stop staking" and the move, so the pool chosen at
// the start is kept on this phone, per wallet, until the move is made or the switch is dropped.
export const SWITCH_KEY = 'accrue.nim.switch.v1'

function read(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SWITCH_KEY) ?? '{}')
    return isRecord(raw) ? raw : {}
  } catch {
    return {}
  }
}

function write(all: Record<string, unknown>): void {
  try {
    localStorage.setItem(SWITCH_KEY, JSON.stringify(all))
  } catch {
    // without storage the pool is picked again when the move is possible
  }
}

export function loadSwitchTarget(wallet: string): string | null {
  const v = read()[normalizeAddress(wallet)]
  return typeof v === 'string' && v ? v : null
}

export function saveSwitchTarget(wallet: string, pool: string): void {
  write({ ...read(), [normalizeAddress(wallet)]: pool })
}

export function clearSwitchTarget(wallet: string): void {
  const all = read()
  delete all[normalizeAddress(wallet)]
  write(all)
}
