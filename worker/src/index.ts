import type { Env } from './env'
import { app } from './app'
import { runScheduled } from './scheduled'

export { Relayer } from './relayer/Relayer'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env).then(
        r => console.log('cron', JSON.stringify(r)),
        e => console.error('cron failed', e),
      ),
    )
  },
}
