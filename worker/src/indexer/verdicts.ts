import { poolVerdict, type PoolWindow, type Verdict } from '@accrue/shared'
import type { Env } from '../env'
import { DAY_MS, HOUR_MS, dayOf, hourFromDb, poolWindowsFromAggregates, type PoolHourDb } from './aggregate'
import { payoutTypeOf, scheduleMsOf } from './pools'
import { bind, metaSet, type Stmt } from './store'

export const VERDICTS_KEY = 'pool_verdicts'
export const PRUNED_KEY = 'pruned_day'
export const WINDOW_MS = 7 * DAY_MS
// bump when the verdict logic changes, so a deploy recomputes every cached verdict
const LOGIC_VERSION = 1
// a pool's data moves with every visit (ImpactZero: every tick); its verdict is refreshed at most this often
const REFRESH_MS = 15 * 60_000
// rows older than a pool's window, minus this slack, are no longer read by anything
const KEEP_DAYS_BEFORE_WINDOW = 1

export interface VerdictEntry {
  verdict: Verdict | null
  ratio: number | null
  expectedRatio: number | null
  lastPayoutTs: number | null
  reasons: string[]
  /** the pool's value-weighted payout cycle, for staker windows (check API) */
  cycleMs: number | null
  /** how far the data behind this verdict reached */
  reachTs: number | null
  /** metadata and data the entry was computed from; a change triggers a refresh */
  meta: string
  data: string
  at: number
}

export interface VerdictCache {
  at: number
  pools: Record<string, VerdictEntry>
}

export interface PoolMetaRow {
  address: string
  fee: number | null
  payout_type: string | null
  schedule: string | null
  reward_address: string | null
  listed: number
}

export interface CursorReachRow {
  pool: string
  reach_ts: number | null
  resume_hash: string | null
  hole_from_ts: number | null
  hole_to_ts: number | null
}

export function parseVerdictCache(raw: string | null | undefined): VerdictCache | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as VerdictCache
    return c && typeof c.at === 'number' && c.pools && typeof c.pools === 'object' ? c : null
  } catch {
    return null
  }
}

/** Range of a pool's payout window: the data's reach back 7 days, the open descent's hole avoided. */
export function windowRange(c: CursorReachRow, scheduleMs: number | null) {
  const toTs = c.reach_ts!
  return {
    fromTs: toTs - WINDOW_MS,
    toTs,
    scheduleMs,
    hole: c.resume_hash ? { fromTs: c.hole_from_ts ?? 0, toTs: c.hole_to_ts ?? toTs } : null,
  }
}

const CATCHING_UP = 'The indexer is still catching up on recent transactions of this pool; the window uses the part it has.'
const NOT_INDEXED = "This pool's payouts have not been indexed yet."
const NO_FEE = 'The pool does not publish a fee, so there is no promised share to check its payouts against.'

export const metaKey = (p: PoolMetaRow) => JSON.stringify([LOGIC_VERSION, p.fee, payoutTypeOf(p.payout_type), p.schedule ?? '', p.reward_address])

/**
 * The cached verdict of a pool as long as it was computed for the pool's current fee, payout type,
 * schedule and reward address; pools that need no data get theirs on the spot. Otherwise null.
 */
export function currentEntry(p: PoolMetaRow, cache: VerdictCache | null): Omit<VerdictEntry, 'meta' | 'data' | 'at'> | null {
  const e = cache?.pools[p.address]
  if (e && e.meta === metaKey(p)) return e
  if (payoutTypeOf(p.payout_type) === 'none' || p.fee === null) return quickEntry(p, undefined)
  return null
}

export const NOT_CHECKED = 'Payout Check has not looked at this pool yet.'
const dataKey = (c: CursorReachRow | undefined) => JSON.stringify([c?.reach_ts ?? null, c?.resume_hash ?? null, c?.hole_from_ts ?? null, c?.hole_to_ts ?? null])

/** Pools whose verdict needs no stored aggregates: no payouts by design, no fee, nothing indexed. */
function quickEntry(p: PoolMetaRow, c: CursorReachRow | undefined): Omit<VerdictEntry, 'meta' | 'data' | 'at'> | null {
  const type = payoutTypeOf(p.payout_type)
  const base = { ratio: null, lastPayoutTs: null, cycleMs: null, reachTs: c?.reach_ts ?? null }
  if (type === 'none') {
    const v = poolVerdict(emptyWindow, { fee: p.fee ?? 0, payoutType: 'none', scheduleMs: null }, 0)
    return { ...base, verdict: v.verdict, expectedRatio: p.fee === null ? null : v.expectedRatio, reasons: v.reasons }
  }
  if (p.fee === null) return { ...base, verdict: null, expectedRatio: null, reasons: [NO_FEE] }
  if (!p.reward_address || !c || c.reach_ts === null) return { ...base, verdict: null, expectedRatio: 1 - p.fee, reasons: [NOT_INDEXED] }
  return null
}

const emptyWindow: PoolWindow = {
  earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0, lastPayoutTs: null, windowStartTs: 0, windowEndTs: 0,
}

/** The verdict of one pool from its stored rows, read the way Task 8 laid down (data reach, never the clock). */
export function computeEntry(
  p: PoolMetaRow & { fee: number },
  c: CursorReachRow & { reach_ts: number },
  hours: PoolHourDb[],
  days: { staker: string; day: number; payouts: number; received: number }[],
): Omit<VerdictEntry, 'meta' | 'data' | 'at'> {
  const type = payoutTypeOf(p.payout_type)
  const scheduleMs = scheduleMsOf(p.schedule)
  const range = windowRange(c, scheduleMs)
  const { window, earlier, cycleMs } = poolWindowsFromAggregates(
    hours.map(hourFromDb),
    days.map((d) => ({ staker: d.staker, day: d.day, payouts: d.payouts, received: BigInt(d.received) })),
    range,
  )
  const v = poolVerdict(window, { fee: p.fee, payoutType: type, scheduleMs }, c.reach_ts, { earlier })
  return {
    verdict: v.verdict,
    ratio: v.ratio,
    expectedRatio: v.expectedRatio,
    lastPayoutTs: window.lastPayoutTs,
    reasons: c.resume_hash ? [...v.reasons, CATCHING_UP] : v.reasons,
    cycleMs,
    reachTs: c.reach_ts,
  }
}

export interface RefreshResult {
  /** pools whose verdict was computed from stored aggregates this run */
  computed: string[]
  pruned: boolean
  written: boolean
}

/**
 * Recomputes the verdicts whose inputs changed and stores them all in one meta row, which
 * `/api/pools` and `/api/check` read instead of the aggregates. At most `maxPools` pools are computed
 * from their rows per run (each is a few thousand staker_day rows); pools that need no rows are free.
 * Once a UTC day it also drops each pool's rows older than its window can read. Two D1 round trips,
 * three on a pruning run; never throws.
 */
export async function refreshVerdicts(
  env: Pick<Env, 'DB'>,
  opts: { now?: number; maxPools?: number; /** false: leave the daily prune to a run of its own */ prune?: boolean } = {},
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now()
  const maxPools = opts.maxPools ?? 2
  const out: RefreshResult = { computed: [], pruned: false, written: false }
  try {
    const [poolRes, cursorRes, metaRes] = await env.DB.batch([
      env.DB.prepare('SELECT address, fee, payout_type, schedule, reward_address, listed FROM pools WHERE listed = 1'),
      env.DB.prepare('SELECT pool, reach_ts, resume_hash, hole_from_ts, hole_to_ts FROM pool_cursor'),
      env.DB.prepare('SELECT key, value FROM meta WHERE key IN (?, ?)').bind(VERDICTS_KEY, PRUNED_KEY),
    ])
    const pools = (poolRes?.results ?? []) as PoolMetaRow[]
    const cursors = new Map(((cursorRes?.results ?? []) as CursorReachRow[]).map((c) => [c.pool, c]))
    const meta = new Map(((metaRes?.results ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]))
    const old = parseVerdictCache(meta.get(VERDICTS_KEY))?.pools ?? {}
    const next: Record<string, VerdictEntry> = {}
    let changed = false

    const todo: { p: PoolMetaRow & { fee: number }; c: CursorReachRow & { reach_ts: number }; urgent: boolean; at: number; meta: string; data: string }[] = []
    for (const p of pools) {
      const c = cursors.get(p.address)
      const mk = metaKey(p)
      const dk = dataKey(c)
      const prev = old[p.address]
      const quick = quickEntry(p, c)
      if (quick) {
        if (prev && prev.meta === mk && prev.data === dk) next[p.address] = prev
        else {
          next[p.address] = { ...quick, meta: mk, data: dk, at: now }
          changed = true
        }
        continue
      }
      if (prev) next[p.address] = prev
      const urgent = !prev || prev.meta !== mk
      if (urgent || (prev.data !== dk && now - prev.at >= REFRESH_MS)) {
        todo.push({ p: p as PoolMetaRow & { fee: number }, c: c as CursorReachRow & { reach_ts: number }, urgent, at: prev?.at ?? 0, meta: mk, data: dk })
      }
    }
    if (Object.keys(old).some((a) => !next[a])) changed = true

    todo.sort((x, y) => Number(y.urgent) - Number(x.urgent) || x.at - y.at)
    const pick = todo.slice(0, maxPools)
    if (pick.length) {
      const reads = await env.DB.batch(
        pick.flatMap(({ p, c }) => {
          const fromTs = c.reach_ts - WINDOW_MS
          return [
            env.DB.prepare(
              'SELECT hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts FROM pool_hour WHERE pool = ? AND hour >= ?',
            ).bind(p.address, Math.floor(fromTs / HOUR_MS)),
            env.DB.prepare('SELECT staker, day, payouts, received FROM staker_day WHERE pool = ? AND day >= ?').bind(p.address, dayOf(fromTs)),
          ]
        }),
      )
      pick.forEach(({ p, c, meta: mk, data: dk }, i) => {
        const hours = (reads[2 * i]?.results ?? []) as PoolHourDb[]
        const days = (reads[2 * i + 1]?.results ?? []) as { staker: string; day: number; payouts: number; received: number }[]
        next[p.address] = { ...computeEntry(p, c, hours, days), meta: mk, data: dk, at: now }
        out.computed.push(p.address)
        changed = true
      })
    }

    const writes: Stmt[] = []
    if (changed) writes.push(metaSet(VERDICTS_KEY, JSON.stringify({ at: now, pools: next } satisfies VerdictCache), now))
    if (opts.prune !== false && meta.get(PRUNED_KEY) !== String(dayOf(now))) {
      // per pool, against its own reach: a pool the indexer has not reached for days keeps its rows
      for (const c of cursors.values()) {
        if (c.reach_ts === null) continue
        const keepFrom = dayOf(c.reach_ts - WINDOW_MS) - KEEP_DAYS_BEFORE_WINDOW
        writes.push({ sql: 'DELETE FROM staker_day WHERE pool = ? AND day < ?', params: [c.pool, keepFrom] })
        writes.push({ sql: 'DELETE FROM pool_hour WHERE pool = ? AND hour < ?', params: [c.pool, keepFrom * 24] })
      }
      writes.push(metaSet(PRUNED_KEY, String(dayOf(now)), now))
      out.pruned = true
    }
    if (writes.length) {
      await env.DB.batch(bind(env.DB, writes))
      out.written = changed
    }
  } catch (e) {
    console.error('verdict refresh failed', e instanceof Error ? e.message.slice(0, 200) : String(e))
    out.pruned = false
  }
  return out
}
