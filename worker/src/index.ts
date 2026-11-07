import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './api/health'
import { relay } from './api/relay'

export { Relayer } from './relayer/Relayer'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', async c => c.json(await health(c.env)))
app.route('/api/relay', relay)

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
}
