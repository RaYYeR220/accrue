import { describe, expect, it } from 'vitest'
import { reduce, type ActionState, type Draft } from '../src/actions/machine'
import { toUiError, WrongChainError } from '../src/providers/errors'

const draft: Draft = { kind: 'supply', asset: 'USDT0', amount: 5_000_000n }
const J = `0x${'1'.repeat(64)}`
const TX = `0x${'ab'.repeat(32)}` as const

const idle: ActionState = { s: 'idle' }
const confirm: ActionState = { s: 'confirm', draft }
const signing: ActionState = { s: 'signing', draft }
const submitted: ActionState = { s: 'submitted', jobId: J, draft }
const unknown: ActionState = { s: 'unknown', jobId: J, draft }

const rejected = toUiError({ code: 4001, message: 'User rejected the request.' })
const offline = toUiError(new TypeError('Failed to fetch'))
const stale = toUiError({ error: 'PERMIT_NONCE_STALE', detail: { expected: '1' } })
const relayDown = toUiError({ error: 'RPC_UNAVAILABLE', detail: { reason: 'relayer_unavailable' } })
const reverted = toUiError({ error: 'SIMULATION_FAILED', detail: { reason: 'reverted_onchain' } })

describe('action state machine', () => {
  it('runs confirm → signing → submitted → confirmed', () => {
    let s = reduce(idle, { type: 'DRAFT', draft })
    expect(s).toEqual({ s: 'confirm', draft })
    s = reduce(s, { type: 'SUBMIT' })
    expect(s).toMatchObject({ s: 'signing', draft })
    s = reduce(s, { type: 'ACCEPTED', jobId: J })
    expect(s).toMatchObject({ s: 'submitted', jobId: J })
    s = reduce(s, { type: 'ACCEPTED', jobId: J, txHash: TX })
    expect(s).toMatchObject({ s: 'submitted', jobId: J, txHash: TX })
    s = reduce(s, { type: 'CONFIRMED', txHash: TX })
    expect(s).toMatchObject({ s: 'confirmed', txHash: TX })
  })

  it('a rejection in the wallet while signing is cancelled, not failed', () => {
    expect(rejected.code).toBe('USER_REJECTED')
    expect(reduce(signing, { type: 'FAILED', error: rejected })).toMatchObject({ s: 'cancelled' })
  })

  it('a network error while submitted is unknown, not failed', () => {
    expect(reduce(submitted, { type: 'ERROR', error: offline })).toEqual({ s: 'unknown', jobId: J, draft })
    // even when reported as a failure, losing the connection never fails a job that may still land
    expect(reduce(submitted, { type: 'FAILED', error: offline })).toEqual({ s: 'unknown', jobId: J, draft })
    expect(reduce(unknown, { type: 'ERROR', error: offline })).toBe(unknown)
  })

  it('a second SUBMIT while submitted is ignored', () => {
    expect(reduce(submitted, { type: 'SUBMIT' })).toBe(submitted)
    expect(reduce(signing, { type: 'SUBMIT' })).toBe(signing)
    expect(reduce(unknown, { type: 'SUBMIT' })).toBe(unknown)
  })

  it('unknown keeps waiting for the job and resolves either way', () => {
    expect(reduce(unknown, { type: 'ACCEPTED', jobId: J, txHash: TX })).toMatchObject({ s: 'submitted', jobId: J, txHash: TX })
    expect(reduce(unknown, { type: 'CONFIRMED', txHash: TX })).toMatchObject({ s: 'confirmed', txHash: TX })
    expect(reduce(unknown, { type: 'FAILED', error: reverted, txHash: TX })).toMatchObject({ s: 'failed', txHash: TX })
  })

  it('a job that fails for good keeps its tx hash', () => {
    const withTx: ActionState = { s: 'submitted', jobId: J, txHash: TX, draft }
    expect(reduce(withTx, { type: 'FAILED', error: reverted })).toMatchObject({ s: 'failed', error: reverted, txHash: TX })
  })

  it('a lost relay answer after signing is unknown and remembers the job', () => {
    const signed = reduce(signing, { type: 'SIGNED', jobId: J, relay: {} as never })
    expect(signed).toMatchObject({ s: 'signing', jobId: J })
    expect(reduce(signed, { type: 'ERROR', error: offline, jobId: J })).toMatchObject({ s: 'unknown', jobId: J })
  })

  it('updates for another job do not move a submitted action', () => {
    const other = `0x${'2'.repeat(64)}`
    expect(reduce(submitted, { type: 'ACCEPTED', jobId: other, txHash: TX })).toBe(submitted)
  })

  describe('retries', () => {
    const staleFailed = reduce(signing, { type: 'FAILED', error: stale })
    const downFailed = reduce(signing, { type: 'FAILED', error: relayDown })

    it('RESIGN is only legal when the error asks for a fresh signature', () => {
      expect(staleFailed).toMatchObject({ s: 'failed', draft, error: { retry: 'resign' } })
      expect(reduce(staleFailed, { type: 'RESIGN' })).toMatchObject({ s: 'signing', draft })
      expect(reduce(staleFailed, { type: 'RETRY' })).toBe(staleFailed)
      expect(reduce(downFailed, { type: 'RESIGN' })).toBe(downFailed)
    })

    it('RETRY is only legal when the same request may be sent again', () => {
      expect(reduce(downFailed, { type: 'RETRY' })).toMatchObject({ s: 'signing', draft })
    })

    it('SELF_GAS is only legal when it was offered', () => {
      expect(reduce(downFailed, { type: 'SELF_GAS' })).toBe(downFailed)
      const offered = reduce(signing, { type: 'FAILED', error: relayDown, offer: { kind: 'selfGas', estimateWei: 1n } })
      expect(reduce(offered, { type: 'SELF_GAS' })).toMatchObject({ s: 'signing', draft })
    })

    it('an attached job without a draft cannot be re-signed', () => {
      const attached = reduce(idle, { type: 'ATTACH', jobId: J })
      const failed = reduce(attached, { type: 'FAILED', error: stale })
      expect(failed.s).toBe('failed')
      expect(reduce(failed, { type: 'RESIGN' })).toBe(failed)
    })
  })

  describe('chain step', () => {
    it('WRONG_CHAIN turns the next tap into the switch step, and SUBMIT waits for it', () => {
      const needSwitch = reduce(confirm, { type: 'WRONG_CHAIN' })
      expect(needSwitch).toEqual({ s: 'confirm', draft, chain: 'switch' })
      expect(reduce(needSwitch, { type: 'SUBMIT' })).toBe(needSwitch)
      expect(reduce(needSwitch, { type: 'CHAIN_OK' })).toEqual({ s: 'confirm', draft })
    })

    it('a wrong chain found while signing goes back to the switch step', () => {
      expect(reduce(signing, { type: 'WRONG_CHAIN' })).toEqual({ s: 'confirm', draft, chain: 'switch' })
      const err = toUiError(new WrongChainError('0x1'))
      expect(reduce(signing, { type: 'FAILED', error: err })).toEqual({ s: 'confirm', draft, chain: 'switch' })
    })

    it('CHAIN_OK without a pending switch changes nothing', () => {
      expect(reduce(confirm, { type: 'CHAIN_OK' })).toBe(confirm)
    })
  })

  describe('resume and reset', () => {
    it('ATTACH follows a resumed job from idle; a lost one is unknown', () => {
      expect(reduce(idle, { type: 'ATTACH', jobId: J, txHash: TX })).toEqual({ s: 'submitted', jobId: J, txHash: TX })
      expect(reduce(idle, { type: 'ATTACH', jobId: J, lost: true })).toEqual({ s: 'unknown', jobId: J })
      expect(reduce(signing, { type: 'ATTACH', jobId: J })).toBe(signing)
    })

    it('RESET and DRAFT never abandon an action in flight', () => {
      for (const busy of [signing, submitted, unknown]) {
        expect(reduce(busy, { type: 'RESET' })).toBe(busy)
        expect(reduce(busy, { type: 'DRAFT', draft })).toBe(busy)
      }
    })

    it('RESET closes a finished action; DRAFT starts a new one', () => {
      const done = reduce(submitted, { type: 'CONFIRMED', txHash: TX })
      expect(reduce(done, { type: 'RESET' })).toEqual({ s: 'idle' })
      expect(reduce(done, { type: 'DRAFT', draft })).toEqual({ s: 'confirm', draft })
      const cancelled = reduce(signing, { type: 'FAILED', error: rejected })
      expect(reduce(cancelled, { type: 'DRAFT', draft })).toEqual({ s: 'confirm', draft })
      expect(reduce(idle, { type: 'RESET' })).toBe(idle)
    })

    it('flow events outside their states are ignored', () => {
      expect(reduce(idle, { type: 'CONFIRMED', txHash: TX })).toBe(idle)
      expect(reduce(confirm, { type: 'ACCEPTED', jobId: J })).toBe(confirm)
      expect(reduce(idle, { type: 'FAILED', error: stale })).toBe(idle)
    })
  })
})
