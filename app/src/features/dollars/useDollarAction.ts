import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getLocal, isFinal, type RelayBody } from '../../actions/jobs'
import { reduce, type ActionEvent, type ActionState, type Draft, type FlowEvent, type UserEvent } from '../../actions/machine'
import { toUiError, type UiError } from '../../providers/errors'
import { evm } from '../../providers/evm'
import { deposit } from './deposit'
import { follow, type FlowOpts } from './flow'
import { withdraw } from './withdraw'

export interface DollarAction {
  getState(): ActionState
  subscribe(cb: () => void): () => void
  // taps; each runs only if the machine accepts it, so double taps never send twice
  dispatch(ev: UserEvent): void
  // the separate "Switch to Polygon" tap; null when done or when the same button is needed once more
  switchChain(): Promise<UiError | null>
  // follow a job found by resumePending
  attach(jobId: string): void
  dispose(): void
}

// One deposit/withdraw sheet: the state machine plus the flows it starts.
export function createDollarAction(): DollarAction {
  let state: ActionState = { s: 'idle' }
  // the last signed permit, for re-sending the same signature (RETRY) or paying the fee yourself (SELF_GAS)
  let signed: RelayBody | null = null
  let run: AbortController | null = null
  let draftSeq = 0
  let switching: Promise<UiError | null> | null = null
  const subs = new Set<() => void>()

  function apply(ev: ActionEvent): boolean {
    const next = reduce(state, ev)
    if (next === state) return false
    state = next
    for (const cb of [...subs]) cb()
    return true
  }

  // a new run silences the previous one; its job, if any, carries on in the job store
  function begin(): { signal: AbortSignal; emit: (ev: FlowEvent) => void } {
    run?.abort()
    const ctl = new AbortController()
    run = ctl
    return {
      signal: ctl.signal,
      emit: ev => {
        if (ctl.signal.aborted) return
        if (ev.type === 'SIGNED') signed = ev.relay
        apply(ev)
      },
    }
  }

  function start(draft: Draft, opts: Omit<FlowOpts, 'signal'>): void {
    const { signal, emit } = begin()
    const flow =
      draft.kind === 'supply'
        ? deposit(draft.asset, draft.amount, { ...opts, signal }, emit)
        : withdraw(draft.asset, draft.amount, { ...opts, signal }, emit)
    flow.catch((e: unknown) => emit({ type: 'FAILED', error: toUiError(e) }))
  }

  // Reading the chain opens no dialog; it decides whether the first button is the switch step.
  async function checkChain(seq: number): Promise<void> {
    try {
      const onPolygon = await evm.isPolygon()
      if (!onPolygon && seq === draftSeq && state.s === 'confirm') apply({ type: 'WRONG_CHAIN' })
    } catch {
      // no wallet: the flow reports it when the user taps
    }
  }

  return {
    getState: () => state,

    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },

    dispatch(ev) {
      if (!apply(ev)) return
      const st = state
      switch (ev.type) {
        case 'DRAFT':
          signed = null
          void checkChain(++draftSeq)
          return
        case 'SUBMIT':
        case 'RESIGN':
          signed = null
          if (st.s === 'signing') start(st.draft, {})
          return
        case 'RETRY':
          if (st.s === 'signing') start(st.draft, signed ? { reuse: signed } : {})
          return
        case 'SELF_GAS':
          if (st.s === 'signing') start(st.draft, signed ? { reuse: signed, selfGas: true } : { selfGas: true })
          return
        case 'RESET':
          run?.abort()
          run = null
          signed = null
          return
        case 'CHAIN_OK':
          return
      }
    },

    switchChain() {
      if (state.s !== 'confirm' || !state.chain) return Promise.resolve(null)
      switching ??= (async () => {
        try {
          await evm.ensurePolygon()
          apply({ type: 'CHAIN_OK' })
          return null
        } catch (e) {
          const err = toUiError(e)
          // Polygon was only added: the same button switches on the next tap
          return err.code === 'WRONG_CHAIN' ? null : err
        } finally {
          switching = null
        }
      })()
      return switching
    },

    attach(jobId) {
      const job = getLocal(jobId)
      if (!job || isFinal(job.status)) return
      const ev: ActionEvent =
        job.status === 'sent' ? { type: 'ATTACH', jobId, lost: true } : { type: 'ATTACH', jobId, ...(job.txHash ? { txHash: job.txHash } : {}) }
      if (!apply(ev)) return
      const { signal, emit } = begin()
      void follow(jobId, emit, signal)
    },

    dispose() {
      run?.abort()
    },
  }
}

export function useDollarAction() {
  const [action] = useState(createDollarAction)
  const state = useSyncExternalStore(action.subscribe, action.getState, action.getState)
  const queryClient = useQueryClient()
  useEffect(() => () => action.dispose(), [action])
  useEffect(() => {
    // balances moved; a stale nonce may also mean the permit already landed through someone else
    const moved = state.s === 'confirmed' || (state.s === 'failed' && state.error.code === 'PERMIT_NONCE_STALE')
    if (moved) void queryClient.invalidateQueries({ queryKey: ['position'] })
  }, [state, queryClient])
  return { state, dispatch: action.dispatch, switchChain: action.switchChain, attach: action.attach }
}
