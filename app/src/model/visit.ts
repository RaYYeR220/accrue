import type { AssetKey } from '@accrue/shared'
import { RAY } from '../features/dollars/accrual'
import { isRecord } from '../lib/util'

// What Home remembers between visits, on this phone only. Dollars as Aave scaled balance and
// liquidity index per asset (so interest can be told apart from deposits), NIM as staked luna.
export interface Snapshot {
  at: number
  dollars: Partial<Record<AssetKey, { scaled: string; index: string }>> | null
  nimStakedLuna: string | null
}

// last: the end of the latest visit; base: what that visit compared against
export interface Visit {
  last: Snapshot
  base: Snapshot | null
}

export const VISIT_KEY = 'accrue.visit.v1'
// a reopen within this gap is the same visit, so it keeps the earlier comparison
export const VISIT_GAP_MS = 30 * 60_000

const intStr = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v)

function parseSnapshot(v: unknown): Snapshot | null {
  if (!isRecord(v) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  let dollars: Snapshot['dollars'] = null
  if (isRecord(v.dollars)) {
    dollars = {}
    for (const [k, a] of Object.entries(v.dollars)) {
      if ((k === 'USDT0' || k === 'USDC') && isRecord(a) && intStr(a.scaled) && intStr(a.index)) dollars[k] = { scaled: a.scaled, index: a.index }
    }
  }
  return { at: v.at, dollars, nimStakedLuna: intStr(v.nimStakedLuna) ? v.nimStakedLuna : null }
}

export function loadVisit(): Visit | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VISIT_KEY) ?? 'null')
    if (!isRecord(raw)) return null
    const last = parseSnapshot(raw.last)
    if (!last) return null
    return { last, base: raw.base === null ? null : parseSnapshot(raw.base) }
  } catch {
    return null
  }
}

export function saveVisit(v: Visit): void {
  try {
    localStorage.setItem(VISIT_KEY, JSON.stringify(v))
  } catch {
    // best effort: without storage Home falls back to the last 24 h
  }
}

export function baselineFrom(stored: Visit | null, now: number): Snapshot | null {
  if (!stored) return null
  return now - stored.last.at >= VISIT_GAP_MS ? stored.last : stored.base
}

export const nextVisit = (base: Snapshot | null, current: Snapshot): Visit => ({ last: current, base })

export type SinceView =
  | { mode: 'visit'; since: number; dollarsUsd: number | null; nimLuna: bigint | null }
  | { mode: 'day'; dollarsUsd: number | null; nimLuna: bigint | null }

const min = (a: bigint, b: bigint) => (a < b ? a : b)

// Interest only accrues on what stayed in Aave the whole time, so it counts the smaller of the two
// scaled balances: a deposit since the last visit is not interest, and a withdrawal stops it.
function interestUsd(then: NonNullable<Snapshot['dollars']>, now: Partial<Record<AssetKey, { scaled: bigint; index: bigint }>>): number {
  let units = 0n
  for (const [k, a] of Object.entries(now) as [AssetKey, { scaled: bigint; index: bigint }][]) {
    const t = then[k]
    if (!t) continue
    const grew = a.index - BigInt(t.index)
    if (grew > 0n) units += (min(BigInt(t.scaled), a.scaled) * grew) / RAY
  }
  return Number(units) / 1e6
}

export function sinceView(args: {
  base: Snapshot | null
  now: number
  dollars: Partial<Record<AssetKey, { scaled: bigint; index: bigint }>> | null
  nimStakedLuna: bigint | null
  day: { dollarsUsd: number | null; nimLuna: bigint | null }
}): SinceView {
  const { base, dollars, nimStakedLuna, day } = args
  if (!base) return { mode: 'day', dollarsUsd: day.dollarsUsd, nimLuna: day.nimLuna }
  return {
    mode: 'visit',
    since: base.at,
    dollarsUsd: base.dollars && dollars ? interestUsd(base.dollars, dollars) : null,
    nimLuna: base.nimStakedLuna !== null && nimStakedLuna !== null ? nimStakedLuna - BigInt(base.nimStakedLuna) : null,
  }
}
