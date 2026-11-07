import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  keccak256,
  parseGwei,
  parseTransaction,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ASSETS } from '@accrue/shared'
import { routerAbi, routerCalldata } from '../src/relayer/chain'
import type { SubmitRequest } from '../src/relayer/jobs'
import { Relayer } from '../src/relayer/Relayer'
import { FakeChain, fakeD1, fakeStorage, RpcError, TIMEOUT } from './helpers'

vi.mock('cloudflare:workers', async () => (await import('./helpers')).fakeDurableObjectModule())

const RELAYER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const RELAYER = privateKeyToAccount(RELAYER_KEY).address
const ROUTER = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f'
const OWNER = '0xbc801B8b9EC304FcFCE1A4377CEC729C0BD1F02f'
const T0 = 1_800_000_000_000
const SEC = T0 / 1000
const R = `0x${'11'.repeat(32)}` as Hex
const S = `0x${'22'.repeat(32)}` as Hex
const JOB = keccak256('0x01')
const FRONT = `0x${'fe'.repeat(32)}` as Hex

const req = (over: Partial<SubmitRequest> = {}): SubmitRequest => ({
  jobId: JOB,
  kind: 'supply',
  asset: 'USDT0',
  owner: OWNER,
  amount: '5000000',
  permitValue: '5000000',
  deadline: String(SEC + 1200),
  nonce: '0',
  v: 27,
  r: R,
  s: S,
  ...over,
})
const parsedOf = (q: SubmitRequest) => ({
  ...q,
  amount: BigInt(q.amount),
  permitValue: BigInt(q.permitValue),
  deadline: BigInt(q.deadline),
  nonce: BigInt(q.nonce),
  signature: '0x' as Hex,
})

function setup(urls = 'https://a.test') {
  const chain = new FakeChain()
  vi.stubGlobal('fetch', chain.fetch)
  const storage = fakeStorage()
  const DB = fakeD1()
  const env = { DB, POLYGON_RPCS: urls, RELAYER_KEY, ROUTER_ADDRESS: ROUTER, RELAYER_ADDRESS: '', NIM_RPCS: '' }
  const ctx = { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn() }
  const r = new Relayer(ctx as never, env as never)
  const submit = async (q: SubmitRequest) => {
    const res = await r.submit(q)
    return { status: res.status, body: JSON.parse(res.json) as Record<string, unknown> & { detail?: Record<string, unknown> } }
  }
  const row = (id = JOB) => DB.rows('SELECT * FROM relay_jobs WHERE id = ?1', id)[0]
  const later = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms)
    await r.alarm()
  }
  return { chain, storage, DB, r, submit, row, later }
}

const revert = (errorName: 'InsufficientAllowance' | 'NothingToWithdraw') =>
  new RpcError('execution reverted', 3, encodeErrorResult({ abi: routerAbi, errorName }))

/** A Supplied log for OWNER from tx `hash`, plus that tx carrying `calldata`. */
function landedAt(chain: FakeChain, hash: Hex, calldata: Hex) {
  chain.logs = [
    {
      address: ROUTER,
      topics: encodeEventTopics({
        abi: routerAbi,
        eventName: 'Supplied',
        args: { owner: OWNER, asset: ASSETS.USDT0.address },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [5_000_000n, 10n ** 27n]),
      blockNumber: '0x2700',
      blockHash: `0x${'bb'.repeat(32)}`,
      transactionHash: hash,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    },
  ]
  chain.txs.set(hash, {
    hash,
    input: calldata,
    nonce: '0x7',
    from: '0x000000000000000000000000000000000000beef',
    to: ROUTER,
    value: '0x0',
    gas: '0x50000',
    gasPrice: '0x1',
    type: '0x0',
    blockHash: `0x${'bb'.repeat(32)}`,
    blockNumber: '0x2700',
    transactionIndex: '0x0',
    v: '0x1b',
    r: '0x1',
    s: '0x1',
  })
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: T0 }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Relayer.submit', () => {
  it('is idempotent: the same signature twice is one tx', async () => {
    const { chain, submit, r } = setup()
    const a = await submit(req())
    expect(a).toMatchObject({ status: 202, body: { jobId: JOB, status: 'submitted' } })
    const b = await submit(req())
    expect(b.body).toMatchObject({ jobId: JOB, status: 'submitted', txHash: a.body.txHash })
    chain.mine(a.body.txHash as Hex)
    await r.alarm()
    expect((await submit(req())).body).toMatchObject({ jobId: JOB, status: 'confirmed', txHash: a.body.txHash })
    expect(chain.distinctSent()).toHaveLength(1)
    expect(chain.count('eth_estimateGas')).toBe(1)
  })

  it('refuses a second permit on a nonce that is already in flight', async () => {
    const { chain, submit } = setup()
    await submit(req())
    const other = await submit(req({ jobId: keccak256('0x02'), deadline: String(SEC + 1500) }))
    expect(other).toMatchObject({ status: 409, body: { error: 'PERMIT_NONCE_STALE', detail: { reason: 'in_flight', jobId: JOB } } })
    expect(chain.distinctSent()).toHaveLength(1)
  })

  it('persists the record and arms the alarm before broadcasting', async () => {
    const { chain, storage, submit } = setup()
    let seen: { hashes?: Hex[]; alarm: number | null } | undefined
    chain.onSend = (_u, raw) => {
      seen = { hashes: (storage.map.get(`job:${JOB}`) as { hashes?: Hex[] } | undefined)?.hashes, alarm: storage.alarmAt() }
      return keccak256(raw)
    }
    await submit(req())
    expect(seen?.hashes).toContain(keccak256(chain.sent[0]!.raw))
    expect(seen?.alarm).not.toBeNull()
  })

  it('keeps an ambiguous send (one node slow, another says nonce too low) and lets the alarm confirm it', async () => {
    const { chain, storage, submit, row, r } = setup('https://a.test,https://b.test')
    chain.onSend = url => (url.includes('a.test') ? TIMEOUT : new RpcError('nonce too low'))
    const a = await submit(req())
    expect(a).toMatchObject({ status: 202, body: { status: 'queued' } })
    expect(storage.map.has(`job:${JOB}`)).toBe(true)
    expect(chain.distinctSent()).toHaveLength(1)
    expect(chain.count('eth_estimateGas')).toBe(1)
    chain.mine(a.body.txHash as Hex)
    await r.alarm()
    expect(row()).toMatchObject({ status: 'confirmed', tx_hash: a.body.txHash })
    expect(chain.distinctSent()).toHaveLength(1)
  })

  it('counts one node accepting as submitted even if another says nonce too low', async () => {
    const { chain, submit } = setup('https://a.test,https://b.test')
    chain.onSend = (url, raw) => (url.includes('a.test') ? keccak256(raw) : new RpcError('nonce too low'))
    expect((await submit(req())).body).toMatchObject({ status: 'submitted' })
    expect(chain.distinctSent()).toHaveLength(1)
  })

  it('looks the tx up first when every node says nonce too low, and keeps it if a node knows it', async () => {
    const { chain, submit, storage } = setup('https://a.test,https://b.test')
    chain.onSend = () => new RpcError('nonce too low')
    chain.extra.eth_getTransactionByHash = params => ({ hash: params[0], nonce: '0x0', blockNumber: '0x2710' })
    const a = await submit(req())
    expect(a.body).toMatchObject({ status: 'submitted', txHash: keccak256(chain.sent[0]!.raw) })
    expect(chain.distinctSent()).toHaveLength(1)
    expect(chain.count('eth_estimateGas')).toBe(1)
    expect(storage.map.has(`job:${JOB}`)).toBe(true)
  })

  it('re-simulates before re-signing when every node definitively says nonce too low', async () => {
    const { chain, submit, storage } = setup('https://a.test,https://b.test')
    let first = true
    chain.onSend = (_u, raw) => {
      if (!first) return keccak256(raw)
      return new RpcError('nonce too low')
    }
    chain.extra.eth_getTransactionByHash = () => {
      first = false
      chain.pendingNonce = 3
      return null
    }
    const a = await submit(req())
    expect(a.body).toMatchObject({ status: 'submitted' })
    expect(chain.count('eth_estimateGas')).toBe(2)
    const raws = chain.distinctSent()
    expect(raws).toHaveLength(2)
    expect(parseTransaction(raws[1]!).nonce).toBe(3)
    expect((storage.map.get(`job:${JOB}`) as { nonce: number }).nonce).toBe(3)
  })

  it('does not re-sign when the re-simulation reverts', async () => {
    const { chain, submit, storage } = setup()
    chain.onSend = () => new RpcError('nonce too low')
    let estimates = 0
    chain.onEstimate = () => (++estimates === 1 ? '0x4c2c0' : revert('InsufficientAllowance'))
    const a = await submit(req())
    expect(a).toMatchObject({ status: 422, body: { error: 'SIMULATION_FAILED', detail: { reason: 'InsufficientAllowance' } } })
    expect(chain.distinctSent()).toHaveLength(1)
    expect(storage.map.has(`job:${JOB}`)).toBe(false)
  })

  it('keeps the job when every node answers with an unrecognised error (-32603 "Request timeout")', async () => {
    const { chain, submit, storage, row, r } = setup('https://a.test,https://b.test')
    chain.onSend = () => new RpcError('Request timeout', -32603)
    const a = await submit(req())
    expect(a).toMatchObject({ status: 202, body: { status: 'queued' } })
    expect(storage.map.has(`job:${JOB}`)).toBe(true)
    chain.mine(a.body.txHash as Hex)
    await r.alarm()
    expect(row()).toMatchObject({ status: 'confirmed', tx_hash: a.body.txHash })
  })

  it('drops the job only on a known refusal from every node ("replacement transaction underpriced")', async () => {
    const { chain, submit, storage } = setup('https://a.test,https://b.test')
    chain.onSend = () => new RpcError('replacement transaction underpriced')
    const a = await submit(req())
    expect(a).toMatchObject({ status: 500, body: { error: 'INTERNAL', detail: { reason: 'send_rejected' } } })
    expect(storage.map.has(`job:${JOB}`)).toBe(false)
    expect(storage.map.get('nextNonce')).toBeUndefined()
  })
})

describe('Relayer.alarm', () => {
  it('re-arms itself on start when in-flight jobs exist', async () => {
    const chain = new FakeChain()
    vi.stubGlobal('fetch', chain.fetch)
    const storage = fakeStorage()
    await storage.put(`job:${JOB}`, { jobId: JOB, hashes: [], nonce: 0, gas: '21000', maxFeePerGas: '1' })
    const ctx = { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn() }
    const r = new Relayer(ctx as never, { DB: fakeD1(), POLYGON_RPCS: 'https://a.test', RELAYER_KEY } as never)
    await r.ready
    expect(storage.alarmAt()).not.toBeNull()
  })

  it('cancels with a 0-value self-transfer once the permit deadline has passed, then fails the job', async () => {
    const { chain, submit, row, later } = setup()
    const a = await submit(req({ deadline: String(SEC + 70) }))
    await later(80_000)
    const raws = chain.distinctSent()
    expect(raws).toHaveLength(2)
    const orig = parseTransaction(raws[0]!)
    const cancel = parseTransaction(raws[1]!)
    expect(cancel).toMatchObject({ to: RELAYER.toLowerCase(), gas: 21_000n, nonce: orig.nonce })
    expect(cancel.value ?? 0n).toBe(0n)
    expect(cancel.data ?? '0x').toBe('0x')
    expect(cancel.maxPriorityFeePerGas).toBe(parseGwei('37.5'))
    chain.mine(keccak256(raws[1]!))
    await later(5_000)
    expect(row()).toMatchObject({ status: 'failed', error: 'DEADLINE_INVALID', tx_hash: keccak256(raws[1]!) })
    expect(JSON.parse(String(row()!.detail))).toEqual({ reason: 'expired_pending' })
    expect(a.body.status).toBe('submitted')
  })

  it('cancels by deadline - 15 s even inside the 45 s freshness window, and sends no router call after', async () => {
    const { chain, submit, later } = setup()
    const deadlineMs = T0 + 120_000
    await submit(req({ deadline: String(deadlineMs / 1000) }))
    const sends: { at: number; to: string | null | undefined }[] = []
    chain.onSend = (_u, raw) => {
      sends.push({ at: Date.now(), to: parseTransaction(raw).to })
      return keccak256(raw)
    }
    for (let t = 5_000; t <= 150_000; t += 5_000) await later(5_000)
    const cancels = sends.filter(s => s.to === RELAYER.toLowerCase())
    expect(cancels.length).toBeGreaterThan(0)
    expect(cancels[0]!.at).toBeLessThanOrEqual(deadlineMs - 15_000)
    const routerAfter = sends.filter(s => s.to === ROUTER.toLowerCase() && s.at >= cancels[0]!.at)
    expect(routerAfter).toEqual([])
    expect(sends.filter(s => s.to === ROUTER.toLowerCase()).every(s => s.at < deadlineMs - 15_000)).toBe(true)
  })

  it('cancels when the re-simulation reverts and reports the job confirmed if a front-runner landed it', async () => {
    const { chain, submit, row, later } = setup()
    await submit(req())
    chain.onCall = () => revert('InsufficientAllowance')
    await later(50_000)
    const raws = chain.distinctSent()
    expect(raws).toHaveLength(2)
    expect(parseTransaction(raws[1]!).to).toBe(RELAYER.toLowerCase())
    landedAt(chain, FRONT, routerCalldata(parsedOf(req())))
    chain.mine(keccak256(raws[1]!))
    await later(5_000)
    expect(row()).toMatchObject({ status: 'confirmed', tx_hash: FRONT })
    expect(JSON.parse(String(row()!.detail))).toEqual({ reason: 'already_landed' })
  })

  it('bumps 3 times, saving each hash before broadcasting, then cancels a tx that never lands', async () => {
    const { chain, storage, submit, later } = setup()
    await submit(req())
    const seen: boolean[] = []
    chain.onSend = (_u, raw) => {
      seen.push((storage.map.get(`job:${JOB}`) as { hashes: Hex[] }).hashes.includes(keccak256(raw)))
      return keccak256(raw)
    }
    for (let i = 0; i < 4; i++) await later(50_000)
    const tips = chain.distinctSent().map(r => parseTransaction(r).maxPriorityFeePerGas)
    expect(tips).toEqual([parseGwei('30'), parseGwei('37.5'), parseGwei('46.875'), parseGwei('58.59375'), 73_242_187_500n])
    const last = parseTransaction(chain.distinctSent()[4]!)
    expect(last).toMatchObject({ to: RELAYER.toLowerCase(), gas: 21_000n })
    expect(seen).toEqual([true, true, true, true])
  })

  it('settles a nonce used without a visible receipt through findLanded (our own signature)', async () => {
    const { chain, submit, row, later } = setup()
    await submit(req())
    chain.latestNonce = 1
    const OURS = `0x${'0c'.repeat(32)}` as Hex
    landedAt(chain, OURS, routerCalldata(parsedOf(req())))
    await later(50_000)
    await later(5_000)
    expect(row()).toMatchObject({ status: 'submitted' })
    await later(5_000)
    expect(row()).toMatchObject({ status: 'confirmed', tx_hash: OURS })
    expect(chain.distinctSent()).toHaveLength(1)
  })

  it('fails a dropped job only after findLanded finds nothing', async () => {
    const { chain, submit, row, later } = setup()
    await submit(req())
    chain.latestNonce = 1
    for (let i = 0; i < 3; i++) await later(i === 0 ? 50_000 : 5_000)
    expect(row()).toMatchObject({ status: 'failed', error: 'RPC_UNAVAILABLE' })
    expect(JSON.parse(String(row()!.detail))).toEqual({ reason: 'dropped' })
    expect(chain.count('eth_getLogs')).toBeGreaterThan(0)
  })

  it('confirms a mined tx and books its gas', async () => {
    const { chain, submit, row, r, DB } = setup()
    const a = await submit(req())
    chain.mine(a.body.txHash as Hex)
    await r.alarm()
    expect(row()).toMatchObject({ status: 'confirmed' })
    expect(DB.rows('SELECT gas_wei, count FROM relay_budget')).toEqual([
      { gas_wei: (0x4c2c0n * 0x41314cf000n).toString(), count: 1 },
    ])
  })
})
