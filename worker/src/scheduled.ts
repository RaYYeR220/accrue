import type { Env } from './env'
import { warmRates } from './api/rates'
import { dayOf } from './indexer/aggregate'
import { POOLS_SYNC_MS, runIndexerTick, type TickDeps, type TickResult } from './indexer/cron'
import { scanRouterLogs } from './indexer/router'
import { bind, metaSet } from './indexer/store'
import { PRUNED_KEY, refreshVerdicts } from './indexer/verdicts'

// The free plan allows 10 ms of CPU per invocation, and on Cloudflare each part of the cron costs more
// than its Node profile suggests (measured one at a time: an empty run 2 ms, the rates 10 ms, one
// verdict 11 ms, a 500-tx scan 16 ms). So by default the cron runs every minute and each run does one
// job: the hourly pool sync, the daily prune, the rates every five minutes, a pool verdict on every
// other run, otherwise a scan of at most 250 txs. The pools send ~3,300 txs an hour; scans on half the
// minutes take up to 7,500. The cadence and the sizes are vars (see cronConfig), so a plan with more
// CPU can run every few minutes with bigger jobs, or every due job in one run, without a code change.
export const TXS_PER_RUN = 250
export const PAGES_PER_RUN = 3
const MIN = 60_000
// a sync or prune that failed is tried again after this long; meanwhile the other jobs run
const RETRY_FAILED_MS = 10 * MIN
const SYNC_TRIED_KEY = 'sync_tried_at'
const PRUNE_TRIED_KEY = 'prune_tried_at'
const RATES_TRIED_KEY = 'rates_tried_at'
const MAX_MS = 25_000

export type Job = 'sync' | 'prune' | 'rates' | 'verdict' | 'scan'

export interface CronConfig {
  /** how often the cron fires (keep in step with [triggers] crons in wrangler.toml) */
  everyMs: number
  /** one job per run (sync, prune, rates, a verdict or a scan); false: every due job in each run */
  oneJobPerRun: boolean
  txsPerRun: number
  pagesPerRun: number
  verdictsPerRun: number
  ratesEveryMs: number
}

type CronVars = Partial<Record<'CRON_EVERY_MIN' | 'CRON_ONE_JOB_PER_RUN' | 'CRON_TXS_PER_RUN' | 'CRON_PAGES_PER_RUN' | 'CRON_VERDICTS_PER_RUN' | 'CRON_RATES_EVERY_MIN', string>>

const count = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback
}

export function cronConfig(env: CronVars): CronConfig {
  return {
    everyMs: count(env.CRON_EVERY_MIN, 1) * MIN,
    oneJobPerRun: env.CRON_ONE_JOB_PER_RUN?.trim().toLowerCase() !== 'false',
    txsPerRun: Math.round(count(env.CRON_TXS_PER_RUN, TXS_PER_RUN)),
    pagesPerRun: Math.round(count(env.CRON_PAGES_PER_RUN, PAGES_PER_RUN)),
    verdictsPerRun: Math.round(count(env.CRON_VERDICTS_PER_RUN, 1)),
    ratesEveryMs: count(env.CRON_RATES_EVERY_MIN, 5) * MIN,
  }
}

export interface JobState {
  syncedAt: number | null
  prunedDay: string | null
  ratesTriedAt: number | null
  syncTriedAt?: number | null
  pruneTriedAt?: number | null
}

const tried = (at: number | null | undefined, now: number, againMs: number) => at != null && now - at < againMs

/** The housekeeping jobs due in a run, in order; a failed sync or prune waits RETRY_FAILED_MS. */
export function dueJobs(state: JobState, now: number, cfg: CronConfig = cronConfig({})): Job[] {
  const out: Job[] = []
  if ((state.syncedAt === null || now - state.syncedAt >= POOLS_SYNC_MS) && !tried(state.syncTriedAt, now, RETRY_FAILED_MS)) out.push('sync')
  if (state.prunedDay !== String(dayOf(now)) && !tried(state.pruneTriedAt, now, RETRY_FAILED_MS)) out.push('prune')
  // half a cadence early, so a run that fires a little before the mark still counts
  if (!tried(state.ratesTriedAt, now, cfg.ratesEveryMs - cfg.everyMs / 2)) out.push('rates')
  return out
}

/** The one job of a run: the first due housekeeping job, else a verdict and a scan by turns. */
export function pickJob(state: JobState, now: number, cfg: CronConfig = cronConfig({})): Job {
  return dueJobs(state, now, cfg)[0] ?? (Math.floor(now / cfg.everyMs) % 2 === 1 ? 'verdict' : 'scan')
}

async function jobState(env: Env): Promise<JobState | null> {
  try {
    const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM meta WHERE key IN (?, ?, ?, ?, ?)')
      .bind('pools_synced_at', PRUNED_KEY, RATES_TRIED_KEY, SYNC_TRIED_KEY, PRUNE_TRIED_KEY)
      .all<{ key: string; value: string; updated_at: number }>()
    const at = (k: string) => results.find((r) => r.key === k)?.updated_at ?? null
    return {
      syncedAt: at('pools_synced_at'),
      prunedDay: results.find((r) => r.key === PRUNED_KEY)?.value ?? null,
      ratesTriedAt: at(RATES_TRIED_KEY),
      syncTriedAt: at(SYNC_TRIED_KEY),
      pruneTriedAt: at(PRUNE_TRIED_KEY),
    }
  } catch {
    return null
  }
}

async function markTried(env: Env, key: string, now: number) {
  try {
    await env.DB.batch(bind(env.DB, [metaSet(key, '', now)]))
  } catch {
    // unmarked, the job is simply due again next run
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

/** A scan that folded no new tx (nothing was waiting, or the RPC did not answer) has room for one verdict. */
export const verdictsAfterScan = (tick: TickResult, cap = 1) => (tick.folded === 0 ? Math.min(cap, verdictBudget(tick)) : 0)

type Verdicts = { computed: number; pruned: boolean }

/**
 * One cron invocation. By default one job (see pickJob); a verdict run with no verdict due, or a
 * sync the validators API refuses, turns into a scan, so the indexer never idles. A sync or prune is
 * marked tried before it runs, so one that keeps failing waits RETRY_FAILED_MS and cannot hold up the
 * other jobs; a scan never syncs. With CRON_ONE_JOB_PER_RUN=false every due job runs, then a scan and
 * the verdicts. The router's new Supplied/Withdrawn logs (for /api/position) are folded first in every
 * run: they are cheap and on the money path, so a run the platform stops for CPU mid-job has still
 * moved them.
 */
export async function runScheduled(env: Env, deps: TickDeps = {}) {
  const now = (deps.now ?? Date.now)()
  const cfg = cronConfig(env as CronVars)
  const [router, state] = await Promise.all([scanRouterLogs(env, { maxChunks: 3 }), jobState(env)])
  const planned: Job[] = !state ? ['scan'] : cfg.oneJobPerRun ? [pickJob(state, now, cfg)] : [...dueJobs(state, now, cfg), 'scan', 'verdict']
  const jobs: Job[] = []
  let tick: TickResult | null = null
  let verdicts: Verdicts | null = null
  let rates: Awaited<ReturnType<typeof warmRates>> | null = null

  const scan = async (): Promise<TickResult> => {
    jobs.push('scan')
    const t = await runIndexerTick(env, { maxPages: cfg.pagesPerRun, maxTxs: cfg.txsPerRun, maxMs: MAX_MS, sync: false }, deps)
    tick = t
    return t
  }
  const refresh = async (maxPools: number, prune: boolean) => {
    const r = await refreshVerdicts(env, { now, maxPools, prune })
    verdicts = { computed: (verdicts?.computed ?? 0) + r.computed.length, pruned: r.pruned || !!verdicts?.pruned }
    return r.computed.length
  }
  // with one job per run, a scan that had nothing new to fold computes a verdict instead
  const scanJob = async () => {
    const t = await scan()
    const n = cfg.oneJobPerRun ? verdictsAfterScan(t, cfg.verdictsPerRun) : 0
    if (n) await refresh(n, false)
  }

  for (const job of planned) {
    if (job === 'sync') {
      jobs.push('sync')
      await markTried(env, SYNC_TRIED_KEY, now)
      tick = await runIndexerTick(env, { maxPages: 0, maxMs: MAX_MS }, deps)
      if (!tick.synced && cfg.oneJobPerRun) await scanJob()
    } else if (job === 'prune') {
      jobs.push('prune')
      await markTried(env, PRUNE_TRIED_KEY, now)
      await refresh(0, true)
    } else if (job === 'rates') {
      jobs.push('rates')
      rates = await warmRates(env, now)
      await markTried(env, RATES_TRIED_KEY, now)
    } else if (job === 'verdict') {
      jobs.push('verdict')
      const n = await refresh(cfg.verdictsPerRun, false)
      if (!n && cfg.oneJobPerRun) await scan()
    } else {
      await scanJob()
    }
  }
  return { job: jobs[jobs.length - 1]!, jobs, tick: tick as TickResult | null, verdicts: verdicts as Verdicts | null, router, rates }
}
