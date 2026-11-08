import { ASSETS, type AssetKey } from '@accrue/shared'
import { useEffect, useMemo, useState } from 'react'
import { accrue, perSecond, RAY, scaledFromBalance } from '../features/dollars/accrual'
import type { Reserve } from '../features/dollars/useAave'
import { useApp } from './context'

export const ASSET_KEYS = Object.keys(ASSETS) as AssetKey[]

export function useNow(intervalMs: number, on = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, on])
  return now
}

const YEAR_MS = 31_536_000_000n
const toMs = (t: number) => (t > 1e12 ? t : t * 1000)

// Aave's normalized income at `nowMs`: the liquidity index carried forward at the current rate.
export function indexAt(r: Reserve, nowMs: number): bigint {
  const dt = BigInt(Math.max(0, Math.floor(nowMs - toMs(r.lastUpdate))))
  return (r.liquidityIndexRay * (RAY * YEAR_MS + r.liquidityRateRay * dt)) / (RAY * YEAR_MS)
}

export interface LiveAsset {
  // whole tokens, growing every second
  value: number
  balance: bigint
  scaled: bigint
  index: bigint
  perSecond: number
  reserve: Reserve
}

export interface LiveDollars {
  // null until both the position and the reserves are known
  total: number | null
  perSecond: number
  assets: Partial<Record<AssetKey, LiveAsset>>
}

// The Aave position, ticking: aToken balances read once, carried forward with Aave's own formula.
export function useLiveDollars(tick = true): LiveDollars {
  const { position, aave } = useApp()
  const known = position.data !== undefined && aave.data !== undefined
  const now = useNow(1_000, tick && known)
  const base = useMemo(() => {
    if (!position.data || !aave.data) return null
    const at = position.dataUpdatedAt
    const out: Partial<Record<AssetKey, Omit<LiveAsset, 'value' | 'index'>>> = {}
    for (const k of ASSET_KEYS) {
      const p = position.data.assets[k]
      const r = aave.data.reserves[k]
      if (!p || !r || p.aTokenBalance === 0n) continue
      // rounded up: the floor would show a fresh balance a unit below what Aave reports
      const scaled = scaledFromBalance(p.aTokenBalance, r.liquidityIndexRay, r.liquidityRateRay, r.lastUpdate, at) + 1n
      out[k] = { balance: p.aTokenBalance, scaled, perSecond: perSecond(scaled, r.liquidityIndexRay, r.liquidityRateRay), reserve: r }
    }
    return out
  }, [position.data, position.dataUpdatedAt, aave.data])

  if (!base) return { total: null, perSecond: 0, assets: {} }
  const assets: LiveDollars['assets'] = {}
  let total = 0
  let ps = 0
  for (const [k, a] of Object.entries(base) as [AssetKey, Omit<LiveAsset, 'value' | 'index'>][]) {
    const value = accrue(a.scaled, a.reserve.liquidityIndexRay, a.reserve.liquidityRateRay, a.reserve.lastUpdate, now)
    assets[k] = { ...a, value, index: indexAt(a.reserve, now) }
    total += value
    ps += a.perSecond
  }
  return { total, perSecond: ps, assets }
}
