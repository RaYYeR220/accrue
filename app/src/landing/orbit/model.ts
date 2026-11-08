import type { Verdict } from '@accrue/shared'
import type { PoolRow } from '../data'
import { scheduleInfo } from '../schedule'

export type OrbitMode = 'none' | 'instant' | 'unpub' | 'stream' | 'periodic'

export interface OrbitPool {
  id: string
  name: string
  fee: number | null
  kind: 'R' | 'D' | 'N'
  mode: OrbitMode
  // published payout interval in hours, when there is one
  h: number | null
  thresholdNim: number | null
  stake: number
  stakers: number
  color: string
  verdict: Verdict | null
  schedKey: string
  schedVars: Record<string, number> | undefined
}

const NEUTRAL = '#8a8790'

export function toOrbitPool(p: PoolRow): OrbitPool {
  const s = scheduleInfo(p.schedule, p.payoutType)
  const kind = p.payoutType === 'none' ? 'N' : p.payoutType === 'direct' ? 'D' : 'R'
  const mode: OrbitMode =
    s.mode === 'interval' ? (s.hours < 0.1 ? 'stream' : 'periodic') : s.mode === 'unpublished' ? 'unpub' : s.mode
  return {
    id: p.address,
    name: p.name,
    fee: p.fee,
    kind,
    mode,
    h: s.mode === 'interval' ? s.hours : null,
    thresholdNim: s.mode === 'instant' ? s.thresholdNim : null,
    stake: Number(p.balanceLuna / 100_000n),
    stakers: p.stakers,
    color: p.accent ?? NEUTRAL,
    verdict: p.verdict,
    schedKey: s.label.key,
    schedVars: s.label.vars,
  }
}

// The five pools on the quick chips, in this order, when they are listed.
export const CHIP_POOLS: { name: string; short: string }[] = [
  { name: 'Garuda Pool', short: 'Garuda' },
  { name: 'Mint Pool', short: 'Mint' },
  { name: '$NIM_pool', short: '$NIM_pool' },
  { name: 'Nimiq Marketing Pool', short: 'Marketing' },
  { name: 'NimiqHub Staking', short: 'NimiqHub' },
]

export function chipPools(pools: OrbitPool[]): { pool: OrbitPool; short: string }[] {
  const named = CHIP_POOLS.flatMap(c => {
    const pool = pools.find(p => p.name === c.name)
    return pool ? [{ pool, short: c.short }] : []
  })
  if (named.length >= 3) return named
  return pools
    .filter(p => p.mode === 'periodic' || p.mode === 'stream')
    .slice(0, 5)
    .map(pool => ({ pool, short: pool.name.length > 14 ? `${pool.name.slice(0, 13)}…` : pool.name }))
}

export function defaultPoolId(pools: OrbitPool[]): string | null {
  const chips = chipPools(pools)
  return chips[0]?.pool.id ?? pools.find(p => p.mode === 'periodic')?.id ?? pools[0]?.id ?? null
}

// How many dots each pool's cloud gets. One per staker reads best, but the count comes from the
// API, so it is capped per pool and across the orbit to keep every frame cheap on a phone.
export const DOTS_PER_POOL = 300
export const DOTS_TOTAL = 1500

export function dotCounts(stakers: number[], perPool = DOTS_PER_POOL, total = DOTS_TOTAL): number[] {
  const capped = stakers.map(s => (s > 0 ? Math.min(perPool, Math.floor(s)) : 0))
  const sum = capped.reduce((a, b) => a + b, 0)
  if (sum <= total) return capped
  // shrink proportionally; the floor leaves room for every staked pool to keep one dot
  const k = (total - capped.filter(n => n > 0).length) / sum
  return capped.map(n => (n > 0 ? Math.max(1, Math.floor(n * k)) : 0))
}

export interface PayoutPlan {
  // whether there is a payout rhythm to draw
  ok: boolean
  why: 'ok' | 'none' | 'unpub' | 'noYield'
  cont: boolean
  direct: boolean
  // yearly yield after the fee
  net: number
  // hours between payouts
  h: number
  // payouts in the 7-day week, and how many have landed when the example starts
  N: number
  k: number
  stakeNow: number
  paid: number
  per: number
}

// The example stake's week in one pool: its own fee and schedule, on the network's gross yield.
export function payoutPlan(p: OrbitPool, stake: number, gross: number): PayoutPlan {
  const direct = p.kind === 'D'
  const cont = p.mode === 'stream'
  const net = gross * (1 - (p.fee ?? 0))
  const off = (why: PayoutPlan['why']): PayoutPlan => ({ ok: false, why, cont: false, direct, net: Math.max(0, net), h: 0, N: 0, k: 0, stakeNow: stake, paid: 0, per: 0 })
  if (p.mode === 'none') return off('none')
  if (p.mode === 'unpub') return off('unpub')
  const h = p.mode === 'instant' ? ((p.thresholdNim ?? 10) / (stake * net)) * 8760 : (p.h ?? 0)
  if (!(net > 0) || !(h > 0) || !Number.isFinite(h)) return off('noYield')
  const perOf = (s: number) => (s * net * h) / 8760
  const N = cont ? Math.round(168 / h) : Math.max(1, Math.min(168, Math.round(168 / h)))
  const k = Math.floor(N * 0.58)
  let stakeNow = stake
  let paid = 0
  for (let i = 0; i < k; i++) {
    const r = perOf(direct ? stake : stakeNow)
    if (direct) paid += r
    else stakeNow += r
  }
  return { ok: true, why: 'ok', cont, direct, net, h, N, k, stakeNow, paid, per: perOf(direct ? stake : stakeNow) }
}
