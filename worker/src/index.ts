import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './api/health'

export { Relayer } from './relayer'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', async c => c.json(await health(c.env)))

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
}
