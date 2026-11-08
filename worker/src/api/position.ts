import { Hono } from 'hono'
import { getAddress, isAddress, type Address } from 'viem'
import { ASSETS, POLYGON, type AssetKey } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { polygonClient } from '../rpc/polygon'
import { LOG_CHUNK_BLOCKS, applyEvent, holdingsFromJson, holdingsKey, routerConfig, routerEvents, scanKey, type Holdings, type RouterConfig } from '../indexer/router'
import { aavePoolAbi, tokenAbi } from './aave'
import { cacheGet, cachePut } from './cache'

const RAY = 10n ** 27n
// a request reads at most this much of the range the cron has not folded yet (about 6 h of Polygon)
const MAX_REQUEST_CHUNKS = 6
const POSITION_CACHE_MS = 15_000
const KEYS = Object.keys(ASSETS) as AssetKey[]

export interface AssetPosition {
  aTokenBalance: string
  scaledFromAccrue: string
  principal: string
  earned: string
}

class CatchingUp extends Error {}
class DbError extends Error {}

/** Accrue's holdings of an owner: what the cron folded, plus the router logs after it, read now for this owner only. */
async function accrueHoldings(env: Env, cfg: RouterConfig & { deployBlock: number }, owner: Address): Promise<Holdings> {
  const { router, deployBlock: first } = cfg
  const client = polygonClient(env)
  const [rows, head] = await Promise.all([
    env.DB.prepare('SELECT key, value FROM meta WHERE key IN (?1, ?2)')
      .bind(scanKey(router), holdingsKey(router, owner))
      .all<{ key: string; value: string }>()
      .catch((e: unknown) => {
        throw new DbError(e instanceof Error ? e.message : String(e))
      }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  const meta = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
  const scanned = meta.get(scanKey(router))
  const from = scanned !== undefined ? Number(scanned) + 1 : first
  const to = Number(head)
  if (to - from + 1 > MAX_REQUEST_CHUNKS * LOG_CHUNK_BLOCKS) throw new CatchingUp(`unscanned ${to - from + 1} blocks`)
  const holdings = holdingsFromJson(meta.get(holdingsKey(router, owner)))
  if (to >= from) for (const e of await routerEvents(client, router, from, to, owner)) applyEvent(holdings, e)
  return holdings
}

export const position = new Hono<{ Bindings: Env }>()

// An owner's Aave position per asset: the live aToken balance, and of it what came in through the
// Accrue router (scaled balance it minted, principal paid in, interest earned on that). Before the
// router is deployed the Accrue fields are zero: nothing can have come in through it.
position.get('/:evm', async (c) => {
  const raw = c.req.param('evm')
  if (!isAddress(raw, { strict: false })) return c.json(errorBody('INTERNAL', { reason: 'bad_request', field: 'owner' }), 400)
  const owner = getAddress(raw.toLowerCase())
  const key = `position:${owner}`
  const hit = await cacheGet(key, POSITION_CACHE_MS)
  if (hit) return c.body(hit.body, 200, { 'content-type': 'application/json' })

  const env = c.env
  const cfg = routerConfig(env)
  if (cfg?.misconfigured) return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'router_misconfigured' }), 503)
  const contracts = KEYS.flatMap((k) => [
    { address: ASSETS[k].aToken, abi: tokenAbi, functionName: 'balanceOf', args: [owner] } as const,
    { address: ASSETS[k].aToken, abi: tokenAbi, functionName: 'scaledBalanceOf', args: [owner] } as const,
    { address: POLYGON.pool, abi: aavePoolAbi, functionName: 'getReserveNormalizedIncome', args: [ASSETS[k].address] } as const,
  ])
  let live: bigint[]
  let holdings: Holdings
  try {
    ;[live, holdings] = await Promise.all([
      polygonClient(env).multicall({ allowFailure: false, contracts }) as Promise<bigint[]>,
      cfg ? accrueHoldings(env, cfg as RouterConfig & { deployBlock: number }, owner) : Promise.resolve({} as Holdings),
    ])
  } catch (e) {
    if (e instanceof DbError) return c.json(errorBody('INTERNAL', { reason: 'db_error' }), 500)
    return c.json(errorBody('RPC_UNAVAILABLE', { reason: e instanceof CatchingUp ? 'catching_up' : 'polygon_rpc' }), 503)
  }

  const assets = {} as Record<AssetKey, AssetPosition>
  KEYS.forEach((k, i) => {
    const [balance, scaledBalance, income] = live.slice(3 * i, 3 * i + 3) as [bigint, bigint, bigint]
    const h = holdings[k] ?? { scaled: 0n, principal: 0n }
    // aTokens moved out of the wallet were not withdrawn through Accrue; never claim more than is there
    const scaled = h.scaled > scaledBalance ? scaledBalance : h.scaled
    const principal = h.scaled > 0n ? (h.principal * scaled) / h.scaled : 0n
    assets[k] = {
      aTokenBalance: balance.toString(),
      scaledFromAccrue: scaled.toString(),
      principal: principal.toString(),
      earned: ((scaled * income) / RAY - principal).toString(),
    }
  })
  const json = JSON.stringify({ assets })
  await cachePut(key, json, POSITION_CACHE_MS)
  return c.body(json, 200, { 'content-type': 'application/json' })
})
