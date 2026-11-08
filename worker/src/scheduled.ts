import type { Env } from './env'
import { warmRates } from './api/rates'
import { dayOf } from './indexer/aggregate'
import { POOLS_SYNC_MS, runIndexerTick, type TickDeps, type TickResult } from './indexer/cron'
import { scanRouterLogs } from './indexer/router'
import { PRUNED_KEY, refreshVerdicts } from './indexer/verdicts'

// The free plan allows 10 ms of CPU per invocation. Each run does one heavy job: the hourly pool sync
// (~1.3 MB of validators JSON), the daily prune, or a scan of at most TXS_PER_RUN txs (the pools send
// ~3,300 txs an hour, ~280 per run) followed by a verdict or two. Rates and the router logs are light
// and run every time.
export const TXS_PER_RUN = 500
export const PAGES_PER_RUN = 3
// a scan run that folded at most this many txs has room for a second verdict
const LIGHT_TXS = 150
const MAX_MS = 25_000

export type Job = 'sync' | 'prune' | 'scan'

export function pickJob(state: { syncedAt: number | null; prunedDay: string | null }, now: number): Job {
  if (state.syncedAt === null || now - state.syncedAt >= POOLS_SYNC_MS) return 'sync'
  if (state.prunedDay !== String(dayOf(now))) return 'prune'
  return 'scan'
}

async function nextJob(env: Env, now: number): Promise<Job> {
  try {
    const { results } = await env.DB.prepare("SELECT key, value, updated_at FROM meta WHERE key IN ('pools_synced_at', ?)")
      .bind(PRUNED_KEY)
      .all<{ key: string; value: string; updated_at: number }>()
    const row = (k: string) => results.find((r) => r.key === k)
    return pickJob({ syncedAt: row('pools_synced_at')?.updated_at ?? null, prunedDay: row(PRUNED_KEY)?.value ?? null }, now)
  } catch {
    // the tick records the D1 failure itself
    return 'scan'
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

/** Verdicts after a scan run: verdictBudget, at most two, one once the run folded more than LIGHT_TXS. */
export const verdictsAfterScan = (tick: TickResult) => Math.min(verdictBudget(tick), tick.txs > LIGHT_TXS ? 1 : 2)

/**
 * One cron invocation, one heavy job (see pickJob): the hourly pool sync, the daily prune, or the
 * indexer scan followed by the verdicts of pools whose data changed (the read API only ever reads
 * cached verdicts). A sync the validators API refuses turns into a scan, so the indexer never idles.
 * Then the router's new Supplied/Withdrawn logs for /api/position and the rates. About 40
 * subrequests at most.
 */
export async function runScheduled(env: Env, deps: TickDeps = {}) {
  const now = (deps.now ?? Date.now)()
  let job = await nextJob(env, now)
  let tick: TickResult | null = null
  let verdicts: { computed: number; pruned: boolean } | null = null
  if (job === 'sync') {
    tick = await runIndexerTick(env, { maxPages: 0, maxMs: MAX_MS }, deps)
    if (!tick.synced) job = 'scan'
  }
  if (job === 'prune') {
    const r = await refreshVerdicts(env, { now, maxPools: 0 })
    verdicts = { computed: r.computed.length, pruned: r.pruned }
  }
  if (job === 'scan') {
    tick = await runIndexerTick(env, { maxPages: PAGES_PER_RUN, maxTxs: TXS_PER_RUN, maxMs: MAX_MS }, deps)
    const r = await refreshVerdicts(env, { now, maxPools: verdictsAfterScan(tick), prune: false })
    verdicts = { computed: r.computed.length, pruned: r.pruned }
  }
  const router = await scanRouterLogs(env, { maxChunks: 3 })
  const rates = await warmRates(env, now)
  return { job, tick, verdicts, router, rates }
}
