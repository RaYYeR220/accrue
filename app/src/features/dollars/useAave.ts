import { ASSETS, type AssetKey } from '@accrue/shared'
import { useQuery } from '@tanstack/react-query'
import { HttpError } from '../../providers/errors'

export interface Reserve {
  supplyApy: number
  liquidityRateRay: bigint
  liquidityIndexRay: bigint
  // unix seconds (Aave's lastUpdateTimestamp)
  lastUpdate: number
  availableLiquidity: bigint
  utilization: number
}

// GET /api/aave: reserve data read from the Aave pool on Polygon
export interface AaveReserves {
  asOf: number
  reserves: Record<AssetKey, Reserve>
}

export const ASSET_KEYS = Object.keys(ASSETS) as AssetKey[]

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function bigintField(v: unknown, what: string, signed = false): bigint {
  const re = signed ? /^-?\d{1,78}$/ : /^\d{1,78}$/
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`${what}: not an integer string`)
  return BigInt(v)
}

export async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(path, { signal: AbortSignal.timeout(10_000) })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, body)
  return body
}

// Throws rather than let a malformed number reach the screen.
export function parseAave(body: unknown): AaveReserves {
  if (!isRecord(body) || !finite(body.asOf) || !isRecord(body.reserves)) throw new Error('aave: bad body')
  const reserves = {} as Record<AssetKey, Reserve>
  for (const k of ASSET_KEYS) {
    const r = body.reserves[k]
    if (!isRecord(r)) throw new Error(`aave: no ${k} reserve`)
    if (!finite(r.supplyApy) || !finite(r.lastUpdate) || !finite(r.utilization)) throw new Error(`aave: bad ${k} numbers`)
    reserves[k] = {
      supplyApy: r.supplyApy,
      liquidityRateRay: bigintField(r.liquidityRateRay, `${k}.liquidityRateRay`),
      liquidityIndexRay: bigintField(r.liquidityIndexRay, `${k}.liquidityIndexRay`),
      lastUpdate: r.lastUpdate,
      availableLiquidity: bigintField(r.availableLiquidity, `${k}.availableLiquidity`),
      utilization: r.utilization,
    }
  }
  return { asOf: body.asOf, reserves }
}

export async function fetchAave(): Promise<AaveReserves> {
  return parseAave(await fetchJson('/api/aave'))
}

// The worker caches this for 60 s, so polling faster would only re-read the same copy.
export function useAave() {
  return useQuery({ queryKey: ['aave'], queryFn: fetchAave, staleTime: 60_000, refetchInterval: 60_000, retry: 1 })
}
