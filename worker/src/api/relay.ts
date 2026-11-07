import { Hono } from 'hono'
import { getAddress, isAddress } from 'viem'
import type { Job } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { jobView } from '../relayer/Relayer'

const MAX_BODY_BYTES = 4096
const JOB_ID_RE = /^0x[0-9a-fA-F]{64}$/

interface Row {
  id: string
  owner: string
  kind: Job['kind']
  asset: Job['asset']
  amount: string
  status: Job['status']
  tx_hash: string | null
  nonce: number | null
  error: string | null
  detail: string | null
  created_at: number
}

export const relay = new Hono<{ Bindings: Env }>()

relay.post('/', async c => {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES)
    return c.json(errorBody('INTERNAL', { reason: 'body_too_large' }), 413)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(errorBody('INTERNAL', { reason: 'bad_request' }), 400)
  }
  const stub = c.env.RELAYER.get(c.env.RELAYER.idFromName('relayer'))
  const res = await stub.relay(body)
  return c.body(res.json, res.status as 202, { 'content-type': 'application/json' })
})

relay.get('/by-owner/:owner', async c => {
  const owner = c.req.param('owner')
  if (!isAddress(owner, { strict: false })) return c.json(errorBody('BAD_SIGNATURE', { reason: 'bad_owner' }), 400)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM relay_jobs WHERE owner = ?1 ORDER BY created_at DESC LIMIT 20',
  )
    .bind(owner.toLowerCase())
    .all<Row>()
  const jobs: Job[] = results.map(r => ({
    jobId: r.id,
    owner: getAddress(r.owner),
    kind: r.kind,
    asset: r.asset,
    amount: r.amount,
    createdAt: r.created_at,
    ...(jobView(r) as Omit<ReturnType<typeof jobView>, 'jobId'>),
  }))
  return c.json({ jobs })
})

relay.get('/:jobId', async c => {
  const jobId = c.req.param('jobId')
  if (!JOB_ID_RE.test(jobId)) return c.json(errorBody('INTERNAL', { reason: 'not_found' }), 404)
  const row = await c.env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?1').bind(jobId.toLowerCase()).first<Row>()
  if (!row) return c.json(errorBody('INTERNAL', { reason: 'not_found' }), 404)
  return c.json(jobView(row))
})
