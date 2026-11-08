// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobsConfig, remember, resetJobs, type LocalJob } from '../src/actions/jobs'
import { createDollarAction } from '../src/features/dollars/useDollarAction'

const JOB = `0x${'ab'.repeat(32)}`
const TX = `0x${'cd'.repeat(32)}` as const
const OWNER = '0xa11ce00000000000000000000000000000000a11' as const

const record = (status: LocalJob['status']): LocalJob => ({
  jobId: JOB,
  owner: OWNER,
  kind: 'supply',
  asset: 'USDT0',
  amount: '1000000',
  createdAt: Date.now(),
  status,
  via: 'relay',
  txHash: TX,
})

// the relay answers "submitted" once, then "confirmed"
function relay() {
  let polls = 0
  vi.stubGlobal('fetch', async () => {
    polls += 1
    return Response.json({ jobId: JOB, status: polls > 1 ? 'confirmed' : 'submitted', txHash: TX })
  })
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 5))
}

beforeEach(() => {
  localStorage.clear()
  resetJobs()
  Object.assign(jobsConfig, { pollMs: 1, maxPollMs: 4 })
})

afterEach(() => {
  resetJobs()
  vi.unstubAllGlobals()
})

describe('"Details" on a job that is already on its way', () => {
  it('keeps following it when the sheet is mounted twice (React strict mode disposes once in between)', async () => {
    remember(record('submitted'))
    relay()
    const a = createDollarAction()
    a.attach(JOB)
    a.dispose()
    a.attach(JOB)
    await until(() => a.getState().s === 'confirmed')
    expect(a.getState()).toMatchObject({ s: 'confirmed', jobId: JOB, txHash: TX })
  })

  it('a job that finished just before the tap shows how it ended instead of an empty form', () => {
    remember(record('confirmed'))
    const a = createDollarAction()
    a.attach(JOB)
    expect(a.getState()).toMatchObject({ s: 'confirmed', jobId: JOB })
  })
})
