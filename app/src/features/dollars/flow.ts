import { ASSETS, buildPermit, LIMITS, POLYGON, type AssetKey } from '@accrue/shared'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import {
  acknowledge,
  forget,
  getLocal,
  isStaleUnchecked,
  isTransient,
  jobIdOf,
  mayHaveArrived,
  normalizeSignature,
  postRelay,
  remember,
  resolveLanded,
  resumePending,
  track,
  unresolved,
  type LocalJob,
  type RelayBody,
} from '../../actions/jobs'
import type { FlowEvent, Offer } from '../../actions/machine'
import { nowSec, sleep } from '../../lib/util'
import { HttpError, toUiError, type Retry, type UiError, type UiErrorCode } from '../../providers/errors'
import { evm } from '../../providers/evm'

export const flowConfig = {
  // null until the router is deployed; nothing can be signed without it, since it is the permit's spender
  router: POLYGON.router as Address | null,
  // inside the relay's 60 s … 60 min window, with room for re-sends or paying the fee yourself
  deadlineSec: 20 * 60,
  // pauses before re-sending the same signature after a 5xx or a lost answer
  retryDelaysMs: [1_500, 4_000] as number[],
  // above the ~312k gas a router call used on the Polygon fork, so the offer is not made when POL is short
  selfGasLimit: 400_000n,
  // wallets reserve gasLimit × maxFeePerGas, which runs well above the current gas price
  selfGasPriceMargin: 2n,
}

export const ROUTER_ABI = parseAbi([
  'function supplyWithPermit(address asset, address owner, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function withdrawWithPermit(address asset, address owner, uint256 amount, uint256 permitValue, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)',
])

export type Emit = (ev: FlowEvent) => void

export interface FlowOpts {
  // send `reuse` from the user's own wallet instead of the relay (needs `reuse`)
  selfGas?: boolean
  // an already signed permit: re-sent as is, never re-signed
  reuse?: RelayBody
  // stops reporting to this caller; a job already handed over keeps going
  signal?: AbortSignal
}

export interface FlowSpec {
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  // checks that need no reads, so a bad amount never costs a wallet call
  precheck(): UiError | null
  // the values to sign for this balance, or why not
  values(balance: bigint): { amount: bigint; permitValue: bigint } | UiError
}

export function uiError(code: UiErrorCode, retry: Retry, messageKey = `error.${code}`, detail?: Record<string, unknown>): UiError {
  return detail ? { code, retry, messageKey, detail } : { code, retry, messageKey }
}

const isError = (v: unknown): v is UiError => typeof v === 'object' && v !== null && 'code' in v

const SELF_GAS_CODES: readonly UiErrorCode[] = ['RELAYER_LOW_GAS', 'BUDGET_EXHAUSTED', 'RPC_UNAVAILABLE']

// owner:kind:asset while a signature is being collected, so two sheets cannot sign the same nonce
const signing = new Set<string>()

const pendingError = (jobId?: string) => uiError('PENDING', 'none', 'dollars.error.pending', jobId ? { jobId } : undefined)
const expiredError = () => toUiError({ error: 'DEADLINE_INVALID', detail: { reason: 'expired' } })

function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const h = normalizeSignature(sig)
  return { v: parseInt(h.slice(130, 132), 16), r: `0x${h.slice(2, 66)}`, s: `0x${h.slice(66, 130)}` }
}

export function routerCalldata(body: RelayBody): Hex {
  const { v, r, s } = splitSignature(body.signature)
  const asset = ASSETS[body.asset].address
  const amount = BigInt(body.amount)
  const deadline = BigInt(body.deadline)
  return body.kind === 'supply'
    ? encodeFunctionData({ abi: ROUTER_ABI, functionName: 'supplyWithPermit', args: [asset, body.owner, amount, deadline, v, r, s] })
    : encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'withdrawWithPermit',
        args: [asset, body.owner, amount, BigInt(body.permitValue ?? body.amount), deadline, v, r, s],
      })
}

// A relay job that failed for good: re-sending the same signature would only find this job again.
function jobFailure(job: LocalJob): UiError {
  const e = toUiError(job.detail ? { error: job.error ?? 'INTERNAL', detail: job.detail } : { error: job.error ?? 'INTERNAL' })
  return job.via === 'relay' && e.retry === 'same' ? { ...e, retry: 'resign' } : e
}

export function report(job: LocalJob, out: Emit): void {
  const tx = job.txHash ? { txHash: job.txHash } : {}
  switch (job.status) {
    case 'sent':
      return
    case 'queued':
    case 'submitted':
      return out({ type: 'ACCEPTED', jobId: job.jobId, ...tx })
    case 'confirmed':
      return out({ type: 'CONFIRMED', jobId: job.jobId, ...tx, ...(job.detail?.landed === 'elsewhere' ? { elsewhere: true } : {}) })
    case 'failed':
      return out({ type: 'FAILED', error: jobFailure(job), jobId: job.jobId, ...tx })
  }
}

// Reports every update of a job until it is final (or `signal` aborts).
export async function follow(jobId: string, out: Emit, signal?: AbortSignal): Promise<void> {
  let current = jobId
  await track(
    jobId,
    u => {
      if ('error' in u) return out({ type: 'ERROR', error: u.error, jobId: current })
      current = u.job.jobId
      report(u.job, out)
    },
    signal,
  )
}

function refine(e: UiError): UiError {
  const reason = e.detail?.reason
  // FiatToken's permit rejects owners with code (EIP-7702 wallets): a new signature cannot help
  if (e.code === 'BAD_SIGNATURE' && reason === 'owner_has_code') return { ...e, retry: 'none', messageKey: 'dollars.error.ownerHasCode' }
  // another signature over this nonce is already in flight: wait for it rather than sign a third
  if (e.code === 'PERMIT_NONCE_STALE' && reason === 'in_flight') return pendingError(typeof e.detail?.jobId === 'string' ? e.detail.jobId : undefined)
  return e
}

async function offerFor(err: unknown, e: UiError, owner: Address): Promise<Offer | undefined> {
  if (e.code === 'AAVE_LIQUIDITY') {
    const raw = e.detail?.available
    const amount = typeof raw === 'string' && /^\d{1,78}$/.test(raw) ? BigInt(raw) : 0n
    return amount > 0n ? { kind: 'withdrawAvailable', amount } : undefined
  }
  const relayCannotPay = SELF_GAS_CODES.includes(e.code) || (err instanceof HttpError && err.status >= 500)
  if (!relayCannotPay || !flowConfig.router) return undefined
  try {
    const [pol, price] = await Promise.all([evm.polBalance(owner), evm.gasPrice()])
    const estimateWei = flowConfig.selfGasLimit * price * flowConfig.selfGasPriceMargin
    return pol > estimateWei ? { kind: 'selfGas', estimateWei } : undefined
  } catch {
    return undefined
  }
}

// POST with the same signature until the relay answers for real. Never re-signs.
// `sentBefore`: this exact signature was POSTed on an earlier tap.
async function relay(body: RelayBody, out: Emit, signal?: AbortSignal, sentBefore = false): Promise<void> {
  const localId = jobIdOf(body.signature)
  const known = getLocal(localId)
  // the relay already has this exact signature: follow that job, never submit it twice
  if (known && known.status !== 'sent') {
    report(known, out)
    return follow(known.jobId, out, signal)
  }
  if (Number(body.deadline) - nowSec() < LIMITS.deadlineMinSec) {
    forget(localId)
    return out({ type: 'FAILED', error: expiredError() })
  }

  // stored before the POST, so an app killed mid-request can still find and resume it
  const record: LocalJob = {
    jobId: localId,
    owner: body.owner,
    kind: body.kind,
    asset: body.asset,
    amount: body.amount,
    createdAt: known?.createdAt ?? Date.now(),
    status: 'sent',
    via: 'relay',
    deadline: Number(body.deadline),
    nonce: body.nonce,
    body,
  }
  remember(record)

  let err: unknown
  let attempts = 0
  // any attempt that may have reached the relay unanswered makes the whole send uncertain,
  // whatever the later attempts say: the first one may already have broadcast
  let unsure = false
  for (;;) {
    attempts += 1
    try {
      const job = acknowledge(getLocal(localId) ?? record, await postRelay(body))
      report(job, out)
      return follow(job.jobId, out, signal)
    } catch (e) {
      err = e
      unsure ||= mayHaveArrived(e)
      if (!isTransient(e) || attempts > flowConfig.retryDelaysMs.length) break
    }
    await sleep(flowConfig.retryDelaysMs[attempts - 1] ?? 0)
    if (signal?.aborted) return
  }

  if (unsure) {
    // the record stays: the poller asks for the job by id, and sends the same signature again if it is unknown
    out({ type: 'ERROR', error: toUiError(err), jobId: localId })
    return follow(localId, out, signal)
  }

  // this signature went out before and its nonce is now used by a tx the relay could not identify:
  // most likely that earlier send, so signing a new permit could deposit twice
  if ((sentBefore || attempts > 1) && isStaleUnchecked(err)) return report(resolveLanded(getLocal(localId) ?? record), out)

  // a real answer saying no: this signature never became a job
  forget(localId)
  const error = refine(toUiError(err))
  if (error.code === 'PENDING') void resumePending(body.owner)
  const offer = await offerFor(err, error, body.owner)
  out({ type: 'FAILED', error, ...(offer ? { offer } : {}) })
}

// The agreed fallback: the same permit, sent to the router by the user's wallet, which pays the gas.
async function selfSend(body: RelayBody, out: Emit, signal?: AbortSignal): Promise<void> {
  const router = flowConfig.router
  if (!router) return out({ type: 'FAILED', error: uiError('INTERNAL', 'none', 'dollars.error.notDeployed') })
  if (Number(body.deadline) - nowSec() < LIMITS.deadlineMinSec) return out({ type: 'FAILED', error: expiredError() })
  const hash = await evm.sendTx({ from: body.owner, to: router, data: routerCalldata(body) })
  remember({
    jobId: hash,
    owner: body.owner,
    kind: body.kind,
    asset: body.asset,
    amount: body.amount,
    createdAt: Date.now(),
    status: 'submitted',
    via: 'wallet',
    txHash: hash,
    deadline: Number(body.deadline),
    nonce: body.nonce,
  })
  out({ type: 'ACCEPTED', jobId: hash, txHash: hash })
  await follow(hash, out, signal)
}

async function sign(spec: FlowSpec, router: Address, owner: Address, out: Emit): Promise<RelayBody | null> {
  if (!(await evm.isPolygon())) {
    out({ type: 'WRONG_CHAIN' })
    return null
  }
  const a = ASSETS[spec.asset]
  const supply = spec.kind === 'supply'
  const [nonce, balance] = await Promise.all([
    evm.permitNonce(supply ? a.address : a.aToken, owner),
    evm.tokenBalance(supply ? spec.asset : a.aToken, owner),
  ])
  const values = spec.values(balance)
  if (isError(values)) {
    out({ type: 'FAILED', error: values })
    return null
  }
  const deadline = BigInt(nowSec() + flowConfig.deadlineSec)
  const permit = buildPermit({
    token: supply ? 'asset' : 'aToken',
    asset: spec.asset,
    owner,
    spender: router,
    value: values.permitValue,
    nonce,
    deadline,
  })
  const signature = await evm.signPermit(permit)
  return {
    kind: spec.kind,
    asset: spec.asset,
    owner,
    amount: values.amount.toString(),
    ...(supply ? {} : { permitValue: values.permitValue.toString() }),
    deadline: deadline.toString(),
    nonce: nonce.toString(),
    signature,
  }
}

async function signAndRelay(spec: FlowSpec, out: Emit, signal?: AbortSignal): Promise<void> {
  const router = flowConfig.router
  if (!router) return out({ type: 'FAILED', error: uiError('INTERNAL', 'none', 'dollars.error.notDeployed') })
  // connecting is its own tap (it opens a dialog), never chained in front of the signature
  const owner = evm.address()
  if (!owner) return out({ type: 'FAILED', error: uiError('PROVIDER_MISSING', 'none', 'dollars.error.connectFirst') })
  const early = spec.precheck()
  if (early) return out({ type: 'FAILED', error: early })

  const lock = `${owner.toLowerCase()}:${spec.kind}:${spec.asset}`
  const pending = unresolved(owner, spec.kind, spec.asset)
  if (pending || signing.has(lock)) return out({ type: 'FAILED', error: pendingError(pending?.jobId) })
  signing.add(lock)
  let body: RelayBody | null
  try {
    body = await sign(spec, router, owner, out)
  } finally {
    signing.delete(lock)
  }
  if (!body) return
  out({ type: 'SIGNED', jobId: jobIdOf(body.signature), relay: body })
  await relay(body, out, signal)
}

// One action from tap to final job state. Reports through `emit`; resolves once the job is final,
// the action ended before reaching the relay, or `opts.signal` aborted.
export async function runFlow(spec: FlowSpec, opts: FlowOpts, emit: Emit): Promise<void> {
  const out: Emit = ev => {
    if (!opts.signal?.aborted) emit(ev)
  }
  try {
    if (opts.selfGas && !opts.reuse) throw new Error('self-gas needs an already signed permit')
    if (opts.reuse) await (opts.selfGas ? selfSend(opts.reuse, out, opts.signal) : relay(opts.reuse, out, opts.signal, true))
    else await signAndRelay(spec, out, opts.signal)
  } catch (e) {
    out({ type: 'FAILED', error: toUiError(e) })
  }
}
