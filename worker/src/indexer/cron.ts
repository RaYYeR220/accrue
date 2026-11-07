import type { NimTx } from '@accrue/shared'
import type { Env } from '../env'
import { DAY_MS, HOUR_MS, aggregate, canonicalAddress, dayOf, delegationOracle, payoutRecipients } from './aggregate'
import { cursorResetStatement, fetchValidators, poolStatements, rewardMissStatement, rewardStatement, scannable, type PoolRow } from './pools'
import { Budget, BudgetExhausted, PAGE_TOKENS, rpcSource, scanPool, type Cursor, type NimSource } from './scan'
import { bind, cursorWrite, delegationUpsert, hourUpsert, metaSet, stakerDayUpsert, type Guard, type Stmt } from './store'

export const SUBREQUEST_BUDGET = 25
// the public RPC grants 20 tokens per 10 s per IP and a tick runs inside one window; keep slack
export const RPC_TOKENS = 18
const POOLS_SYNC_MS = HOUR_MS
const REWARD_RECHECK_MS = 24 * HOUR_MS
const REWARD_CHECKS_PER_TICK = 2
// a visit is worth a subrequest once roughly this many new txs are waiting (a page holds 500)
const TARGET_TXS = 400
const MAX_STALE_MS = 90 * 60_000
export const DELEGATION_TTL_MS = 7 * DAY_MS
// stakers leave pools; a "not a staker" answer is cheaper to re-check sooner
const NOT_STAKER_TTL_MS = DAY_MS
// a known reward address is dropped only after this many "No validator" answers in a row, an hour apart
const REWARD_MISSES_TO_DROP = 2
const REWARD_MISS_RECHECK_MS = HOUR_MS

export interface CursorRow {
  pool: string
  newest_hash: string | null
  newest_block: number | null
  oldest_block: number | null
  backfill_done: number | null
  resume_hash: string | null
  floor_block: number | null
  last_payout_block: number | null
  visited_at: number | null
  txs_per_hour: number | null
  reach_ts: number | null
  hole_from_ts: number | null
  hole_to_ts: number | null
}

export const cursorFromRow = (r: CursorRow): Cursor => ({
  newestHash: r.newest_hash,
  newestBlock: r.newest_block,
  oldestBlock: r.oldest_block,
  backfillDone: !!r.backfill_done,
  resumeHash: r.resume_hash,
  floorBlock: r.floor_block,
  lastPayoutBlock: r.last_payout_block,
  visitedAt: r.visited_at,
  txsPerHour: r.txs_per_hour,
  reachTs: r.reach_ts ?? null,
  holeFromTs: r.hole_from_ts ?? null,
  holeToTs: r.hole_to_ts ?? null,
})

/**
 * >= 1 means the pool is due. Open descents and first visits sit at fixed levels, so a long
 * catch-up cannot starve pools whose backlog keeps growing.
 */
export function visitPriority(c: Cursor | null, now: number): number {
  if (!c) return 1.2
  if (c.resumeHash) return 1.5
  const age = now - (c.visitedAt ?? 0)
  return Math.max(((c.txsPerHour ?? 0) * age) / HOUR_MS / TARGET_TXS, age / MAX_STALE_MS)
}

interface Visit {
  pool: PoolRow & { reward_address: string }
  before: Cursor | null
  cursor: Cursor | null
  txs: NimTx[]
  pages: number
  fromHead: boolean
  error: string | null
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]

export interface TickDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetch?: typeof fetch
  source?: (budget: Budget) => NimSource
}

export interface TickResult {
  poolsTouched: number
  pages: number
  lagMinutes: number
}

/**
 * One cron invocation: refresh pool metadata (hourly), visit the pools with the largest backlog
 * (at most `maxPages` RPC pages), check payout recipients' delegation, and fold the new txs into
 * pool_hour / staker_day in a single D1 batch together with the moved cursors. Never throws; an
 * RPC or D1 failure keeps the last data and lands in meta.indexer_last_error.
 */
export async function runIndexerTick(
  env: Env,
  budget: { maxPages: number; maxMs: number; maxSubrequests?: number; rpcTokens?: number },
  deps: TickDeps = {},
): Promise<TickResult> {
  const clock = deps.now ?? Date.now
  const now = clock()
  const b = new Budget(budget.maxSubrequests ?? SUBREQUEST_BUDGET, now + budget.maxMs, clock, budget.rpcTokens ?? RPC_TOKENS)
  // calls kept free for what must follow: the delegation-cache read and the final write batch, then
  // only the write
  let reserve = 2
  const src = deps.source ? deps.source(b) : rpcSource(env, b, { sleep: deps.sleep, reserve: () => reserve })
  const errors: string[] = []
  // pool metadata, reward addresses, delegations, meta: valid on their own
  const writes: Stmt[] = []
  // aggregates and the cursors they belong to: only written together, from a complete tick
  const scanWrites: Stmt[] = []
  const visits: Visit[] = []
  const cursors = new Map<string, Cursor>()
  const pools = new Map<string, PoolRow>()
  let pages = 0
  let rpcDown = false

  const rpc = async <T>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    if (rpcDown) return undefined
    try {
      return await f()
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) {
        rpcDown = true
        errors.push(`${what}: ${msg(e)}`)
      }
      return undefined
    }
  }

  try {
    b.charge()
    const [poolRes, cursorRes, metaRes] = await env.DB.batch([
      env.DB.prepare(
        'SELECT address, name, reward_address, fee, payout_type, schedule, listed, reward_checked_at, reward_misses, logo IS NULL AS no_logo FROM pools',
      ),
      env.DB.prepare(
        'SELECT pool, newest_hash, newest_block, oldest_block, backfill_done, resume_hash, floor_block, last_payout_block, visited_at, txs_per_hour, reach_ts, hole_from_ts, hole_to_ts FROM pool_cursor',
      ),
      env.DB.prepare("SELECT updated_at FROM meta WHERE key = 'pools_synced_at'"),
    ])
    const poolRows = rows<PoolRow & { no_logo: number }>(poolRes)
    for (const p of poolRows) pools.set(p.address, p)
    for (const r of rows<CursorRow>(cursorRes)) cursors.set(r.pool, cursorFromRow(r))
    const syncedAt = rows<{ updated_at: number }>(metaRes)[0]?.updated_at ?? 0

    // Pool metadata, hourly. The API inlines logos (up to ~360 kB each), so they are written once a
    // day or when missing, in their own batch; a sync tick also scans a single page to keep CPU low.
    let maxPages = budget.maxPages
    if (now - syncedAt >= POOLS_SYNC_MS && b.can(2, reserve)) {
      b.take()
      try {
        const list = await fetchValidators(deps.fetch ?? fetch)
        const withLogo = poolRows.length === 0 || poolRows.some((p) => p.no_logo) || dayOf(now) !== dayOf(syncedAt)
        b.take()
        await env.DB.batch(bind(env.DB, [...poolStatements(list, now, { withLogo }), metaSet('pools_synced_at', String(list.length), now)]))
        const keep = new Set<string>()
        for (const v of list) {
          const address = canonicalAddress(v.address)
          keep.add(address)
          const old = pools.get(address)
          pools.set(address, {
            address, name: v.name, reward_address: old?.reward_address ?? null, fee: v.fee, payout_type: v.payoutType,
            schedule: v.payoutSchedule, listed: v.isListed === false ? 0 : 1, reward_checked_at: old?.reward_checked_at ?? null,
            reward_misses: old?.reward_misses ?? 0,
          })
        }
        for (const p of pools.values()) if (!keep.has(p.address)) p.listed = 0
        maxPages = Math.min(maxPages, 1)
      } catch (e) {
        errors.push(`pools sync: ${msg(e)}`)
      }
    }

    // reward addresses: unknown ones first, then a slow re-check
    const rewardDue = [...pools.values()]
      .filter((p) => p.listed === 1 && (p.reward_checked_at === null || now - p.reward_checked_at >= REWARD_RECHECK_MS))
      .sort((x, y) => (x.reward_checked_at ?? 0) - (y.reward_checked_at ?? 0))
      .slice(0, REWARD_CHECKS_PER_TICK)
    const skip = new Set<string>()
    for (const p of rewardDue) {
      if (!b.can(1, reserve + 1, 1 + PAGE_TOKENS)) break
      const reward = await rpc(`reward ${p.name}`, () => src.rewardAddress(p.address))
      if (reward === undefined) break
      if (reward === null && p.reward_address) {
        // one "No validator" for a validator we know is not enough to stop indexing it
        const misses = (p.reward_misses ?? 0) + 1
        if (misses < REWARD_MISSES_TO_DROP) {
          writes.push(rewardMissStatement(p.address, misses, now - REWARD_RECHECK_MS + REWARD_MISS_RECHECK_MS))
          errors.push(`reward ${p.name}: validator not found (${misses}/${REWARD_MISSES_TO_DROP}), keeping ${p.reward_address}`)
          p.reward_misses = misses
          continue
        }
      }
      // a new reward address and the cursor reset it needs travel together in `writes`
      writes.push(rewardStatement(p.address, reward, now))
      if (reward && p.reward_address && reward !== p.reward_address && cursors.has(p.address)) {
        writes.push(cursorResetStatement(p.address))
        skip.add(p.address)
      }
      p.reward_address = reward
      p.reward_checked_at = now
      p.reward_misses = 0
    }

    const due = [...pools.values()]
      .filter(scannable)
      .filter((p) => !skip.has(p.address))
      .map((p) => ({ p, c: cursors.get(p.address) ?? null }))
      .map((x) => ({ ...x, prio: visitPriority(x.c, now) }))
      .filter((x) => x.prio >= 1)
      .sort((x, y) => y.prio - x.prio || (x.c?.visitedAt ?? 0) - (y.c?.visitedAt ?? 0))

    const canFetch = () => !rpcDown && pages < maxPages && b.can(1, reserve, PAGE_TOKENS)
    const step = async (v: Visit, n: number) => {
      const s = await scanPool(src, v.pool.reward_address, v.cursor, { maxPages: n, now, canFetch })
      pages += s.pages
      v.pages += s.pages
      v.txs.push(...s.txs)
      v.cursor = s.cursor
      v.fromHead ||= s.fromHead && s.pages > 0
      if (s.error) {
        v.error = s.error
        rpcDown = true
        errors.push(`${v.pool.name}: ${s.error}`)
      }
    }
    // one page per due pool first, then leftover pages to descents still open
    for (const { p, c } of due) {
      if (!canFetch()) break
      const v: Visit = { pool: p, before: c, cursor: c, txs: [], pages: 0, fromHead: false, error: null }
      await step(v, 1)
      if (v.pages > 0) visits.push(v)
    }
    for (const v of visits) {
      while (canFetch() && v.cursor?.resumeHash && !v.error) {
        const had = v.pages
        await step(v, maxPages - pages)
        if (v.pages === had) break
      }
    }

    // delegation of every payout recipient seen this tick: cached rows, then lookups for the
    // unknown ones and, budget permitting, the stale ones
    const recipients = new Set<string>()
    for (const v of visits) for (const a of payoutRecipients(v.txs, v.pool.reward_address)) recipients.add(a)
    const cache = new Map<string, { delegation: string; checkedAt: number }>()
    if (recipients.size) {
      const list = [...recipients]
      const chunks: string[][] = []
      for (let i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100))
      b.charge()
      const res = await env.DB.batch(
        chunks.map((ch) =>
          env.DB.prepare(`SELECT address, delegation, checked_at FROM recipient_delegation WHERE address IN (${ch.map(() => '?').join(', ')})`).bind(...ch),
        ),
      )
      for (const r of res) {
        for (const row of rows<{ address: string; delegation: string; checked_at: number }>(r)) {
          cache.set(row.address, { delegation: row.delegation, checkedAt: row.checked_at })
        }
      }
      reserve = 1
      const stale = (e: { delegation: string; checkedAt: number }) =>
        now - e.checkedAt >= (e.delegation === '' ? NOT_STAKER_TTL_MS : DELEGATION_TTL_MS)
      const todo = [
        ...list.filter((a) => !cache.has(a)),
        ...list.filter((a) => cache.has(a) && stale(cache.get(a)!)).sort((x, y) => cache.get(x)!.checkedAt - cache.get(y)!.checkedAt),
      ]
      for (const a of todo) {
        if (!b.can(1, reserve, 1)) break
        const d = await rpc(`staker ${a}`, () => src.delegation(a))
        if (d === undefined) break
        cache.set(a, { delegation: d, checkedAt: now })
        writes.push(delegationUpsert(a, d, now))
      }
    }
    const delegations = new Map([...cache].map(([a, e]) => [a, e.delegation]))

    for (const v of visits) {
      const before = v.before
      const g: Guard = before ? { pool: v.pool.address, newestBlock: before.newestBlock, resumeHash: before.resumeHash } : 'new'
      // the slice continues from the head only when this tick started there
      const prev = v.fromHead ? (before?.lastPayoutBlock ?? null) : null
      const agg = aggregate(v.txs, { rewardAddress: v.pool.reward_address }, delegationOracle(delegations, v.pool.address), prev)
      for (const h of agg.hours) scanWrites.push(hourUpsert(v.pool.address, h, g))
      for (const s of agg.stakerDays) scanWrites.push(stakerDayUpsert(v.pool.address, s, g))
      const cursor = v.cursor!
      if (v.fromHead) cursor.lastPayoutBlock = agg.lastPayoutBlock
      scanWrites.push(cursorWrite(v.pool.address, cursor, g))
    }
    writes.push(...scanWrites)
    for (const v of visits) cursors.set(v.pool.address, v.cursor!)
  } catch (e) {
    // a half-built scan could move a cursor without its aggregates: none of it is written
    errors.push(msg(e))
    visits.length = 0
  }

  const ages = [...pools.values()]
    .filter(scannable)
    .map((p) => cursors.get(p.address)?.visitedAt)
    .filter((t): t is number => typeof t === 'number')
    .map((t) => now - t)
  const lagMinutes = Math.round(Math.max(0, ...ages) / 60_000)
  const poolsTouched = visits.length
  if (errors.length === 0 || pages > 0) {
    writes.push(metaSet('indexer_last_ok', JSON.stringify({ pages, pools: poolsTouched, lagMinutes, subrequests: b.used + 1 }), now))
  }
  writes.push(metaSet('indexer_last_error', errors.join('; ').slice(0, 500), now))

  try {
    b.charge()
    await env.DB.batch(bind(env.DB, writes))
  } catch (e) {
    try {
      await env.DB.batch(bind(env.DB, [metaSet('indexer_last_error', `write failed: ${msg(e)}`.slice(0, 500), now)]))
    } catch {
      // D1 itself is down; nothing left to record into
    }
    return { poolsTouched: 0, pages, lagMinutes }
  }
  return { poolsTouched, pages, lagMinutes }
}
