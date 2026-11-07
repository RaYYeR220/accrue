import type { Env } from './env'
import { app } from './app'

export { Relayer } from './relayer/Relayer'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
}
