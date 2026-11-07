// @vitest-environment jsdom
import { ASSETS, LIMITS, type PermitTypedData } from '@accrue/shared'
import { decodeFunctionData, maxUint256 } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocal, jobIdOf, jobsConfig, resetJobs, subscribeJobs, type RelayBody } from '../src/actions/jobs'
import { reduce, type ActionEvent, type ActionState, type Draft } from '../src/actions/machine'
import { deposit } from '../src/features/dollars/deposit'
import { flowConfig, ROUTER_ABI } from '../src/features/dollars/flow'
import { createDollarAction } from '../src/features/dollars/useDollarAction'
import { withdraw } from '../src/features/dollars/withdraw'
import { dicts } from '../src/i18n'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { WrongChainError } from '../src/providers/errors'
import { evm } from '../src/providers/evm'
import { json, mined, OWNER, posts, relayError, ROUTER, sig, stubEvm, stubFetch, TX, type Call } from './fakes'

const supply: Draft = { kind: 'supply', asset: 'USDT0', amount: 5_000_000n }
const withdrawAll: Draft = { kind: 'withdraw', asset: 'USDT0', amount: 'all' }
const J1 = jobIdOf(sig(1))
const J2 = jobIdOf(sig(2))
const GAS_PRICE = 100n * 10n ** 9n
// wallets reserve gasLimit × maxFeePerGas, so the offer needs twice the current price
const FEE_ESTIMATE = flowConfig.selfGasLimit * GAS_PRICE * 2n

function harness(draft: Draft) {
  let state: ActionState = { s: 'signing', draft }
  const events: ActionEvent[] = []
  return {
    events,
    emit: (ev: ActionEvent) => {
      events.push(ev)
      state = reduce(state, ev)
    },
    get state() {
      return state
    },
  }
}

// POST accepts as `submitted`; every GET confirms.
function happyRelay(jobId = J1) {
  return (c: Call) =>
    c.method === 'POST' ? json(202, { jobId, status: 'submitted', txHash: TX }) : json(200, { jobId, status: 'confirmed', txHash: TX })
}

const signed = (spy: { mock: { calls: unknown[][] } }, i = 0) => spy.mock.calls[i]![0] as PermitTypedData
const settle = () => new Promise(r => setTimeout(r, 20))

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

describe('deposit', () => {
  it('signs one permit for the router, relays it and follows the job to confirmed', async () => {
    const ev = stubEvm()
    let gets = 0
    const calls = stubFetch(c =>
      c.method === 'POST'
        ? json(202, { jobId: J1, status: 'queued' })
        : json(200, { jobId: J1, status: ++gets < 2 ? 'submitted' : 'confirmed', txHash: TX }),
    )
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)

    expect(h.state).toMatchObject({ s: 'confirmed', txHash: TX })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.address, OWNER)
    const td = signed(ev.signPermit)
    expect(td.domain).toEqual(ASSETS.USDT0.domain)
    expect(td.message).toMatchObject({ owner: OWNER, spender: ROUTER, value: 5_000_000n, nonce: 0n })
    const left = Number(td.message.deadline) - Date.now() / 1000
    expect(left).toBeGreaterThan(LIMITS.deadlineMinSec)
    expect(left).toBeLessThanOrEqual(LIMITS.deadlineMaxSec)

    expect(posts(calls)).toHaveLength(1)
    expect(posts(calls)[0]!.body).toEqual({
      kind: 'supply',
      asset: 'USDT0',
      owner: OWNER,
      amount: '5000000',
      deadline: td.message.deadline.toString(),
      nonce: '0',
      signature: sig(1),
    })
    const types = h.events.map(e => e.type)
    expect(types[0]).toBe('SIGNED')
    expect(types.at(-1)).toBe('CONFIRMED')
    expect(getLocal(J1)).toMatchObject({ status: 'confirmed', txHash: TX })
  })

  it('PERMIT_NONCE_STALE emits failed with retry resign and does not sign again by itself', async () => {
    const ev = stubEvm()
    const calls = stubFetch(() => relayError(409, 'PERMIT_NONCE_STALE', { expected: '1' }))
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', error: { code: 'PERMIT_NONCE_STALE', retry: 'resign' } })
    expect(h.state).toMatchObject({ s: 'failed', error: { retry: 'resign' } })
    await settle()
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    // a stale permit is never re-posted
    expect(posts(calls)).toHaveLength(1)
  })

  it('after PERMIT_NONCE_STALE the permit is signed again only on the user RESIGN event', async () => {
    const ev = stubEvm()
    let stale = true
    const calls = stubFetch(c => {
      if (c.method === 'POST') {
        return stale ? relayError(409, 'PERMIT_NONCE_STALE', { expected: '1' }) : json(202, { jobId: J2, status: 'submitted', txHash: TX })
      }
      return json(200, { jobId: J2, status: 'confirmed', txHash: TX })
    })
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('failed'))
    expect(a.getState()).toMatchObject({ s: 'failed', error: { code: 'PERMIT_NONCE_STALE', retry: 'resign' } })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)

    stale = false
    await settle()
    // neither a retry nor another submit re-uses the stale permit or opens the wallet
    a.dispatch({ type: 'RETRY' })
    a.dispatch({ type: 'SUBMIT' })
    await settle()
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(posts(calls)).toHaveLength(1)

    a.dispatch({ type: 'RESIGN' })
    a.dispatch({ type: 'RESIGN' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'confirmed', txHash: TX }))
    expect(ev.signPermit).toHaveBeenCalledTimes(2)
    expect(posts(calls).map(c => c.body?.signature)).toEqual([sig(1), sig(2)])
  })

  it('3x JSON 503 relayer_unavailable: same signature re-sent, record kept, self-gas offered, and no second signature', async () => {
    const ev = stubEvm({ polWei: 3n * 10n ** 17n })
    const calls = stubFetch(() => relayError(503, 'RPC_UNAVAILABLE', { reason: 'relayer_unavailable' }))
    const h = harness(supply)
    const ctl = new AbortController()
    void deposit('USDT0', 5_000_000n, { signal: ctl.signal }, h.emit)
    await vi.waitFor(() => expect(h.state).toMatchObject({ s: 'unknown', jobId: J1, offer: { kind: 'selfGas', estimateWei: FEE_ESTIMATE } }))

    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    const sent = posts(calls)
    expect(sent.length).toBeGreaterThanOrEqual(1 + flowConfig.retryDelaysMs.length)
    expect(new Set(sent.map(c => JSON.stringify(c.body))).size).toBe(1)
    expect(ev.polBalance).toHaveBeenCalledWith(OWNER)
    // the relayer may have broadcast before it failed: the record stays and blocks a second permit
    expect(getLocal(J1)?.status).toBe('sent')
    const again = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, again.emit)
    expect(again.state).toMatchObject({ s: 'failed', error: { code: 'PENDING' } })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    ctl.abort()
  })

  it('SELF_GAS while the relayer is unreachable sends the same signature from the wallet', async () => {
    const ev = stubEvm()
    stubFetch(() => relayError(503, 'RPC_UNAVAILABLE', { reason: 'relayer_unavailable' }))
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'unknown', offer: { kind: 'selfGas' } }))
    a.dispatch({ type: 'SELF_GAS' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'confirmed', txHash: TX }))
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(ev.sendTx).toHaveBeenCalledTimes(1)
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: ev.sendTx.mock.calls[0]![0].data })
    expect(args[6]).toBe(`0x${sig(1).slice(66, 130)}`)
    a.dispose()
  })

  it('relayer unreachable with no POL, or less than the fee, offers no self-gas', async () => {
    const down = () => relayError(503, 'RPC_UNAVAILABLE', { reason: 'relayer_unavailable' })
    for (const polWei of [0n, FEE_ESTIMATE, flowConfig.selfGasLimit * GAS_PRICE + 1n]) {
      vi.restoreAllMocks()
      resetJobs()
      localStorage.clear()
      stubEvm({ polWei })
      stubFetch(down)
      const h = harness(supply)
      const ctl = new AbortController()
      void deposit('USDT0', 5_000_000n, { signal: ctl.signal }, h.emit)
      await vi.waitFor(() => expect(h.state.s).toBe('unknown'))
      expect(h.state).not.toHaveProperty('offer')
      ctl.abort()
    }
  })

  it('a definite 503 (chain reads failed before the relayer) is a refusal that still offers self-gas', async () => {
    stubEvm()
    stubFetch(() => relayError(503, 'RPC_UNAVAILABLE', { reason: 'read_failed' }))
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'RPC_UNAVAILABLE', retry: 'same' }, offer: { kind: 'selfGas' } })
    expect(getLocal(J1)).toBeUndefined()
  })

  it.each([
    ['RELAYER_LOW_GAS', () => relayError(503, 'RELAYER_LOW_GAS'), 1],
    ['BUDGET_EXHAUSTED', () => relayError(503, 'BUDGET_EXHAUSTED'), 1],
    ['INTERNAL db_error (JSON 500)', () => relayError(500, 'INTERNAL', { reason: 'db_error' }), 3],
  ])('%s offers self-gas', async (_name, answer, tries) => {
    const ev = stubEvm()
    const calls = stubFetch(answer)
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', offer: { kind: 'selfGas' } })
    expect(posts(calls)).toHaveLength(tries)
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Cloudflare 1102 (not JSON)', () => new Response('error code: 1102', { status: 503 })],
    ['a bare 500', () => new Response('Internal Server Error', { status: 500 })],
  ])('%s may have reached the relay: unknown, record kept, no offer', async (_name, answer) => {
    const ev = stubEvm()
    const calls = stubFetch(answer)
    const h = harness(supply)
    const ctl = new AbortController()
    void deposit('USDT0', 5_000_000n, { signal: ctl.signal }, h.emit)
    await vi.waitFor(() => expect(h.state).toMatchObject({ s: 'unknown', jobId: J1 }))
    expect(posts(calls).length).toBeGreaterThanOrEqual(3)
    expect(new Set(posts(calls).map(c => JSON.stringify(c.body))).size).toBe(1)
    expect(h.events.some(e => e.type === 'FAILED')).toBe(false)
    expect(getLocal(J1)?.status).toBe('sent')
    expect(ev.polBalance).not.toHaveBeenCalled()
    ctl.abort()
  })

  it('a lost answer followed by 500s keeps the record and blocks a second signature (one intent, one deposit)', async () => {
    const ev = stubEvm()
    let n = 0
    const calls = stubFetch(c => {
      if (c.method !== 'POST') return json(404, { error: 'INTERNAL', detail: { reason: 'not_found' } })
      n += 1
      if (n === 1) throw new TypeError('Failed to fetch')
      return relayError(500, 'INTERNAL', { reason: 'db_error' })
    })
    const h = harness(supply)
    const ctl = new AbortController()
    void deposit('USDT0', 5_000_000n, { signal: ctl.signal }, h.emit)
    await vi.waitFor(() => expect(h.state).toMatchObject({ s: 'unknown', jobId: J1 }))
    expect(h.events.some(e => e.type === 'FAILED')).toBe(false)
    expect(getLocal(J1)?.status).toBe('sent')

    const again = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, again.emit)
    expect(again.state).toMatchObject({ s: 'failed', error: { code: 'PENDING' } })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(new Set(posts(calls).map(c => c.body?.signature))).toEqual(new Set([sig(1)]))
    ctl.abort()
  })

  it.each([
    ['landed check unavailable', { expected: '1', landedCheck: 'unavailable' }],
    ['plain stale with the nonce moved past ours (findLanded negative is not trusted)', { expected: '1' }],
  ])('a re-send in the same tap answered stale (%s) is landed, not a reason to sign again', async (_name, detail) => {
    const ev = stubEvm()
    let n = 0
    stubFetch(() => {
      n += 1
      return n === 1 ? relayError(503, 'RPC_UNAVAILABLE', { reason: 'relayer_unavailable' }) : relayError(409, 'PERMIT_NONCE_STALE', detail)
    })
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'confirmed', elsewhere: true })
    expect(getLocal(J1)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
  })

  it('a re-send answered stale without "expected" asks the chain: nonce past ours means landed', async () => {
    const ev = stubEvm()
    let n = 0
    stubFetch(() => {
      n += 1
      return n === 1 ? relayError(503, 'RPC_UNAVAILABLE', { reason: 'read_failed' }) : relayError(409, 'PERMIT_NONCE_STALE')
    })
    ev.permitNonce.mockResolvedValueOnce(0n).mockResolvedValue(1n)
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'confirmed', elsewhere: true })
  })

  it('RETRY of a signature that then turns out used is landed; a fresh signature answered the same is plain stale', async () => {
    const ev = stubEvm()
    let down = true
    stubFetch(() =>
      down ? relayError(503, 'RPC_UNAVAILABLE', { reason: 'read_failed' }) : relayError(409, 'PERMIT_NONCE_STALE', { expected: '1' }),
    )
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('failed'))
    down = false
    a.dispatch({ type: 'RETRY' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'confirmed', elsewhere: true }))
    expect(ev.signPermit).toHaveBeenCalledTimes(1)

    // a brand-new signature answered the same way never went out before, so it is simply stale
    a.dispatch({ type: 'RESET' })
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'failed', error: { code: 'PERMIT_NONCE_STALE', retry: 'resign' } }))
  })

  it('400 INTERNAL bad_request is not retried: the same body can only fail again', async () => {
    stubEvm()
    const calls = stubFetch(() => relayError(400, 'INTERNAL', { reason: 'bad_request', field: 'nonce' }))
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'INTERNAL', retry: 'none' } })
    expect(posts(calls)).toHaveLength(1)
  })

  it('a job confirmed without a tx hash still ends confirmed', async () => {
    stubEvm()
    stubFetch(c => (c.method === 'POST' ? json(202, { jobId: J1, status: 'submitted' }) : json(200, { jobId: J1, status: 'confirmed' })))
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'confirmed', jobId: J1 })
    expect(h.state).not.toHaveProperty('txHash')
  })

  it.each([
    ['INSUFFICIENT_BALANCE', 422],
    ['SIMULATION_FAILED', 422],
    ['RATE_LIMITED', 429],
    ['AMOUNT_TOO_LARGE', 400],
  ])('%s offers no self-gas and is not re-sent', async (code, status) => {
    const ev = stubEvm()
    const calls = stubFetch(() => relayError(status, code))
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code } })
    expect(h.state).not.toHaveProperty('offer')
    expect(ev.polBalance).not.toHaveBeenCalled()
    expect(posts(calls)).toHaveLength(1)
  })

  it('RETRY after a 503 re-posts the identical body without a new signature', async () => {
    const ev = stubEvm()
    let down = true
    const calls = stubFetch(c => (down && c.method === 'POST' ? relayError(503, 'RPC_UNAVAILABLE') : happyRelay()(c)))
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('failed'))
    down = false
    a.dispatch({ type: 'RETRY' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'confirmed', txHash: TX }))
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(new Set(posts(calls).map(c => JSON.stringify(c.body))).size).toBe(1)
  })

  it('SELF_GAS sends supplyWithPermit from the user wallet with the same signature', async () => {
    const ev = stubEvm()
    ev.txReceipt.mockResolvedValueOnce(null).mockResolvedValue(mined('success'))
    stubFetch(() => relayError(503, 'RELAYER_LOW_GAS'))
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'failed', offer: { kind: 'selfGas' } }))

    a.dispatch({ type: 'SELF_GAS' })
    a.dispatch({ type: 'SELF_GAS' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'confirmed', txHash: TX }))
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(ev.sendTx).toHaveBeenCalledTimes(1)
    const tx = ev.sendTx.mock.calls[0]![0]
    expect(tx).toMatchObject({ from: OWNER, to: ROUTER })
    const deadline = signed(ev.signPermit).message.deadline
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data })
    expect(functionName).toBe('supplyWithPermit')
    const S = sig(1)
    expect(args).toEqual([ASSETS.USDT0.address, OWNER, 5_000_000n, deadline, 27, `0x${S.slice(2, 66)}`, `0x${S.slice(66, 130)}`])
    expect(getLocal(TX)).toMatchObject({ via: 'wallet', status: 'confirmed' })
  })

  it('a network error after signing is unknown; it keeps checking and re-sends the same signature once the relay is back', async () => {
    const ev = stubEvm()
    let online = false
    const posted: unknown[] = []
    stubFetch(c => {
      if (!online) throw new TypeError('Failed to fetch')
      if (c.method === 'POST') {
        posted.push(c.body)
        return json(202, { jobId: J1, status: 'submitted', txHash: TX })
      }
      return posted.length === 0 ? json(404, { error: 'INTERNAL', detail: { reason: 'not_found' } }) : json(200, { jobId: J1, status: 'confirmed', txHash: TX })
    })
    const h = harness(supply)
    const run = deposit('USDT0', 5_000_000n, {}, h.emit)
    await vi.waitFor(() => expect(h.state).toMatchObject({ s: 'unknown', jobId: J1 }))
    expect(getLocal(J1)?.status).toBe('sent')
    expect(h.events.some(e => e.type === 'FAILED')).toBe(false)

    online = true
    await run
    expect(h.state).toMatchObject({ s: 'confirmed', txHash: TX })
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(1)
    expect((posted[0] as RelayBody).signature).toBe(sig(1))
  })

  it('a rejected signature is cancelled and nothing is sent or stored', async () => {
    const ev = stubEvm()
    ev.signPermit.mockRejectedValue(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    const calls = stubFetch(happyRelay())
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'cancelled' })
    expect(calls).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })

  it('off Polygon the flow stops before any read or signature and asks for the switch step', async () => {
    const ev = stubEvm({ onPolygon: false })
    const calls = stubFetch(happyRelay())
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.events).toEqual([{ type: 'WRONG_CHAIN' }])
    expect(h.state).toEqual({ s: 'confirm', draft: supply, chain: 'switch' })
    expect(ev.signPermit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('a wallet that left Polygon between taps goes back to the switch step, with nothing sent', async () => {
    const ev = stubEvm()
    ev.signPermit.mockRejectedValue(new WrongChainError('0x1'))
    const calls = stubFetch(happyRelay())
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toEqual({ s: 'confirm', draft: supply, chain: 'switch' })
    expect(calls).toHaveLength(0)
  })

  it('switching chains is its own tap and never chains a signature', async () => {
    const ev = stubEvm({ onPolygon: false })
    const ensure = vi.spyOn(evm, 'ensurePolygon').mockImplementation(async () => {
      ev.isPolygon.mockResolvedValue(true)
    })
    stubFetch(happyRelay())
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    await vi.waitFor(() => expect(a.getState()).toEqual({ s: 'confirm', draft: supply, chain: 'switch' }))
    a.dispatch({ type: 'SUBMIT' })
    expect(a.getState()).toEqual({ s: 'confirm', draft: supply, chain: 'switch' })

    expect(await a.switchChain()).toBeNull()
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(a.getState()).toEqual({ s: 'confirm', draft: supply })
    expect(ev.signPermit).not.toHaveBeenCalled()

    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('confirmed'))
    expect(ev.signPermit).toHaveBeenCalledTimes(1)
  })

  it('a switch that only added Polygon keeps the switch step for the next tap', async () => {
    stubEvm({ onPolygon: false })
    vi.spyOn(evm, 'ensurePolygon').mockRejectedValue(new WrongChainError('0x1'))
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: supply })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ chain: 'switch' }))
    expect(await a.switchChain()).toBeNull()
    expect(a.getState()).toEqual({ s: 'confirm', draft: supply, chain: 'switch' })
  })

  it('amount limits and the balance are checked before any signature', async () => {
    const ev = stubEvm({ balance: 1_000_000n })
    const calls = stubFetch(happyRelay())
    const run = async (amount: bigint) => {
      const h = harness({ ...supply, amount })
      await deposit('USDT0', amount, {}, h.emit)
      return h.state
    }
    expect(await run(LIMITS.minDepositUnits - 1n)).toMatchObject({ s: 'failed', error: { code: 'AMOUNT_TOO_SMALL', retry: 'none' } })
    expect(await run(LIMITS.maxTxUnits + 1n)).toMatchObject({ s: 'failed', error: { code: 'AMOUNT_TOO_LARGE' } })
    expect(await run(5_000_000n)).toMatchObject({ s: 'failed', error: { code: 'INSUFFICIENT_BALANCE', detail: { balance: '1000000' } } })
    expect(ev.signPermit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('without a deployed router it says so and never asks for a signature', async () => {
    const ev = stubEvm()
    flowConfig.router = null
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { messageKey: 'dollars.error.notDeployed', retry: 'none' } })
    expect(dicts.en['dollars.error.notDeployed']).toBeTypeOf('string')
    expect(ev.signPermit).not.toHaveBeenCalled()
  })

  it('without a connected wallet it asks to connect first, with no dialog', async () => {
    const ev = stubEvm({ connected: false })
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { messageKey: 'dollars.error.connectFirst' } })
    expect(dicts.en['dollars.error.connectFirst']).toBeTypeOf('string')
    expect(ev.signPermit).not.toHaveBeenCalled()
  })

  it('USDC from a wallet with code is explained, not re-signed', async () => {
    stubEvm()
    stubFetch(() => relayError(400, 'BAD_SIGNATURE', { reason: 'owner_has_code' }))
    const h = harness({ ...supply, asset: 'USDC' })
    await deposit('USDC', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'BAD_SIGNATURE', retry: 'none', messageKey: 'dollars.error.ownerHasCode' } })
    expect(dicts.en['dollars.error.ownerHasCode']).toBeTypeOf('string')
  })

  it('a stale answer pointing at a job already on its way says so instead of asking to sign again', async () => {
    stubEvm()
    const other = `0x${'9'.repeat(64)}`
    stubFetch(c =>
      c.method === 'POST'
        ? relayError(409, 'PERMIT_NONCE_STALE', { reason: 'in_flight', jobId: other })
        : c.path.startsWith('/api/relay/by-owner/')
          ? json(200, { jobs: [] })
          : json(200, { jobId: other, status: 'submitted' }),
    )
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'PENDING', retry: 'none', detail: { jobId: other } } })
  })

  it('a job the relay calls dropped whose permit nonce is used landed after all: confirmed, never a new signature', async () => {
    const ev = stubEvm()
    ev.permitNonce.mockResolvedValueOnce(0n).mockResolvedValue(1n)
    stubFetch(c =>
      c.method === 'POST'
        ? json(202, { jobId: J1, status: 'submitted', txHash: TX })
        : json(200, { jobId: J1, status: 'failed', txHash: TX, error: 'RPC_UNAVAILABLE', detail: { reason: 'dropped', landedCheck: 'unavailable' } }),
    )
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'confirmed', elsewhere: true })
    expect(getLocal(J1)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } })
    expect(ev.permitNonce).toHaveBeenLastCalledWith(ASSETS.USDT0.address, OWNER)
  })

  it('a job that fails on-chain asks for a fresh signature, since the same one would only find the same failed job', async () => {
    stubEvm()
    stubFetch(c =>
      c.method === 'POST'
        ? json(202, { jobId: J1, status: 'submitted', txHash: TX })
        : json(200, { jobId: J1, status: 'failed', txHash: TX, error: 'RPC_UNAVAILABLE', detail: { reason: 'dropped' } }),
    )
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', txHash: TX, error: { code: 'RPC_UNAVAILABLE', retry: 'resign' } })
    expect(getLocal(J1)).toMatchObject({ status: 'failed', error: 'RPC_UNAVAILABLE' })
  })
})

describe('withdraw', () => {
  it('all: amount is 2^256-1 and the aToken permit value is balance + balance/100000 + 10', async () => {
    const ev = stubEvm({ aBalance: 100_000_000n })
    const calls = stubFetch(c => (c.method === 'POST' ? json(202, { jobId: J1, status: 'confirmed', txHash: TX }) : json(500, {})))
    const h = harness(withdrawAll)
    await withdraw('USDT0', 'all', {}, h.emit)

    const td = signed(ev.signPermit)
    expect(td.domain).toEqual(ASSETS.USDT0.aDomain)
    expect(td.message).toMatchObject({ owner: OWNER, spender: ROUTER, value: 100_000_000n + 1_000n + 10n })
    expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.aToken, OWNER)
    expect(ev.tokenBalance).toHaveBeenCalledWith(ASSETS.USDT0.aToken, OWNER)
    expect(posts(calls)[0]!.body).toMatchObject({ kind: 'withdraw', asset: 'USDT0', amount: maxUint256.toString(), permitValue: '100001010' })
    // the relay found it already landed and answered confirmed straight away
    expect(h.state).toMatchObject({ s: 'confirmed', txHash: TX })
  })

  it('a partial withdraw signs exactly the amount', async () => {
    const ev = stubEvm({ aBalance: 100_000_000n })
    const calls = stubFetch(happyRelay())
    const h = harness({ kind: 'withdraw', asset: 'USDC', amount: 40_000_000n })
    await withdraw('USDC', 40_000_000n, {}, h.emit)
    expect(signed(ev.signPermit).domain).toEqual(ASSETS.USDC.aDomain)
    expect(signed(ev.signPermit).message.value).toBe(40_000_000n)
    expect(posts(calls)[0]!.body).toMatchObject({ kind: 'withdraw', asset: 'USDC', amount: '40000000', permitValue: '40000000' })
    expect(h.state.s).toBe('confirmed')
  })

  it('more than the position, or "all" of nothing, is refused before signing', async () => {
    const ev = stubEvm({ aBalance: 0n })
    stubFetch(happyRelay())
    const h = harness(withdrawAll)
    await withdraw('USDT0', 'all', {}, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'INSUFFICIENT_BALANCE' } })
    const h2 = harness({ kind: 'withdraw', asset: 'USDT0', amount: 1n })
    await withdraw('USDT0', 1n, {}, h2.emit)
    expect(h2.state).toMatchObject({ s: 'failed', error: { code: 'INSUFFICIENT_BALANCE' } })
    expect(ev.signPermit).not.toHaveBeenCalled()
  })

  it('AAVE_LIQUIDITY surfaces the available amount and offers to withdraw that much (Review Focus 5)', async () => {
    const ev = stubEvm()
    stubFetch(() => relayError(422, 'AAVE_LIQUIDITY', { available: '3000000' }))
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: withdrawAll })
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('failed'))
    expect(a.getState()).toMatchObject({
      s: 'failed',
      error: { code: 'AAVE_LIQUIDITY', retry: 'none', detail: { available: '3000000' } },
      offer: { kind: 'withdrawAvailable', amount: 3_000_000n },
    })
    expect(ev.polBalance).not.toHaveBeenCalled()
    // taking the offer is a new draft for exactly that amount
    a.dispatch({ type: 'DRAFT', draft: { kind: 'withdraw', asset: 'USDT0', amount: 3_000_000n } })
    expect(a.getState()).toMatchObject({ s: 'confirm', draft: { amount: 3_000_000n } })
  })

  it('self-gas sends withdrawWithPermit with amount, permit value and the same signature', async () => {
    const ev = stubEvm()
    stubFetch(() => json(404, {}))
    const body: RelayBody = {
      kind: 'withdraw',
      asset: 'USDC',
      owner: OWNER,
      amount: maxUint256.toString(),
      permitValue: '100001010',
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '4',
      signature: sig(7),
    }
    const h = harness({ kind: 'withdraw', asset: 'USDC', amount: 'all' })
    await withdraw('USDC', 'all', { reuse: body, selfGas: true }, h.emit)
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_ABI, data: ev.sendTx.mock.calls[0]![0].data })
    expect(functionName).toBe('withdrawWithPermit')
    const S = sig(7)
    expect(args).toEqual([
      ASSETS.USDC.address,
      OWNER,
      maxUint256,
      100_001_010n,
      BigInt(body.deadline),
      27,
      `0x${S.slice(2, 66)}`,
      `0x${S.slice(66, 130)}`,
    ])
    expect(ev.signPermit).not.toHaveBeenCalled()
    expect(h.state).toMatchObject({ s: 'confirmed', txHash: TX })
  })

  it('a self-paid tx that reverts because the relay already used the permit is reported as landed', async () => {
    const ev = stubEvm()
    ev.txReceipt.mockResolvedValue(mined('reverted'))
    ev.permitNonce.mockResolvedValue(5n)
    stubFetch(() => json(404, {}))
    const body: RelayBody = {
      kind: 'supply',
      asset: 'USDT0',
      owner: OWNER,
      amount: '5000000',
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '4',
      signature: sig(9),
    }
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, { reuse: body, selfGas: true }, h.emit)
    expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDT0.address, OWNER, 100n)
    expect(h.state).toMatchObject({ s: 'confirmed', elsewhere: true })
    expect(h.state).not.toHaveProperty('txHash')
    expect(getLocal(TX)).toMatchObject({ status: 'confirmed', detail: { landed: 'elsewhere' } })
  })

  it('the revert check reads the nonce at the revert block, so a lagging node cannot turn a landed deposit into a failure', async () => {
    const ev = stubEvm()
    ev.txReceipt.mockResolvedValue(mined('reverted', 500n))
    let calls = 0
    // a node behind the revert block answers with the old nonce at "latest" and cannot serve block 500 yet
    ev.permitNonce.mockImplementation(async (_token, _owner, at?: bigint) => {
      calls += 1
      if (at === undefined) return 4n
      if (calls === 1) throw new Error('header not found')
      return at >= 500n ? 5n : 4n
    })
    stubFetch(() => json(404, {}))
    const seen: string[] = []
    const off = subscribeJobs(() => {
      const r = getLocal(TX)
      if (r) seen.push(r.status)
    })
    const body: RelayBody = {
      kind: 'supply',
      asset: 'USDT0',
      owner: OWNER,
      amount: '5000000',
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '4',
      signature: sig(11),
    }
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, { reuse: body, selfGas: true }, h.emit)
    off()
    expect(h.state).toMatchObject({ s: 'confirmed', elsewhere: true })
    expect(ev.permitNonce.mock.calls.every(c => c[2] === 500n)).toBe(true)
    expect(seen).not.toContain('failed')
  })

  it('a self-paid tx that reverts with the permit still unused fails for good', async () => {
    const ev = stubEvm()
    ev.txReceipt.mockResolvedValue(mined('reverted'))
    ev.permitNonce.mockResolvedValue(4n)
    stubFetch(() => json(404, {}))
    const body: RelayBody = {
      kind: 'withdraw',
      asset: 'USDC',
      owner: OWNER,
      amount: '40000000',
      permitValue: '40000000',
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '4',
      signature: sig(10),
    }
    const h = harness({ kind: 'withdraw', asset: 'USDC', amount: 40_000_000n })
    await withdraw('USDC', 40_000_000n, { reuse: body, selfGas: true }, h.emit)
    expect(ev.permitNonce).toHaveBeenCalledWith(ASSETS.USDC.aToken, OWNER, 100n)
    expect(h.state).toMatchObject({ s: 'failed', txHash: TX, error: { code: 'SIMULATION_FAILED', retry: 'none' } })
  })

  it('an expired signature is never sent, by relay or wallet', async () => {
    const ev = stubEvm()
    const calls = stubFetch(happyRelay())
    const body: RelayBody = {
      kind: 'supply',
      asset: 'USDT0',
      owner: OWNER,
      amount: '5000000',
      deadline: String(Math.floor(Date.now() / 1000) + 30),
      nonce: '0',
      signature: sig(8),
    }
    const h = harness(supply)
    await deposit('USDT0', 5_000_000n, { reuse: body, selfGas: true }, h.emit)
    expect(h.state).toMatchObject({ s: 'failed', error: { code: 'DEADLINE_INVALID', retry: 'resign' } })
    const h2 = harness(supply)
    await deposit('USDT0', 5_000_000n, { reuse: body }, h2.emit)
    expect(h2.state).toMatchObject({ s: 'failed', error: { code: 'DEADLINE_INVALID', retry: 'resign' } })
    expect(ev.sendTx).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe('against the dev mock (real evm wrapper)', () => {
  afterEach(() => uninstallMock(window))

  async function start(scenario: string, draft: Draft = { kind: 'supply', asset: 'USDT0', amount: 1_000_000n }) {
    const m = installMock(`?mock=${scenario}&delay=0&chain=0x89`, window)
    await evm.connect()
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft })
    await settle()
    a.dispatch({ type: 'SUBMIT' })
    return { a, m }
  }
  const signs = (m: { calls: { method: string }[] }) => m.calls.filter(c => c.method === 'eth_signTypedData_v4').length

  it('happy: a $1 deposit goes through to confirmed with one signature', async () => {
    const { a, m } = await start('happy')
    await vi.waitFor(() => expect(a.getState().s).toBe('confirmed'))
    expect(signs(m)).toBe(1)
  })

  it('stale-nonce: asks for a fresh signature, and the re-signed permit goes through', async () => {
    const { a, m } = await start('stale-nonce')
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'failed', error: { code: 'PERMIT_NONCE_STALE' } }))
    expect(signs(m)).toBe(1)
    a.dispatch({ type: 'RESIGN' })
    await vi.waitFor(() => expect(a.getState().s).toBe('confirmed'))
    expect(signs(m)).toBe(2)
  })

  it('relay-down: offers paying the fee from the POL the wallet holds', async () => {
    const { a } = await start('relay-down')
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'unknown', offer: { kind: 'selfGas' } }))
    a.dispose()
  })

  it('aave-illiquid: offers the 3.00 that is available', async () => {
    const { a } = await start('aave-illiquid', { kind: 'withdraw', asset: 'USDT0', amount: 'all' })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'failed', offer: { kind: 'withdrawAvailable', amount: 3_000_000n } }))
  })

  it('insufficient: refused before the wallet is asked anything', async () => {
    const { a, m } = await start('insufficient')
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ s: 'failed', error: { code: 'INSUFFICIENT_BALANCE' } }))
    expect(signs(m)).toBe(0)
  })

  it('reject-sign: cancelled, and nothing reaches the relay', async () => {
    const { a, m } = await start('reject-sign')
    await vi.waitFor(() => expect(a.getState().s).toBe('cancelled'))
    expect(signs(m)).toBe(1)
    expect(localStorage.length).toBe(0)
  })

  it('a wallet on Ethereum: the first tap is the switch, the second the only signature', async () => {
    const m = installMock('?mock=happy&delay=0', window)
    await evm.connect()
    const a = createDollarAction()
    a.dispatch({ type: 'DRAFT', draft: { kind: 'supply', asset: 'USDT0', amount: 1_000_000n } })
    await vi.waitFor(() => expect(a.getState()).toMatchObject({ chain: 'switch' }))
    await a.switchChain()
    const dialogs = () => m.calls.filter(c => !['eth_chainId', 'eth_requestAccounts'].includes(c.method)).map(c => c.method)
    expect(dialogs()).toEqual(['wallet_switchEthereumChain'])
    a.dispatch({ type: 'SUBMIT' })
    await vi.waitFor(() => expect(a.getState().s).toBe('confirmed'))
    expect(dialogs()).toEqual(['wallet_switchEthereumChain', 'eth_signTypedData_v4'])
  })
})
