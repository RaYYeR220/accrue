import type { Env } from './env'
import { runIndexerTick } from './indexer/cron'
import { scanRouterLogs } from './indexer/router'
import { refreshVerdicts } from './indexer/verdicts'

/**
 * One cron invocation: the indexer tick, then the verdicts of the pools whose data changed (so the
 * read API only ever reads cached verdicts), then the router's new Supplied/Withdrawn logs for
 * /api/position. About 35 subrequests at most.
 * CPU (warm, Node): a tick folds up to ~6.6 ms of txs; one pool's verdict is 0.1-1.6 ms with its
 * rows parsed. The more pages the tick folded, the fewer verdicts follow it, to stay under 10 ms.
 */
export async function runScheduled(env: Env) {
  const tick = await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 })
  const verdicts = await refreshVerdicts(env, { maxPools: tick.pages === 0 ? 3 : tick.pages === 1 ? 2 : 1 })
  const router = await scanRouterLogs(env, { maxChunks: 3 })
  return { tick, verdicts: { computed: verdicts.computed.length, pruned: verdicts.pruned }, router }
}
