import { parseSchedule, uniqueReasons, type Verdict } from '@accrue/shared'
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

/**
 * What to show about a pool's verdict, from the API's `state` rather than its wording: a pool the
 * check has not reached gets the app's own line (and not the API's reason beside it); a pool with no
 * fee or nothing indexed gets the API's reason alone. Without a state (an older answer) the reasons
 * stand and the neutral line only fills an empty list.
 */
export function noVerdictView(p: Pick<PoolRow, 'verdict' | 'reasons' | 'state'>): { reasons: string[]; unchecked: boolean } {
  if (p.state === 'unchecked') return { reasons: [], unchecked: true }
  if (p.state === undefined && p.verdict === null && p.reasons.length === 0) return { reasons: [], unchecked: true }
  return { reasons: p.reasons, unchecked: false }
}

// A pool that lists no payouts passes nothing on to its stakers, whatever the verdict says.
const rankOf = (p: PoolRow) => (p.payoutType === 'none' ? RANK.NO_PAYOUTS_BY_DESIGN : RANK[p.verdict ?? 'none'])

// A fee nobody published is not a low fee: those pools come after every listed one.
function byFee(a: PoolRow, b: PoolRow): number {
  if (a.fee === null || b.fee === null) return a.fee === b.fee ? 0 : a.fee === null ? 1 : -1
  return a.fee - b.fee
}

export function rankPools(pools: readonly PoolRow[]): PoolRow[] {
  return [...pools].sort((a, b) => rankOf(a) - rankOf(b) || byFee(a, b) || (a.balanceLuna > b.balanceLuna ? -1 : a.balanceLuna < b.balanceLuna ? 1 : 0))
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
const MILLI = 1_000

// "Last 24 h" when there is no earlier visit: dollars at today's Aave rate on today's balance,
// NIM as the daily average the pool paid this staker over the check window, whose length the API
// measures (usually 6 days, not always whole).
export function dayEstimate(args: {
  balances: { units: bigint; rateRay: bigint }[] | null
  receivedLuna: bigint | null
  windowDays: number
}): { dollarsUsd: number | null; nimLuna: bigint | null } {
  const { balances, receivedLuna, windowDays } = args
  const units = balances ? balances.reduce((s, b) => s + (b.units * b.rateRay * DAY_SEC) / (RAY * YEAR_SEC), 0n) : null
  // in thousandths of a day, so the division stays in luna; a window under a day has no daily average
  const milliDays = Number.isFinite(windowDays) ? Math.round(windowDays * MILLI) : 0
  return {
    dollarsUsd: units === null ? null : Number(units) / 1e6,
    nimLuna: receivedLuna !== null && milliDays >= MILLI ? (receivedLuna * BigInt(MILLI)) / BigInt(milliDays) : null,
  }
}

/**
 * The reason list a pool shows: the API's reasons, then the app's own facts (`extras`) that no
 * reason already states. An extra says "covers" the numbers it would repeat; when one reason holds
 * all of them, the extra is skipped. No line appears twice, in any case or punctuation.
 */
export function poolReasonLines(reasons: readonly string[], extras: readonly { text: string; covers?: readonly string[] }[]): string[] {
  const own = uniqueReasons(reasons)
  const added = extras.filter(x => !x.covers?.length || !own.some(r => x.covers!.every(c => r.includes(c)))).map(x => x.text)
  return uniqueReasons([...own, ...added])
}

/**
 * A pool's free-text schedule that is not a readable interval ("Every 12 hours"), cleaned and split by
 * how it reads: a short phrase can follow the payout type on the same line, a sentence gets its own.
 */
export function scheduleText(p: Pick<PoolRow, 'payoutType' | 'schedule'>): { inline: string | null; block: string | null } {
  if (p.payoutType === 'none' || !p.schedule || parseSchedule(p.schedule) !== null) return { inline: null, block: null }
  const text = p.schedule.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim()
  if (!text) return { inline: null, block: null }
  const short = text.length <= 28 && text.split(' ').length <= 4 && !/[.!?]$/.test(text)
  return short ? { inline: text, block: null } : { inline: null, block: text }
}
