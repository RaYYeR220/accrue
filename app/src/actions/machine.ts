import type { AssetKey } from '@accrue/shared'
import type { Hex } from 'viem'
import type { UiError } from '../providers/errors'
import type { RelayBody } from './jobs'

export type Draft =
  | { kind: 'supply'; asset: AssetKey; amount: bigint }
  | { kind: 'withdraw'; asset: AssetKey; amount: bigint | 'all' }

// What a failed action can offer instead of a plain retry.
export type Offer =
  | { kind: 'selfGas'; estimateWei: bigint }
  | { kind: 'withdrawAvailable'; amount: bigint }

export type ActionState =
  | { s: 'idle' }
  // chain 'switch': the next tap is the separate "Switch to Polygon" step, not the signature
  | { s: 'confirm'; draft: Draft; chain?: 'switch' }
  | { s: 'signing'; draft: Draft; jobId?: string }
  | { s: 'submitted'; jobId: string; txHash?: Hex; draft?: Draft }
  | { s: 'confirmed'; txHash: Hex; jobId?: string; draft?: Draft }
  | { s: 'failed'; error: UiError; txHash?: Hex; jobId?: string; draft?: Draft; offer?: Offer }
  | { s: 'cancelled'; draft?: Draft }
  // the job may still land: keeps polling, and nothing new is sent until it resolves
  | { s: 'unknown'; jobId?: string; draft?: Draft }

// Taps. Each one is applied only when the current state allows it, so a double tap is a no-op.
export type UserEvent =
  | { type: 'DRAFT'; draft: Draft }
  | { type: 'SUBMIT' }
  | { type: 'CHAIN_OK' }
  | { type: 'RESIGN' }
  | { type: 'RETRY' }
  | { type: 'SELF_GAS' }
  | { type: 'RESET' }

// What the flows report.
export type FlowEvent =
  | { type: 'WRONG_CHAIN' }
  | { type: 'SIGNED'; jobId: string; relay: RelayBody }
  | { type: 'ACCEPTED'; jobId: string; txHash?: Hex }
  | { type: 'CONFIRMED'; txHash: Hex; jobId?: string }
  // the wallet or the relay said no, or the job failed for good
  | { type: 'FAILED'; error: UiError; txHash?: Hex; jobId?: string; offer?: Offer }
  // no answer: whether the job exists or lands is not known yet
  | { type: 'ERROR'; error: UiError; jobId?: string }
  // a job found on resume
  | { type: 'ATTACH'; jobId: string; txHash?: Hex; lost?: boolean }

export type ActionEvent = UserEvent | FlowEvent

type Of<S extends ActionState['s']> = Extract<ActionState, { s: S }>

const settled = (st: ActionState): st is Of<'idle' | 'confirm' | 'failed' | 'cancelled' | 'confirmed'> =>
  st.s === 'idle' || st.s === 'confirm' || st.s === 'failed' || st.s === 'cancelled' || st.s === 'confirmed'

const inFlight = (st: ActionState): st is Of<'submitted' | 'unknown'> => st.s === 'submitted' || st.s === 'unknown'

// A lost connection says nothing about the job, so it never fails one that may still land.
const isTransport = (e: UiError) => e.code === 'NETWORK' || e.code === 'TIMEOUT'

function withDraft<T extends object>(o: T, draft: Draft | undefined): T & { draft?: Draft } {
  return draft ? { ...o, draft } : o
}

function sameJob(st: Of<'submitted' | 'unknown'>, jobId: string): boolean {
  return st.jobId === undefined || st.jobId.toLowerCase() === jobId.toLowerCase()
}

function failed(
  ev: Extract<FlowEvent, { type: 'FAILED' }>,
  draft: Draft | undefined,
  txHash: Hex | undefined,
  jobId: string | undefined,
): ActionState {
  const out: Of<'failed'> = { s: 'failed', error: ev.error }
  const tx = ev.txHash ?? txHash
  const id = ev.jobId ?? jobId
  if (tx) out.txHash = tx
  if (id) out.jobId = id
  if (ev.offer) out.offer = ev.offer
  return withDraft(out, draft)
}

// Illegal transitions return the very same state object.
export function reduce(st: ActionState, ev: ActionEvent): ActionState {
  switch (ev.type) {
    case 'DRAFT':
      return settled(st) ? { s: 'confirm', draft: ev.draft } : st

    case 'RESET':
      return settled(st) && st.s !== 'idle' ? { s: 'idle' } : st

    case 'WRONG_CHAIN':
      return st.s === 'confirm' || st.s === 'signing' ? { s: 'confirm', draft: st.draft, chain: 'switch' } : st

    case 'CHAIN_OK':
      return st.s === 'confirm' && st.chain ? { s: 'confirm', draft: st.draft } : st

    case 'SUBMIT':
      return st.s === 'confirm' && !st.chain ? { s: 'signing', draft: st.draft } : st

    case 'RESIGN':
      return st.s === 'failed' && st.draft && st.error.retry === 'resign' ? { s: 'signing', draft: st.draft } : st

    case 'RETRY':
      return st.s === 'failed' && st.draft && st.error.retry === 'same' ? { s: 'signing', draft: st.draft } : st

    case 'SELF_GAS':
      return st.s === 'failed' && st.draft && st.offer?.kind === 'selfGas' ? { s: 'signing', draft: st.draft } : st

    case 'SIGNED':
      return st.s === 'signing' ? { ...st, jobId: ev.jobId } : st

    case 'ACCEPTED': {
      if (st.s === 'signing') {
        return withDraft({ s: 'submitted', jobId: ev.jobId, ...(ev.txHash ? { txHash: ev.txHash } : {}) }, st.draft)
      }
      if (!inFlight(st) || !sameJob(st, ev.jobId)) return st
      const txHash = ev.txHash ?? (st.s === 'submitted' ? st.txHash : undefined)
      if (st.s === 'submitted' && st.txHash === txHash) return st
      return withDraft({ s: 'submitted', jobId: ev.jobId, ...(txHash ? { txHash } : {}) }, st.draft)
    }

    case 'CONFIRMED': {
      if (st.s !== 'signing' && !inFlight(st)) return st
      if (inFlight(st) && ev.jobId && !sameJob(st, ev.jobId)) return st
      const jobId = ev.jobId ?? st.jobId
      return withDraft({ s: 'confirmed', txHash: ev.txHash, ...(jobId ? { jobId } : {}) }, st.draft)
    }

    case 'FAILED': {
      if (st.s === 'signing') {
        if (ev.error.code === 'USER_REJECTED') return { s: 'cancelled', draft: st.draft }
        if (ev.error.code === 'WRONG_CHAIN') return { s: 'confirm', draft: st.draft, chain: 'switch' }
        return failed(ev, st.draft, undefined, st.jobId)
      }
      if (!inFlight(st)) return st
      if (ev.jobId && !sameJob(st, ev.jobId)) return st
      if (isTransport(ev.error)) return st.s === 'unknown' ? st : withDraft({ s: 'unknown', jobId: st.jobId }, st.draft)
      return failed(ev, st.draft, st.s === 'submitted' ? st.txHash : undefined, st.jobId)
    }

    case 'ERROR': {
      if (st.s === 'signing') {
        const jobId = ev.jobId ?? st.jobId
        return withDraft({ s: 'unknown', ...(jobId ? { jobId } : {}) }, st.draft)
      }
      if (st.s === 'submitted' && (!ev.jobId || sameJob(st, ev.jobId))) return withDraft({ s: 'unknown', jobId: st.jobId }, st.draft)
      return st
    }

    case 'ATTACH': {
      if (!settled(st) || st.s === 'confirm') return st
      if (ev.lost) return { s: 'unknown', jobId: ev.jobId }
      return { s: 'submitted', jobId: ev.jobId, ...(ev.txHash ? { txHash: ev.txHash } : {}) }
    }
  }
}
