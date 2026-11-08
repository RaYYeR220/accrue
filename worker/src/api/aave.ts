import { Hono } from 'hono'
import { parseAbi, type Abi } from 'viem'
import { ASSETS, POLYGON, type AssetKey } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { polygonClient } from '../rpc/polygon'
import { readThrough } from './cache'

const FRESH_MS = 60_000
const STALE_MS = 15 * 60_000
const SECONDS_PER_YEAR = 31_536_000

// Aave v3 Pool reads. getReserveData returns ReserveDataLegacy (15 static words, checked against the
// live Polygon pool); getVirtualUnderlyingBalance exists from Aave 3.1 on.
export const aavePoolAbi = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
  { type: 'function', name: 'getVirtualUnderlyingBalance', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'getReserveNormalizedIncome', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const satisfies Abi

export const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function scaledBalanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export interface ReserveView {
  supplyApy: number
  liquidityRateRay: string
  liquidityIndexRay: string
  /** Aave's lastUpdateTimestamp, unix seconds */
  lastUpdate: number
  availableLiquidity: string
  utilization: number
}

const KEYS = Object.keys(ASSETS) as AssetKey[]

/** Supply APY from Aave's per-second compounding of the liquidity rate (an APR in ray). */
export function supplyApy(liquidityRateRay: bigint): number {
  const apr = Number(liquidityRateRay) / 1e27
  return Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR))
}

async function loadReserves(env: Env): Promise<string> {
  const contracts = KEYS.flatMap((k) => [
    { address: POLYGON.pool, abi: aavePoolAbi, functionName: 'getReserveData', args: [ASSETS[k].address] } as const,
    { address: ASSETS[k].aToken, abi: tokenAbi, functionName: 'totalSupply' } as const,
    { address: POLYGON.pool, abi: aavePoolAbi, functionName: 'getVirtualUnderlyingBalance', args: [ASSETS[k].address] } as const,
    { address: ASSETS[k].address, abi: tokenAbi, functionName: 'balanceOf', args: [ASSETS[k].aToken] } as const,
  ])
  const res = await polygonClient(env).multicall({ allowFailure: true, contracts })
  const reserves = {} as Record<AssetKey, ReserveView>
  KEYS.forEach((k, i) => {
    const [data, supply, virtual, cash] = res.slice(4 * i, 4 * i + 4)
    if (data?.status !== 'success' || supply?.status !== 'success') throw new Error(`aave: no reserve data for ${k}`)
    const d = data.result as { liquidityIndex: bigint; currentLiquidityRate: bigint; lastUpdateTimestamp: number }
    // Aave >= 3.1 pays withdrawals out of its virtual balance; older pools out of the aToken's underlying
    const available = virtual?.status === 'success' ? (virtual.result as bigint) : cash?.status === 'success' ? (cash.result as bigint) : null
    if (available === null) throw new Error(`aave: no liquidity for ${k}`)
    const total = supply.result as bigint
    const utilization = total > 0n ? Math.min(1, Math.max(0, 1 - Number((available * 1_000_000n) / total) / 1_000_000)) : 0
    reserves[k] = {
      supplyApy: supplyApy(d.currentLiquidityRate),
      liquidityRateRay: d.currentLiquidityRate.toString(),
      liquidityIndexRay: d.liquidityIndex.toString(),
      lastUpdate: Number(d.lastUpdateTimestamp),
      availableLiquidity: available.toString(),
      utilization: Math.round(utilization * 1e6) / 1e6,
    }
  })
  return JSON.stringify(reserves)
}

export const aave = new Hono<{ Bindings: Env }>()

// Both reserves from the Aave v3 pool on Polygon in one Multicall3 eth_call, kept 60 s (up to 15 min
// when Polygon's RPCs fail, with its own asOf).
aave.get('/', async (c) => {
  try {
    const r = await readThrough('aave:reserves', { freshMs: FRESH_MS, staleMs: STALE_MS }, () => loadReserves(c.env))
    c.header('cache-control', 'public, max-age=60')
    return c.json({ asOf: r.at, reserves: JSON.parse(r.body) as Record<AssetKey, ReserveView> })
  } catch {
    return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'polygon_rpc' }), 503)
  }
})
