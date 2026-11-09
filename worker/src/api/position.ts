import { Hono } from 'hono'
import { getAddress, isAddress, type Address } from 'viem'
import { ASSETS, POLYGON, type AssetKey } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { polygonClient, polygonLogClient } from '../rpc/polygon'
import { LOG_CHUNK_BLOCKS, applyEvent, holdingsFromJson, holdingsKey, routerConfig, routerEvents, scanKey, type Holdings, type RouterConfig } from '../indexer/router'
import { aavePoolAbi, tokenAbi } from './aave'
import { cacheGet, cachePut } from './cache'

const RAY = 10n ** 27n
// a request reads at most this much of the range the cron has not folded yet (about 6 h of Polygon)
const MAX_REQUEST_CHUNKS = 6
const POSITION_CACHE_MS = 15_000
// `?fresh=1` (the app, right after a deposit or withdrawal lands) skips a copy older than this; at
// most one such read per owner in that time, so it cannot be used to hammer the RPCs
const FRESH_MIN_MS = 3_000
// per node: a stalled public node costs this long before the next one is asked
const READ_TIMEOUT_MS = 2_500
// what Accrue tracks never holds up the balances a withdrawal needs for longer than this
const HOLDINGS_BUDGET_MS = 3_000
const KEYS = Object.keys(ASSETS) as AssetKey[]

export interface AssetPosition {
  aTokenBalance: string
  /** null in a partial answer: the router's logs could not be read */
  scaledFromAccrue: string | null
  principal: string | null
  earned: string | null
}

/** Why Accrue's own fields are missing: the cron's fold is too far behind, no node served the logs, or D1 failed. */
export type PartialReason = 'catching_up' | 'router_logs' | 'db_error'

class Partial extends Error {
  constructor(
    readonly reason: PartialReason,
    message: string,
  ) {
    super(message)
  }
}

/** Accrue's holdings of an owner: what the cron folded, plus the router logs after it, read now for this owner only. */
async function accrueHoldings(env: Env, cfg: RouterConfig & { deployBlock: number }, owner: Address): Promise<Holdings> {
  const { router, deployBlock: first } = cfg
  const client = polygonLogClient(env, { timeoutMs: READ_TIMEOUT_MS })
  const [rows, head] = await Promise.all([
    env.DB.prepare('SELECT key, value FROM meta WHERE key IN (?1, ?2)')
      .bind(scanKey(router), holdingsKey(router, owner))
      .all<{ key: string; value: string }>()
      .catch((e: unknown) => {
        throw new Partial('db_error', e instanceof Error ? e.message : String(e))
      }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  const meta = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
  const scanned = meta.get(scanKey(router))
  const from = scanned !== undefined ? Number(scanned) + 1 : first
  const to = Number(head)
  if (to - from + 1 > MAX_REQUEST_CHUNKS * LOG_CHUNK_BLOCKS) throw new Partial('catching_up', `unscanned ${to - from + 1} blocks`)
  const holdings = holdingsFromJson(meta.get(holdingsKey(router, owner)))
  if (to >= from) for (const e of await routerEvents(client, router, from, to, owner)) applyEvent(holdings, e)
  return holdings
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Partial('router_logs', `no answer within ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

const asPartial = (e: unknown) => (e instanceof Partial ? e : new Partial('router_logs', e instanceof Error ? e.message : String(e)))

export const position = new Hono<{ Bindings: Env }>()

// An owner's Aave position per asset: the live aToken balance, and of it what came in through the
// Accrue router (scaled balance it minted, principal paid in, interest earned on that). Before the
// router is deployed the Accrue fields are zero: nothing can have come in through it. When the
// router's logs cannot be read, the answer is partial: the balances (all a withdrawal needs) with
// the Accrue fields null, never cached, so the next request tries again.
position.get('/:evm', async (c) => {
  const raw = c.req.param('evm')
  if (!isAddress(raw, { strict: false })) return c.json(errorBody('INTERNAL', { reason: 'bad_request', field: 'owner' }), 400)
  const owner = getAddress(raw.toLowerCase())
  const key = `position:${owner}`
  const hit = await cacheGet(key, c.req.query('fresh') === '1' ? FRESH_MIN_MS : POSITION_CACHE_MS)
  if (hit) return c.body(hit.body, 200, { 'content-type': 'application/json' })

  const env = c.env
  const cfg = routerConfig(env)
  if (cfg?.misconfigured) return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'router_misconfigured' }), 503)
  const contracts = KEYS.flatMap((k) => [
    { address: ASSETS[k].aToken, abi: tokenAbi, functionName: 'balanceOf', args: [owner] } as const,
    { address: ASSETS[k].aToken, abi: tokenAbi, functionName: 'scaledBalanceOf', args: [owner] } as const,
    { address: POLYGON.pool, abi: aavePoolAbi, functionName: 'getReserveNormalizedIncome', args: [ASSETS[k].address] } as const,
  ])
  const tracked: Promise<Holdings | Partial> = cfg
    ? within(accrueHoldings(env, cfg as RouterConfig & { deployBlock: number }, owner), HOLDINGS_BUDGET_MS).catch(asPartial)
    : Promise.resolve({})
  let live: bigint[]
  try {
    live = (await polygonClient(env, { timeoutMs: READ_TIMEOUT_MS }).multicall({ allowFailure: false, contracts })) as bigint[]
  } catch {
    return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'polygon_rpc' }), 503)
  }
  const holdings = await tracked
  const partial = holdings instanceof Partial ? holdings : null
  if (partial) console.warn(`position: partial (${partial.reason}) ${partial.message.slice(0, 160)}`)

  const assets = {} as Record<AssetKey, AssetPosition>
  KEYS.forEach((k, i) => {
    const [balance, scaledBalance, income] = live.slice(3 * i, 3 * i + 3) as [bigint, bigint, bigint]
    if (partial) {
      assets[k] = { aTokenBalance: balance.toString(), scaledFromAccrue: null, principal: null, earned: null }
      return
    }
    const h = (holdings as Holdings)[k] ?? { scaled: 0n, principal: 0n }
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
  if (partial) return c.json({ partial: true, reason: partial.reason, assets }, 200, { 'cache-control': 'no-store' })
  const json = JSON.stringify({ assets })
  await cachePut(key, json, POSITION_CACHE_MS)
  return c.body(json, 200, { 'content-type': 'application/json' })
})
