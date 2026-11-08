import type { Env } from './env'
import { runIndexerTick, type TickResult } from './indexer/cron'
import { scanRouterLogs } from './indexer/router'
import { refreshVerdicts } from './indexer/verdicts'

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

/**
 * One cron invocation: the indexer tick, then the verdicts of the pools whose data changed (so the
 * read API only ever reads cached verdicts), then the router's new Supplied/Withdrawn logs for
 * /api/position. About 35 subrequests at most.
 */
export async function runScheduled(env: Env) {
  const tick = await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 })
  // with a budget of 0 it still answers the pools that need no rows and prunes once a day
  const verdicts = await refreshVerdicts(env, { maxPools: verdictBudget(tick) })
  const router = await scanRouterLogs(env, { maxChunks: 3 })
  return { tick, verdicts: { computed: verdicts.computed.length, pruned: verdicts.pruned }, router }
}
