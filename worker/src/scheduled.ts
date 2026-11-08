import type { Env } from './env'
import { runIndexerTick } from './indexer/cron'
import { refreshVerdicts } from './indexer/verdicts'

/**
 * One cron invocation: the indexer tick, then the verdicts of the pools whose data it moved, so the
 * read API only ever reads cached verdicts. A tick that fetched nothing leaves CPU for more verdicts.
 */
export async function runScheduled(env: Env) {
  const tick = await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 })
  const verdicts = await refreshVerdicts(env, { maxPools: tick.pages === 0 ? 4 : 2 })
  return { tick, verdicts: { computed: verdicts.computed.length, pruned: verdicts.pruned } }
}
