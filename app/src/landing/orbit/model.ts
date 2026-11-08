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
