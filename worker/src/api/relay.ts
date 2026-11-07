import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getAddress, isAddress } from 'viem'
import type { Job } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { intake } from '../relayer/intake'
import { jobView, type JobRow } from '../relayer/jobs'

const MAX_BODY_BYTES = 4096
const JOB_ID_RE = /^0x[0-9a-fA-F]{64}$/

const badRequest = (field: string) => errorBody('INTERNAL', { reason: 'bad_request', field })
const dbError = () => errorBody('INTERNAL', { reason: 'db_error' })

export const relay = new Hono<{ Bindings: Env }>()

relay.post('/', async c => {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return c.json(badRequest('body'), 413)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(badRequest('body'), 400)
  }
  const res = await intake(c.env, body)
  return c.json(res.body, res.status as ContentfulStatusCode)
})

relay.get('/by-owner/:owner', async c => {
  const owner = c.req.param('owner')
  if (!isAddress(owner, { strict: false })) return c.json(badRequest('owner'), 400)
  let results: JobRow[]
  try {
    ;({ results } = await c.env.DB.prepare('SELECT * FROM relay_jobs WHERE owner = ?1 ORDER BY created_at DESC LIMIT 20')
      .bind(owner.toLowerCase())
      .all<JobRow>())
  } catch {
    return c.json(dbError(), 500)
  }
  const jobs: Job[] = results.map(r => ({
    ...jobView(r),
    owner: getAddress(r.owner),
    kind: r.kind,
    asset: r.asset,
    amount: r.amount,
    createdAt: r.created_at,
  }))
  return c.json({ jobs })
})

relay.get('/:jobId', async c => {
  const jobId = c.req.param('jobId')
  if (!JOB_ID_RE.test(jobId)) return c.json(badRequest('jobId'), 400)
  let row: JobRow | null
  try {
    row = await c.env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?1').bind(jobId.toLowerCase()).first<JobRow>()
  } catch {
    return c.json(dbError(), 500)
  }
  if (!row) return c.json(errorBody('INTERNAL', { reason: 'not_found' }), 404)
  return c.json(jobView(row))
})
