import { Hono } from 'hono'
import { userExpected, userVerdict, type Verdict } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { nimRpc, RpcUnavailable } from '../rpc/nimiq'
import { canonicalAddress, hourFromDb, userWindowFromAggregates, type PoolHourDb } from '../indexer/aggregate'
import { payoutTypeOf, scheduleMsOf } from '../indexer/pools'
import { VERDICTS_KEY, currentEntry, parseVerdictCache, windowRange, type CursorReachRow } from '../indexer/verdicts'
import { cacheGet, cachePut } from './cache'
import { compactNim, parseNimAddress } from './nim'
import { POOL_COLUMNS, WINDOW_DAYS, poolView, type PoolDbRow, type PoolView } from './pools'

// one tap after another should not cost the public RPC another call
const CHECK_CACHE_MS = 30_000

interface RpcStaker {
  balance?: unknown
  delegation?: unknown
  inactiveBalance?: unknown
  inactiveFrom?: unknown
  retiredBalance?: unknown
}

export interface StakerView {
  activeLuna: string
  inactiveLuna: string
  inactiveFrom: number | null
  retiredLuna: string
  delegation: string | null
}

export interface CheckBody {
  staker: StakerView | null
  pool?: PoolView
  expectedLuna?: string
  receivedLuna?: string
  verdict?: Verdict
  pct?: number | null
  windowDays: number
}

const luna = (v: unknown, missing: string | null): string | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v === undefined || v === null ? missing : null

/** The RPC's staker, or null when it is not shaped like one (treated as an RPC fault). */
function stakerView(r: RpcStaker): StakerView | null {
  const active = luna(r.balance, null)
  const inactive = luna(r.inactiveBalance, '0')
  const retired = luna(r.retiredBalance, '0')
  if (active === null || inactive === null || retired === null) return null
  if (r.delegation !== null && r.delegation !== undefined && typeof r.delegation !== 'string') return null
  return {
    activeLuna: active,
    inactiveLuna: inactive,
    // a block number (set-inactive stores the next election block), as the RPC gives it
    inactiveFrom: typeof r.inactiveFrom === 'number' && Number.isSafeInteger(r.inactiveFrom) ? r.inactiveFrom : null,
    retiredLuna: retired,
    delegation: typeof r.delegation === 'string' && r.delegation.trim() ? canonicalAddress(r.delegation) : null,
  }
}

/**
 * The pool's verdict caps the staker's. Expected uses today's stakes, so a staker who added stake
 * during the week, or a pool that shrank, reads low without being short-changed: a staker reads
 * SHORT only while the pool-level data shows the pool SHORT. Behind schedule and routed payouts hold
 * for every staker of the pool.
 */
export function stakerVerdict(user: Verdict, pool: Verdict | null): Verdict {
  if (pool === 'BEHIND_SCHEDULE' || pool === 'CANT_VERIFY_ROUTED') return pool
  if (user === 'SHORT' && pool !== 'SHORT') return 'NOT_ENOUGH_DATA'
  return user
}

async function checkBody(env: Env, address: string, staker: StakerView): Promise<CheckBody> {
  const base: CheckBody = { staker, windowDays: WINDOW_DAYS }
  const pool = staker.delegation
  if (!pool) return base
  // the window starts 7 days before the data's reach; the bounds come from the cursor in the same query
  const since = (unit: number) => `(SELECT (reach_ts - 604800000) / ${unit} FROM pool_cursor WHERE pool = ?1)`
  const [poolRes, metaRes, cursorRes, hourRes, dayRes] = await env.DB.batch([
    env.DB.prepare(`SELECT ${POOL_COLUMNS} FROM pools WHERE address = ?1 AND listed = 1`).bind(pool),
    env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(VERDICTS_KEY),
    env.DB.prepare('SELECT pool, reach_ts, resume_hash, hole_from_ts, hole_to_ts FROM pool_cursor WHERE pool = ?1').bind(pool),
    env.DB.prepare(
      'SELECT hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts ' +
        `FROM pool_hour WHERE pool = ?1 AND hour >= ${since(3_600_000)}`,
    ).bind(pool),
    env.DB.prepare(`SELECT day, received, payouts FROM staker_day WHERE pool = ?1 AND staker = ?2 AND day >= ${since(86_400_000)}`).bind(pool, address),
  ])
  const row = poolRes?.results?.[0] as PoolDbRow | undefined
  if (!row) return base
  const cache = parseVerdictCache((metaRes?.results?.[0] as { value?: string } | undefined)?.value)
  const out: CheckBody = { ...base, pool: poolView(row, cache) }
  if (payoutTypeOf(row.payout_type) === 'none') return { ...out, verdict: 'NO_PAYOUTS_BY_DESIGN', pct: null }
  const entry = currentEntry(row, cache)
  const cursor = cursorRes?.results?.[0] as CursorReachRow | undefined
  if (!entry?.verdict || row.fee === null || !cursor || cursor.reach_ts === null) return out

  const hours = ((hourRes?.results ?? []) as PoolHourDb[]).map(hourFromDb)
  const days = ((dayRes?.results ?? []) as { day: number; received: number; payouts: number }[]).map((d) => ({
    day: d.day, payouts: d.payouts, received: BigInt(d.received),
  }))
  const u = userWindowFromAggregates(hours, days, { ...windowRange(cursor, scheduleMsOf(row.schedule)), cycleMs: entry.cycleMs })
  if (!u) return { ...out, verdict: stakerVerdict('NOT_ENOUGH_DATA', entry.verdict), pct: null }
  const expected = userExpected({ userActiveStake: BigInt(staker.activeLuna), poolStake: BigInt(Math.round(row.balance ?? 0)), poolEarned: u.earned, fee: row.fee })
  const uv = userVerdict({ expected, received: u.received, cycles: u.payouts })
  return { ...out, expectedLuna: String(expected), receivedLuna: String(u.received), verdict: stakerVerdict(uv.verdict, entry.verdict), pct: uv.pct }
}

export const check = new Hono<{ Bindings: Env }>()

check.get('/:address', async (c) => {
  const address = parseNimAddress(c.req.param('address'))
  if (!address) return c.json(errorBody('INTERNAL', { reason: 'bad_request', field: 'address' }), 400)
  const key = `check:${compactNim(address)}`
  const hit = await cacheGet(key, CHECK_CACHE_MS)
  if (hit) return c.body(hit.body, 200, { 'content-type': 'application/json' })

  let staker: StakerView | null
  try {
    staker = stakerView(await nimRpc<RpcStaker>(c.env, 'getStakerByAddress', [address]))
    if (!staker) return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'nimiq_rpc' }), 503)
  } catch (e) {
    // the RPC says "No staker with address" in error.data; anything else is a fault, never a "no"
    if (!(e instanceof RpcUnavailable && e.causes.length && e.causes.every((x) => /No staker/i.test(x)))) {
      return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'nimiq_rpc' }), 503)
    }
    staker = null
  }
  let body: CheckBody
  try {
    body = staker ? await checkBody(c.env, address, staker) : { staker: null, windowDays: WINDOW_DAYS }
  } catch {
    return c.json(errorBody('INTERNAL', { reason: 'db_error' }), 500)
  }
  const json = JSON.stringify(body)
  await cachePut(key, json, CHECK_CACHE_MS)
  return c.body(json, 200, { 'content-type': 'application/json' })
})
