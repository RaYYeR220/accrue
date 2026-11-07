// @vitest-environment jsdom
import { keccak256, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocal,
  jobIdOf,
  jobsConfig,
  JOBS_STORAGE_KEY,
  listJobs,
  remember,
  resetJobs,
  resumePending,
  subscribeJobs,
  unresolved,
  type LocalJob,
  type RelayBody,
} from '../src/actions/jobs'
import { reduce, type ActionState } from '../src/actions/machine'
import { deposit } from '../src/features/dollars/deposit'
import { flowConfig } from '../src/features/dollars/flow'
import { json, OWNER, posts, ROUTER, sig, stubEvm, stubFetch, TX } from './fakes'

const X = OWNER
const S = sig(1)
const J = jobIdOf(S)
const nowSec = () => Math.floor(Date.now() / 1000)

const bodyFor = (signature: Hex, deadline = nowSec() + 1200): RelayBody => ({
  kind: 'supply',
  asset: 'USDT0',
  owner: X,
  amount: '5000000',
  deadline: String(deadline),
  nonce: '0',
  signature,
})

const stored = (signature: Hex, o: Partial<LocalJob> = {}): LocalJob => ({
  jobId: jobIdOf(signature),
  owner: X,
  kind: 'supply',
  asset: 'USDT0',
  amount: '5000000',
  createdAt: Date.now() - 60_000,
  status: 'submitted',
  via: 'relay',
  deadline: nowSec() + 1200,
  body: bodyFor(signature),
  ...o,
})

const serverJob = (status: string, extra: object = {}) => ({
  jobId: J,
  owner: X,
  kind: 'supply',
  asset: 'USDT0',
  amount: '5000000',
  status,
  createdAt: Date.now() - 60_000,
  ...extra,
})

const seed = (...records: LocalJob[]) => localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(records))
const notFound = () => json(404, { error: 'INTERNAL', detail: { reason: 'not_found' } })

beforeEach(() => {
  localStorage.clear()
  resetJobs()
  Object.assign(jobsConfig, { pollMs: 1, maxPollMs: 4 })
  flowConfig.router = ROUTER
  flowConfig.retryDelaysMs = [0, 0]
})

afterEach(() => {
  resetJobs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resumePending (Review Focus 2: app killed after signing)', () => {
  it('a pending job the relay reports confirmed comes back confirmed, and the same jobId is never submitted again', async () => {
    seed(stored(S))
    const calls = stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [serverJob('confirmed', { txHash: TX })] })
      if (c.method === 'GET' && c.path === `/api/relay/${J}`) return json(200, { jobId: J, status: 'confirmed', txHash: TX })
      return json(500, { error: 'INTERNAL' })
    })

    const jobs = await resumePending(X)
    expect(jobs).toEqual([expect.objectContaining({ jobId: J, status: 'confirmed', txHash: TX })])
    expect(getLocal(J)).toMatchObject({ status: 'confirmed', txHash: TX })
    expect(getLocal(J)?.body).toBeUndefined()
    expect(unresolved(X, 'supply', 'USDT0')).toBeUndefined()

    // a re-tap whose wallet hands back the very same signature must not reach the relay again
    stubEvm({ sigs: [S] })
    let st: ActionState = { s: 'signing', draft: { kind: 'supply', asset: 'USDT0', amount: 5_000_000n } }
    await deposit('USDT0', 5_000_000n, {}, ev => {
      st = reduce(st, ev)
    })
    expect(posts(calls)).toHaveLength(0)
    expect(st).toMatchObject({ s: 'confirmed', txHash: TX })
  })

  it('re-attaches a poller to a job still in flight and follows it to confirmed', async () => {
    seed(stored(S))
    let polls = 0
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [serverJob('submitted', { txHash: TX })] })
      polls += 1
      return json(200, { jobId: J, status: polls < 3 ? 'submitted' : 'confirmed', txHash: TX })
    })
    const changed = vi.fn()
    const off = subscribeJobs(changed)

    const jobs = await resumePending(X)
    expect(jobs).toEqual([expect.objectContaining({ jobId: J, status: 'submitted' })])
    expect(unresolved(X, 'supply', 'USDT0')?.jobId).toBe(J)
    await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
    expect(changed).toHaveBeenCalled()
    expect(listJobs(X)[0]).toMatchObject({ jobId: J, status: 'confirmed', txHash: TX })
    off()
  })

  it('a job only the server knows (local storage was lost) is listed and followed', async () => {
    let polls = 0
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [serverJob('queued')] })
      polls += 1
      return json(200, { jobId: J, status: polls < 2 ? 'submitted' : 'confirmed', txHash: TX })
    })
    expect(await resumePending(X)).toEqual([expect.objectContaining({ jobId: J, status: 'queued' })])
    expect(unresolved(X, 'supply', 'USDT0')?.jobId).toBe(J)
    await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
  })

  it('a signature the relay never received is sent again, unchanged, while the permit is still valid', async () => {
    const record = stored(S, { status: 'sent' })
    seed(record)
    const posted: unknown[] = []
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') {
        posted.push(c.body)
        return json(202, { jobId: J, status: 'queued' })
      }
      return posted.length === 0 ? notFound() : json(200, { jobId: J, status: 'confirmed', txHash: TX })
    })

    const jobs = await resumePending(X)
    expect(jobs).toEqual([expect.objectContaining({ jobId: J, status: 'queued' })])
    await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
    expect(posted).toEqual([record.body])
  })

  it('an expired signature the relay never received is dropped without sending anything', async () => {
    const deadline = nowSec() - 5
    seed(stored(S, { status: 'sent', deadline, body: bodyFor(S, deadline) }))
    const calls = stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))

    expect(await resumePending(X)).toEqual([])
    expect(getLocal(J)).toBeUndefined()
    expect(posts(calls)).toHaveLength(0)
  })

  it('with the relay unreachable, resume keeps the local record and keeps polling until it answers', async () => {
    seed(stored(S, { txHash: TX }))
    let online = false
    stubFetch(c => {
      if (!online) throw new TypeError('Failed to fetch')
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [serverJob('confirmed', { txHash: TX })] })
      return json(200, { jobId: J, status: 'confirmed', txHash: TX })
    })

    expect(await resumePending(X)).toEqual([expect.objectContaining({ jobId: J, status: 'submitted' })])
    await new Promise(r => setTimeout(r, 20))
    expect(getLocal(J)?.status).toBe('submitted')
    online = true
    await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
  })

  it('a self-paid transaction is followed by its receipt, not by the relay', async () => {
    seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined }))
    const calls = stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))
    const ev = stubEvm()
    ev.txStatus.mockResolvedValueOnce(null).mockResolvedValue('success')

    expect(await resumePending(X)).toEqual([expect.objectContaining({ jobId: TX, status: 'submitted' })])
    await vi.waitFor(() => expect(getLocal(TX)?.status).toBe('confirmed'))
    expect(ev.txStatus).toHaveBeenCalledWith(TX)
    expect(calls.filter(c => c.path === `/api/relay/${TX}`)).toHaveLength(0)
  })

  it('a reverted self-paid transaction fails for good', async () => {
    seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined }))
    stubFetch(() => json(200, { jobs: [] }))
    stubEvm().txStatus.mockResolvedValue('reverted')
    await resumePending(X)
    await vi.waitFor(() => expect(getLocal(TX)).toMatchObject({ status: 'failed', error: 'SIMULATION_FAILED' }))
  })
})

describe('local job store', () => {
  it('an unresolved record blocks only the same owner, kind and asset', () => {
    remember(stored(S))
    expect(unresolved(X, 'supply', 'USDT0')?.jobId).toBe(J)
    expect(unresolved(X, 'withdraw', 'USDT0')).toBeUndefined()
    expect(unresolved(X, 'supply', 'USDC')).toBeUndefined()
    expect(unresolved('0x3333333333333333333333333333333333333333', 'supply', 'USDT0')).toBeUndefined()
    const mixed = '0xAbCdEf0000000000000000000000000000000001'
    remember({ ...stored(sig(5)), owner: mixed })
    expect(unresolved(mixed.toLowerCase() as typeof mixed, 'supply', 'USDT0')).toBeDefined()
  })

  it('a new deposit is refused without asking for a signature while one is still in flight', async () => {
    seed(stored(S))
    const calls = stubFetch(() => json(200, { jobId: J, status: 'submitted', txHash: TX }))
    const ev = stubEvm()
    const events: unknown[] = []
    await deposit('USDT0', 2_000_000n, {}, e => events.push(e))
    expect(ev.signPermit).not.toHaveBeenCalled()
    expect(posts(calls)).toHaveLength(0)
    expect(events).toEqual([expect.objectContaining({ type: 'FAILED', error: expect.objectContaining({ code: 'PENDING', retry: 'none' }) })])
  })

  it('survives a reload, and storage failures never break the flow', () => {
    remember(stored(S))
    resetJobs()
    expect(getLocal(J)?.status).toBe('submitted')

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => remember(stored(sig(2)))).not.toThrow()
    expect(getLocal(jobIdOf(sig(2)))).toBeDefined()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    resetJobs()
    expect(listJobs(X)).toEqual([])
  })

  it('ignores corrupt stored data', () => {
    localStorage.setItem(JOBS_STORAGE_KEY, '{not json')
    resetJobs()
    expect(listJobs(X)).toEqual([])
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify([{ jobId: 1 }, null, stored(S)]))
    resetJobs()
    expect(listJobs(X).map(j => j.jobId)).toEqual([J])
  })

  it('listJobs is stable between changes, newest first', () => {
    remember(stored(S, { createdAt: 1 }))
    remember(stored(sig(2), { createdAt: 2 }))
    const a = listJobs(X)
    expect(listJobs(X)).toBe(a)
    expect(a.map(j => j.jobId)).toEqual([jobIdOf(sig(2)), J])
    remember(stored(sig(3), { createdAt: 3 }))
    expect(listJobs(X)).not.toBe(a)
  })
})

describe('jobIdOf', () => {
  it('matches the relay: keccak of the lowercase signature with v as 27/28', () => {
    const r = 'AB'.repeat(32)
    const s = '0c'.repeat(32)
    expect(jobIdOf(`0x${r}${s}00`)).toBe(keccak256(`0x${r.toLowerCase()}${s}1b`))
    expect(jobIdOf(`0x${r}${s}01`)).toBe(keccak256(`0x${r.toLowerCase()}${s}1c`))
    expect(jobIdOf(`0x${r}${s}1c`)).toBe(keccak256(`0x${r.toLowerCase()}${s}1c`))
  })
})
