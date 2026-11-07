import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './api/health'
import { runIndexerTick } from './indexer/cron'

export { Relayer } from './relayer'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', async c => c.json(await health(c.env)))

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
