import type { AssetKey } from '@accrue/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { accrue } from './accrual'
import { ASSET_KEYS, bigintField, fetchJson, isRecord, type Reserve } from './useAave'

export interface AssetPosition {
  aTokenBalance: bigint
  scaledFromAccrue: bigint
  principal: bigint
  // can dip a unit below zero from rounding right after a deposit
  earned: bigint
}

// GET /api/position/:evm
export interface Position {
  assets: Record<AssetKey, AssetPosition>
}

export function parsePosition(body: unknown): Position {
  if (!isRecord(body) || !isRecord(body.assets)) throw new Error('position: bad body')
  const assets = {} as Record<AssetKey, AssetPosition>
  for (const k of ASSET_KEYS) {
    const p = body.assets[k]
    if (!isRecord(p)) throw new Error(`position: no ${k}`)
    assets[k] = {
      aTokenBalance: bigintField(p.aTokenBalance, `${k}.aTokenBalance`),
      scaledFromAccrue: bigintField(p.scaledFromAccrue, `${k}.scaledFromAccrue`),
      principal: bigintField(p.principal, `${k}.principal`),
      earned: bigintField(p.earned, `${k}.earned`, true),
    }
  }
  return { assets }
}

export async function fetchPosition(owner: Address): Promise<Position> {
  return parsePosition(await fetchJson(`/api/position/${owner}`))
}

// Only once the owner is known (after the user connected), so nothing is read on page load.
export function usePosition(owner: Address | null) {
  return useQuery({
    queryKey: ['position', owner],
    queryFn: () => fetchPosition(owner as Address),
    enabled: owner !== null,
    staleTime: 30_000,
  })
}

// Live value for the ticker, re-computed every `intervalMs`; null until both inputs are known.
export function useAccrued(scaled: bigint | null, reserve: Reserve | undefined, intervalMs = 1_000): number | null {
  const [now, setNow] = useState(() => Date.now())
  const live = scaled !== null && reserve !== undefined
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [live, intervalMs])
  return live ? accrue(scaled, reserve.liquidityIndexRay, reserve.liquidityRateRay, reserve.lastUpdate, now) : null
}
