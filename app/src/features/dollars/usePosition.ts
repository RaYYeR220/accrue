import type { AssetKey } from '@accrue/shared'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { accrue } from './accrual'
import { fetchJson } from '../../lib/api'
import { isRecord } from '../../lib/util'
import { ASSET_KEYS, bigintField, type Reserve } from './useAave'

export interface AssetPosition {
  aTokenBalance: bigint
  // null in a partial answer: what came in through Accrue could not be read just now
  scaledFromAccrue: bigint | null
  principal: bigint | null
  // can dip a unit below zero from rounding right after a deposit
  earned: bigint | null
}

// GET /api/position/:evm
export interface Position {
  assets: Record<AssetKey, AssetPosition>
  // the router's logs could not be read: the balances are live, Accrue's own figures are missing
  partial: boolean
}

export function parsePosition(body: unknown): Position {
  if (!isRecord(body) || !isRecord(body.assets)) throw new Error('position: bad body')
  const partial = body.partial === true
  // a figure may be missing only from an answer that says it is partial
  const tracked = (v: unknown, name: string, signed = false) => (partial && v === null ? null : bigintField(v, name, signed))
  const assets = {} as Record<AssetKey, AssetPosition>
  for (const k of ASSET_KEYS) {
    const p = body.assets[k]
    if (!isRecord(p)) throw new Error(`position: no ${k}`)
    assets[k] = {
      aTokenBalance: bigintField(p.aTokenBalance, `${k}.aTokenBalance`),
      scaledFromAccrue: tracked(p.scaledFromAccrue, `${k}.scaledFromAccrue`),
      principal: tracked(p.principal, `${k}.principal`),
      earned: tracked(p.earned, `${k}.earned`, true),
    }
  }
  return { assets, partial }
}

export async function fetchPosition(owner: Address, opts: { fresh?: boolean } = {}): Promise<Position> {
  return parsePosition(await fetchJson(`/api/position/${owner}${opts.fresh ? '?fresh=1' : ''}`))
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

/**
 * Reads every shown position again now, past the server's 15 s copy (`?fresh=1`) and the query's
 * staleTime: for the moment a deposit or withdrawal lands. A failed read leaves what was shown.
 */
export async function refreshPositions(qc: QueryClient): Promise<void> {
  await qc.cancelQueries({ queryKey: ['position'] })
  const owners = qc
    .getQueryCache()
    .findAll({ queryKey: ['position'] })
    .map(q => q.queryKey[1])
    .filter((o): o is Address => typeof o === 'string')
  await Promise.all(
    owners.map(owner =>
      qc.fetchQuery({ queryKey: ['position', owner], queryFn: () => fetchPosition(owner, { fresh: true }), staleTime: 0 }).catch(() => undefined),
    ),
  )
}

// the public node that answers first may not have seen the block the relayer's node confirmed
export const POSITION_FOLLOW_UP_MS = 6_000

/** After a deposit or withdrawal lands: a fresh read now and one more a few seconds later. */
export function afterMove(qc: QueryClient): void {
  void refreshPositions(qc)
  setTimeout(() => void refreshPositions(qc), POSITION_FOLLOW_UP_MS)
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
