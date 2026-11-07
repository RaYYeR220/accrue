import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './api/health'
import { relay } from './api/relay'
import { errorBody } from './relayer/errors'

export const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', async c => c.json(await health(c.env)))
app.route('/api/relay', relay)

// Every response is JSON with a stable code; nothing internal leaks into the body.
app.notFound(c => c.json(errorBody('INTERNAL', { reason: 'not_found' }), 404))
app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? err.message.slice(0, 200) : String(err))
  return c.json(errorBody('INTERNAL'), 500)
})
