import type { Env } from './env'
import { warmRates } from './api/rates'
import { dayOf } from './indexer/aggregate'
import { POOLS_SYNC_MS, runIndexerTick, type TickDeps, type TickResult } from './indexer/cron'
import { scanRouterLogs } from './indexer/router'
import { bind, metaSet } from './indexer/store'
import { PRUNED_KEY, refreshVerdicts } from './indexer/verdicts'

// The free plan allows 10 ms of CPU per invocation, and on Cloudflare each part of the cron costs more
// than its Node profile suggests (measured one at a time: an empty run 2 ms, the rates 10 ms, one
// verdict 11 ms, a 500-tx scan 16 ms). So the cron runs every minute and each run does one job:
// the hourly pool sync, the daily prune, the rates every five minutes, a pool verdict on odd
// minutes, otherwise a scan of at most TXS_PER_RUN txs. The pools send ~3,300 txs an hour; scans on
// half the minutes take up to 7,500.
export const TXS_PER_RUN = 250
export const PAGES_PER_RUN = 3
export const RATES_EVERY_MS = 4.5 * 60_000
const RATES_TRIED_KEY = 'rates_tried_at'
const MAX_MS = 25_000

export type Job = 'sync' | 'prune' | 'rates' | 'verdict' | 'scan'

export interface JobState {
  syncedAt: number | null
  prunedDay: string | null
  ratesTriedAt: number | null
}

export function pickJob(state: JobState, now: number): Job {
  if (state.syncedAt === null || now - state.syncedAt >= POOLS_SYNC_MS) return 'sync'
  if (state.prunedDay !== String(dayOf(now))) return 'prune'
  if (state.ratesTriedAt === null || now - state.ratesTriedAt >= RATES_EVERY_MS) return 'rates'
  return Math.floor(now / 60_000) % 2 === 1 ? 'verdict' : 'scan'
}

async function jobState(env: Env): Promise<JobState | null> {
  try {
    const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM meta WHERE key IN (?, ?, ?)')
      .bind('pools_synced_at', PRUNED_KEY, RATES_TRIED_KEY)
      .all<{ key: string; value: string; updated_at: number }>()
    const row = (k: string) => results.find((r) => r.key === k)
    return { syncedAt: row('pools_synced_at')?.updated_at ?? null, prunedDay: row(PRUNED_KEY)?.value ?? null, ratesTriedAt: row(RATES_TRIED_KEY)?.updated_at ?? null }
  } catch {
    return null
  }
}

/**
 * How many pool verdicts may follow a tick. CPU (warm, Node): a tick folds up to ~6.6 ms of txs, the
 * hourly sync tick also parses ~1.3 MB of validators JSON (and scans at most one page); one pool's
 * verdict is 0.1-1.6 ms with its rows parsed. The busier the tick, the fewer verdicts, to stay under
 * the free plan's 10 ms.
 */
export function verdictBudget(tick: Pick<TickResult, 'pages' | 'synced'>): number {
  if (tick.synced) return tick.pages === 0 ? 1 : 0
  return tick.pages === 0 ? 3 : tick.pages === 1 ? 2 : 1
}

/** A scan run that found nothing to fold (or could not reach the RPC) spends its time on up to two verdicts. */
export const verdictsAfterScan = (tick: TickResult) => (tick.txs === 0 ? Math.min(2, verdictBudget(tick)) : 0)

/**
 * One cron invocation, one job (see pickJob). A sync the validators API refuses, or a verdict run
 * with no verdict due, turns into a scan, so the indexer never idles. The router's new
 * Supplied/Withdrawn logs (for /api/position) are read every run. About 30 subrequests at most.
 */
export async function runScheduled(env: Env, deps: TickDeps = {}) {
  const now = (deps.now ?? Date.now)()
  const state = await jobState(env)
  let job: Job = state ? pickJob(state, now) : 'scan'
  let tick: TickResult | null = null
  let verdicts: { computed: number; pruned: boolean } | null = null
  let rates: Awaited<ReturnType<typeof warmRates>> | null = null
  if (job === 'sync') {
    tick = await runIndexerTick(env, { maxPages: 0, maxMs: MAX_MS }, deps)
    if (!tick.synced) job = 'scan'
  }
  if (job === 'prune') {
    const r = await refreshVerdicts(env, { now, maxPools: 0 })
    verdicts = { computed: r.computed.length, pruned: r.pruned }
  }
  if (job === 'rates') {
    rates = await warmRates(env, now)
    try {
      await env.DB.batch(bind(env.DB, [metaSet(RATES_TRIED_KEY, '', now)]))
    } catch {
      // the next run tries again
    }
  }
  if (job === 'verdict') {
    const r = await refreshVerdicts(env, { now, maxPools: 1, prune: false })
    verdicts = { computed: r.computed.length, pruned: r.pruned }
    if (!r.computed.length) job = 'scan'
  }
  if (job === 'scan') {
    tick = await runIndexerTick(env, { maxPages: PAGES_PER_RUN, maxTxs: TXS_PER_RUN, maxMs: MAX_MS }, deps)
    // a verdict run that found none due has already looked
    const n = verdicts ? 0 : verdictsAfterScan(tick)
    if (n) {
      const r = await refreshVerdicts(env, { now, maxPools: n, prune: false })
      verdicts = { computed: r.computed.length, pruned: r.pruned }
    }
  }
  const router = await scanRouterLogs(env, { maxChunks: 3 })
  return { job, tick, verdicts, router, rates }
}
