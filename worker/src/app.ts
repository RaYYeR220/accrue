import { Hono } from 'hono'
import type { Env } from './env'
import { health } from './api/health'
import { relay } from './api/relay'
import { pools } from './api/pools'
import { check } from './api/check'
import { rates } from './api/rates'
import { aave } from './api/aave'
import { position } from './api/position'
import { errorBody } from './relayer/errors'

export const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', async c => c.json(await health(c.env)))
app.route('/api/relay', relay)
app.route('/api/pools', pools)
app.route('/api/check', check)
app.route('/api/rates', rates)
app.route('/api/aave', aave)
app.route('/api/position', position)

// Every response is JSON with a stable code; nothing internal leaks into the body.
app.notFound(c => c.json(errorBody('INTERNAL', { reason: 'not_found' }), 404))
app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? err.message.slice(0, 200) : String(err))
  return c.json(errorBody('INTERNAL'), 500)
})
