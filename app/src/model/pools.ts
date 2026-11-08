import { parseSchedule, type Verdict } from '@accrue/shared'
import { RAY } from '../features/dollars/accrual'
import type { PoolRow } from '../features/nim/api'

// The order the picker states: how sure we are the pool pays, then the fee, then the size.
const RANK: Record<Verdict | 'none', number> = {
  PAID_AS_PROMISED: 0,
  NOT_ENOUGH_DATA: 1,
  none: 2,
  BEHIND_SCHEDULE: 3,
  CANT_VERIFY_ROUTED: 4,
  SHORT: 5,
  NO_PAYOUTS_BY_DESIGN: 6,
}

// A pool that lists no payouts passes nothing on to its stakers, whatever the verdict says.
const rankOf = (p: PoolRow) => (p.payoutType === 'none' ? RANK.NO_PAYOUTS_BY_DESIGN : RANK[p.verdict ?? 'none'])

export function rankPools(pools: readonly PoolRow[]): PoolRow[] {
  return [...pools].sort((a, b) => rankOf(a) - rankOf(b) || a.fee - b.fee || (a.balanceLuna > b.balanceLuna ? -1 : a.balanceLuna < b.balanceLuna ? 1 : 0))
}

export type NextPayout =
  | { kind: 'at'; at: number; intervalMs: number; late: boolean }
  | { kind: 'every'; intervalMs: number }
  | { kind: 'none' }
  | { kind: 'unknown' }

// From the pool's published schedule and its last payout seen on chain.
export function nextPayout(p: Pick<PoolRow, 'payoutType' | 'schedule' | 'lastPayoutTs'>, now: number): NextPayout {
  if (p.payoutType === 'none') return { kind: 'none' }
  const intervalMs = p.schedule ? parseSchedule(p.schedule) : null
  if (intervalMs === null) return { kind: 'unknown' }
  if (p.lastPayoutTs === null) return { kind: 'every', intervalMs }
  const at = p.lastPayoutTs + intervalMs
  return { kind: 'at', at, intervalMs, late: at < now }
}

const DAY_SEC = 86_400n
const YEAR_SEC = 31_536_000n

// "Last 24 h" when there is no earlier visit: dollars at today's Aave rate on today's balance,
// NIM as the daily average the pool paid this staker over the check window.
export function dayEstimate(args: {
  balances: { units: bigint; rateRay: bigint }[] | null
  receivedLuna: bigint | null
  windowDays: number
}): { dollarsUsd: number | null; nimLuna: bigint | null } {
  const { balances, receivedLuna, windowDays } = args
  const units = balances ? balances.reduce((s, b) => s + (b.units * b.rateRay * DAY_SEC) / (RAY * YEAR_SEC), 0n) : null
  // whole days only: a window under a day has no daily average to give
  const days = Number.isFinite(windowDays) ? Math.round(windowDays) : 0
  return {
    dollarsUsd: units === null ? null : Number(units) / 1e6,
    nimLuna: receivedLuna !== null && days >= 1 ? receivedLuna / BigInt(days) : null,
  }
}
