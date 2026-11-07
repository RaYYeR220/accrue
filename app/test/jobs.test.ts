// @vitest-environment jsdom
import { keccak256, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocal,
  jobIdOf,
  track,
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
import { ASSETS } from '@accrue/shared'
import { json, mined, OWNER, posts, relayError, ROUTER, sig, stubEvm, stubFetch, TX } from './fakes'

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

  it('a signature past its deadline is never sent again, and is only settled once the grace period is over', async () => {
    const deadline = nowSec() - 5
    seed(stored(S, { status: 'sent', deadline, body: bodyFor(S, deadline) }))
    const calls = stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))
    const ev = stubEvm()

    await resumePending(X)
    await new Promise(r => setTimeout(r, 30))
    expect(posts(calls)).toHaveLength(0)
    // the relay may still be settling it: no verdict yet, and no nonce read
    expect(getLocal(J)?.status).toBe('sent')
    expect(ev.permitNonce).not.toHaveBeenCalled()
  })

  describe('after the permit deadline and the grace period, the permit nonce decides (Important 2)', () => {
    const late = () => nowSec() - jobsConfig.graceSec - 60

    it('a relay job the relay cannot find: nonce unused, so failed for good and the asset is free again', async () => {
      const deadline = late()
      seed(stored(S, { status: 'submitted', deadline, body: bodyFor(S, deadline), nonce: '0' }))
      const calls = stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))
      const ev = stubEvm()
      ev.permitNonce.mockResolvedValue(0n)
      await resumePending(X)
      await vi.waitFor(() =>
        expect(getLocal(J)).toMatchObject({ status: 'failed', error: 'DEADLINE_INVALID', detail: { reason: 'expired_unconfirmed' } }),
      )
      expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.address, X)
      expect(unresolved(X, 'supply', 'USDT0')).toBeUndefined()
      expect(posts(calls)).toHaveLength(0)
    })

    it('a relay job the relay cannot find: nonce used, so landed (the D1 write was lost)', async () => {
      const deadline = late()
      seed(stored(S, { status: 'sent', deadline, body: bodyFor(S, deadline), nonce: '0' }))
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))
      stubEvm().permitNonce.mockResolvedValue(1n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
      expect(unresolved(X, 'supply', 'USDT0')).toBeUndefined()
    })

    it('a self-paid tx that never shows a receipt (dropped or replaced): nonce used, so landed', async () => {
      seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined, deadline: late(), nonce: '3', kind: 'withdraw' }))
      stubFetch(() => json(200, { jobs: [] }))
      const ev = stubEvm()
      ev.txReceipt.mockResolvedValue(null)
      ev.permitNonce.mockResolvedValue(4n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(TX)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
      expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.aToken, X)
      expect(unresolved(X, 'withdraw', 'USDT0')).toBeUndefined()
    })

    it('a self-paid tx that never shows a receipt: nonce unused, so failed for good', async () => {
      seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined, deadline: late(), nonce: '3' }))
      stubFetch(() => json(200, { jobs: [] }))
      const ev = stubEvm()
      ev.txReceipt.mockResolvedValue(null)
      ev.permitNonce.mockResolvedValue(3n)
      await resumePending(X)
      await vi.waitFor(() =>
        expect(getLocal(TX)).toMatchObject({ status: 'failed', error: 'DEADLINE_INVALID', detail: { reason: 'expired_unconfirmed' } }),
      )
    })

    it('a failed nonce read keeps the job open and tries again', async () => {
      const deadline = late()
      seed(stored(S, { status: 'submitted', deadline, body: bodyFor(S, deadline), nonce: '0' }))
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : notFound()))
      const ev = stubEvm()
      ev.permitNonce.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(1n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
      expect(ev.permitNonce.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('a missing receipt backs off instead of polling at full rate', async () => {
    Object.assign(jobsConfig, { pollMs: 20, maxPollMs: 10_000 })
    seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined }))
    stubFetch(() => json(200, { jobs: [] }))
    const ev = stubEvm()
    const at: number[] = []
    ev.txReceipt.mockImplementation(async () => {
      at.push(performance.now())
      return null
    })
    await resumePending(X)
    await vi.waitFor(() => expect(at.length).toBeGreaterThanOrEqual(5), { timeout: 3_000 })
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    // 20, 40, 80, 160 ms: each wait about twice the last, never a steady few-second loop
    expect(gaps[3]!).toBeGreaterThan(gaps[0]! * 3)
  })

  it('a re-send answered "nonce used, landed check unavailable" counts as landed, never as a reason to sign again', async () => {
    seed(stored(S, { status: 'sent' }))
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') return relayError(409, 'PERMIT_NONCE_STALE', { expected: '1', landedCheck: 'unavailable' })
      return notFound()
    })
    await resumePending(X)
    await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
  })

  it('a re-send answered plain stale with the nonce moved past ours is landed: the relay\'s "not ours" is not trusted', async () => {
    seed(stored(S, { status: 'sent' }))
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') return relayError(409, 'PERMIT_NONCE_STALE', { expected: '1' })
      return notFound()
    })
    await resumePending(X)
    await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
  })

  it('a re-send answered stale without "expected" reads the nonce itself', async () => {
    seed(stored(S, { status: 'sent' }))
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') return relayError(409, 'PERMIT_NONCE_STALE')
      return notFound()
    })
    stubEvm().permitNonce.mockResolvedValue(1n)
    await resumePending(X)
    await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
  })

  it('a re-send answered "another signature for this nonce is in flight" is never claimed as landed', async () => {
    seed(stored(S, { status: 'sent' }))
    const other = `0x${'9'.repeat(64)}`
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') return relayError(409, 'PERMIT_NONCE_STALE', { reason: 'in_flight', jobId: other })
      return notFound()
    })
    const ev = stubEvm()
    ev.permitNonce.mockResolvedValue(1n)
    const seen: unknown[] = []
    await resumePending(X)
    await track(J, u => seen.push(u))
    expect(seen.at(-1)).toMatchObject({ job: { status: 'failed', error: 'PERMIT_NONCE_STALE' } })
    expect(ev.permitNonce).not.toHaveBeenCalled()
  })

  it('a re-send answered stale for a nonce not yet reached fails and asks for a fresh one', async () => {
    seed(stored(S, { status: 'sent', body: { ...bodyFor(S), nonce: '3' } }))
    const seen: unknown[] = []
    stubFetch(c => {
      if (c.path === `/api/relay/by-owner/${X}`) return json(200, { jobs: [] })
      if (c.method === 'POST') return relayError(409, 'PERMIT_NONCE_STALE', { expected: '2' })
      return notFound()
    })
    await resumePending(X)
    await track(J, u => seen.push(u))
    expect(seen.at(-1)).toMatchObject({ job: { status: 'failed', error: 'PERMIT_NONCE_STALE' } })
  })

  describe('a final relay job "dropped" (our nonce used, no receipt) is decided by the permit nonce (item 1)', () => {
    const dropped = (extra: object = {}) =>
      json(200, { jobId: J, status: 'failed', txHash: TX, error: 'RPC_UNAVAILABLE', detail: { reason: 'dropped', ...extra } })

    it('nonce used past ours: landed', async () => {
      seed(stored(S, { nonce: '0' }))
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : dropped({ landedCheck: 'unavailable' })))
      const ev = stubEvm()
      ev.permitNonce.mockResolvedValue(1n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
      expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.address, X)
    })

    it('nonce not used: failed, and a fresh signature is safe', async () => {
      seed(stored(S, { nonce: '0' }))
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : dropped()))
      stubEvm().permitNonce.mockResolvedValue(0n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'failed', error: 'RPC_UNAVAILABLE', detail: { reason: 'dropped' } }))
    })

    it('nonce unreadable: the job stays open and is checked again', async () => {
      seed(stored(S, { nonce: '0' }))
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [] }) : dropped()))
      const ev = stubEvm()
      ev.permitNonce.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(1n)
      await resumePending(X)
      await vi.waitFor(() => expect(getLocal(J)?.status).toBe('confirmed'))
    })

    it('listed as dropped by by-owner on resume: the open local record is not overwritten, the poller decides', async () => {
      seed(stored(S, { nonce: '0' }))
      const job = serverJob('failed', { txHash: TX, error: 'RPC_UNAVAILABLE', detail: { reason: 'dropped' } })
      stubFetch(c => (c.path === `/api/relay/by-owner/${X}` ? json(200, { jobs: [job] }) : dropped()))
      stubEvm().permitNonce.mockResolvedValue(1n)
      const jobs = await resumePending(X)
      expect(jobs[0]).not.toMatchObject({ status: 'failed' })
      await vi.waitFor(() => expect(getLocal(J)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } }))
    })
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
    ev.txReceipt.mockResolvedValueOnce(null).mockResolvedValue(mined('success'))

    expect(await resumePending(X)).toEqual([expect.objectContaining({ jobId: TX, status: 'submitted' })])
    await vi.waitFor(() => expect(getLocal(TX)?.status).toBe('confirmed'))
    expect(ev.txReceipt).toHaveBeenCalledWith(TX)
    expect(calls.filter(c => c.path === `/api/relay/${TX}`)).toHaveLength(0)
  })

  it('a reverted self-paid transaction fails for good', async () => {
    seed(stored(S, { jobId: TX, via: 'wallet', txHash: TX, body: undefined }))
    stubFetch(() => json(200, { jobs: [] }))
    stubEvm().txReceipt.mockResolvedValue(mined('reverted'))
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
