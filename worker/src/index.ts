import type { Env } from './env'
import { app } from './app'
import { runIndexerTick } from './indexer/cron'

export { Relayer } from './relayer/Relayer'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }).then(
        r => console.log('indexer tick', JSON.stringify(r)),
        e => console.error('indexer tick failed', e),
      ),
    )
  },
}
