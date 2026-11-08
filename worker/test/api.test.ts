import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionResult, keccak256, multicall3Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildPermit } from '@accrue/shared'
import worker from '../src/index'
import { app } from '../src/app'
import { FakeChain, fakeD1 } from './helpers'

vi.mock('cloudflare:workers', async () => (await import('./helpers')).fakeDurableObjectModule())

// Registered before the first request: Hono freezes its router once it has matched anything.
app.get('/api/__boom', () => {
  throw new Error('secret internals')
})

const ROUTER = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f'
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')

async function permitBody(signer = owner, over: Record<string, string> = {}) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const signature = await signer.signTypedData(
    buildPermit({ token: 'asset', asset: 'USDT0', owner: owner.address, spender: ROUTER, value: 5_000_000n, nonce: 0n, deadline }),
  )
  return { kind: 'supply', asset: 'USDT0', owner: owner.address, amount: '5000000', deadline: String(deadline), nonce: '0', signature, ...over }
}

function setup(over: Record<string, unknown> = {}) {
  const submit = vi.fn(async () => ({ status: 202, json: JSON.stringify({ jobId: 'x', status: 'submitted' }) }))
  const RELAYER = { idFromName: vi.fn(() => 'id'), get: vi.fn(() => ({ submit })) }
  const env = { DB: fakeD1(), RELAYER, POLYGON_RPCS: 'https://rpc.test', RELAYER_ADDRESS: '', ROUTER_ADDRESS: ROUTER, NIM_RPCS: '', ...over }
  const call = async (path: string, init?: RequestInit) => {
    const res = await worker.fetch(new Request(`http://w${path}`, init), env as never, {} as never)
    return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as Record<string, unknown> }
  }
  const post = (body: unknown) =>
    call('/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { env, submit, RELAYER, call, post }
}

const bad = (field: string) => ({ status: 400, body: { error: 'INTERNAL', detail: { reason: 'bad_request', field } } })

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/relay input errors', () => {
  it('answers malformed fields with 400 INTERNAL bad_request and never calls the relayer', async () => {
    const { post, submit } = setup()
    const good = await permitBody()
    expect(await post({ ...good, nonce: 'abc' })).toMatchObject(bad('nonce'))
    expect(await post({ ...good, amount: '5e6' })).toMatchObject(bad('amount'))
    expect(await post({ ...good, kind: 'borrow' })).toMatchObject(bad('kind'))
    expect(await post({ ...good, owner: 'nope' })).toMatchObject(bad('owner'))
    expect(await post('{not json')).toMatchObject({ status: 400, body: { error: 'INTERNAL', detail: { reason: 'bad_request' } } })
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects a permit signed by someone else before touching the relayer or Polygon', async () => {
    const chain = new FakeChain()
    vi.stubGlobal('fetch', chain.fetch)
    const { post, submit } = setup()
    expect(await post(await permitBody(stranger))).toMatchObject({ status: 400, body: { error: 'BAD_SIGNATURE', detail: { reason: 'signer_mismatch' } } })
    expect(submit).not.toHaveBeenCalled()
    expect(chain.calls).toHaveLength(0)
  })

  it('answers a well-formed signature that cannot be recovered (r = n, r off the curve) with 400 BAD_SIGNATURE', async () => {
    const P = 2n ** 256n - 2n ** 32n - 977n
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const pow = (b: bigint, e: bigint) => {
      let r = 1n
      for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P
      return r
    }
    // Smallest x for which x^3 + 7 has no square root mod p: no curve point has that x.
    let offCurve = 1n
    while (pow(offCurve ** 3n + 7n, (P - 1n) / 2n) !== P - 1n) offCurve++
    const sig = (r: bigint) => `0x${r.toString(16).padStart(64, '0')}${'0'.repeat(63)}1${'1b'}` as Hex

    const chain = new FakeChain()
    vi.stubGlobal('fetch', chain.fetch)
    const { post, submit } = setup()
    const good = await permitBody()
    for (const r of [N, offCurve]) {
      const res = await post({ ...good, signature: sig(r) })
      expect(res, `r = ${r}`).toMatchObject({ status: 400, body: { error: 'BAD_SIGNATURE', detail: { reason: 'invalid_signature' } } })
    }
    expect(submit).not.toHaveBeenCalled()
    expect(chain.calls).toHaveLength(0)
  })
})

describe('POST /api/relay handoff', () => {
  /** Owner nonce 0, balance 10 USDT0; the router simulation succeeds. */
  function healthyChain() {
    const chain = new FakeChain()
    chain.onCall = params => {
      const to = String((params[0] as { to: string }).to).toLowerCase()
      if (to !== '0xca11bde05977b3631167028862be2a173976ca11') return '0x'
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: [
          { success: true, returnData: `0x${'0'.repeat(64)}` },
          { success: true, returnData: `0x${(10_000_000).toString(16).padStart(64, '0')}` },
        ],
      })
    }
    vi.stubGlobal('fetch', chain.fetch)
    return chain
  }

  it('validates, reads and simulates in the Worker, then hands the DO only the parsed job', async () => {
    const chain = healthyChain()
    const { post, submit } = setup()
    const body = await permitBody()
    const res = await post(body)
    expect(res.status).toBe(202)
    expect(submit).toHaveBeenCalledTimes(1)
    const sent = (submit.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(sent).toMatchObject({ jobId: keccak256(body.signature.toLowerCase() as Hex), kind: 'supply', owner: owner.address, amount: '5000000', nonce: '0' })
    expect(chain.calls.map(c => c.method)).toEqual(['eth_call', 'eth_call'])
  })

  it('maps a Durable Object failure (e.g. reset by a deploy) to 503 RPC_UNAVAILABLE JSON', async () => {
    healthyChain()
    const { post, submit } = setup()
    submit.mockRejectedValueOnce(new Error('Durable Object reset because its code was updated.'))
    const res = await post(await permitBody())
    expect(res).toMatchObject({ status: 503, type: 'application/json', body: { error: 'RPC_UNAVAILABLE', detail: { reason: 'relayer_unavailable' } } })
    expect(JSON.stringify(res.body)).not.toContain('reset')
  })
})

describe('GET /api/relay', () => {
  it('answers a malformed owner or job id with 400 bad_request, an unknown job with 404', async () => {
    const { call } = setup()
    expect(await call('/api/relay/by-owner/nope')).toMatchObject(bad('owner'))
    expect(await call('/api/relay/0x1234')).toMatchObject(bad('jobId'))
    expect(await call(`/api/relay/${keccak256('0x01')}`)).toMatchObject({ status: 404, body: { error: 'INTERNAL', detail: { reason: 'not_found' } } })
  })

  it('maps a D1 failure to JSON, not a plain-text 500', async () => {
    const DB = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1_ERROR: internal') }, all: async () => { throw new Error('D1_ERROR: internal') } }) }) }
    const { call } = setup({ DB })
    const one = await call(`/api/relay/${keccak256('0x01')}`)
    expect(one).toMatchObject({ status: 500, type: 'application/json', body: { error: 'INTERNAL', detail: { reason: 'db_error' } } })
    const list = await call(`/api/relay/by-owner/${owner.address}`)
    expect(list).toMatchObject({ status: 500, body: { error: 'INTERNAL', detail: { reason: 'db_error' } } })
  })
})

describe('app.onError', () => {
  it('turns any uncaught error into INTERNAL JSON without the message', async () => {
    const { call } = setup()
    const res = await call('/api/__boom')
    expect(res).toMatchObject({ status: 500, type: 'application/json', body: { error: 'INTERNAL' } })
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })
})
