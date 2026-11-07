import { ASSETS, LIMITS, RELAY_ERROR_CODES, type AssetKey, type Job, type RelayErrorCode } from '@accrue/shared'
import { keccak256, type Address, type Hex } from 'viem'
import { fetchJson } from '../lib/api'
import { isRecord, nowSec, sleep } from '../lib/util'
import { HttpError, toUiError, type UiError } from '../providers/errors'
import { evm } from '../providers/evm'

// POST /api/relay body (Task 7). permitValue only for withdraw; amount 2^256-1 there means "everything".
export interface RelayBody {
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  owner: Address
  amount: string
  permitValue?: string
  deadline: string
  nonce: string
  signature: Hex
}

export type JobStatus = Job['status']

// POST /api/relay 202 and GET /api/relay/:jobId
export interface JobView {
  jobId: string
  status: JobStatus
  txHash?: Hex
  error?: RelayErrorCode
  detail?: Record<string, unknown>
}

// 'sent': signed and handed to the relay, with no answer yet
export type LocalStatus = 'sent' | JobStatus

export interface LocalJob {
  jobId: string
  owner: Address
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  amount: string
  createdAt: number
  status: LocalStatus
  // wallet: the user's own wallet sent it (self-paid fallback) and jobId is its tx hash
  via: 'relay' | 'wallet'
  txHash?: Hex
  error?: RelayErrorCode
  detail?: Record<string, unknown>
  // the signed permit's deadline (unix seconds) and nonce
  deadline?: number
  nonce?: string
  // kept until the job is final, so the very same signature can be sent again if the relay lost it
  body?: RelayBody
}

export type JobUpdate = { job: LocalJob } | { error: UiError }

export const JOBS_STORAGE_KEY = 'accrue.dollars.jobs.v1'

// graceSec: after the permit deadline, how long the relay gets to settle a job before the
// permit nonce on-chain decides it (the relay cancels or confirms within a minute of the deadline)
export const jobsConfig = { pollMs: 3_000, maxPollMs: 30_000, timeoutMs: 15_000, graceSec: 600 }

const MAX_RECORDS = 50
const STATUSES: readonly string[] = ['queued', 'submitted', 'confirmed', 'failed']
const LOCAL_STATUSES: readonly string[] = ['sent', ...STATUSES]

const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
const isRelayCode = (v: unknown): v is RelayErrorCode => typeof v === 'string' && (RELAY_ERROR_CODES as readonly string[]).includes(v)
const isAsset = (v: unknown): v is AssetKey => typeof v === 'string' && Object.hasOwn(ASSETS, v)
const key = (id: string) => id.toLowerCase()

export const isFinal = (s: LocalStatus) => s === 'confirmed' || s === 'failed'

const SIG_RE = /^0x[0-9a-fA-F]{130}$/

// some wallets return v as 0/1
const canonicalV = (v: number) => (v === 0 || v === 1 ? v + 27 : v)

// The worker's normalizeSignature, byte for byte: lowercase, v as 27/28.
export function normalizeSignature(sig: Hex): Hex {
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return String(sig).toLowerCase() as Hex
  const lower = sig.toLowerCase()
  const v = canonicalV(parseInt(lower.slice(130), 16))
  return `${lower.slice(0, 130)}${v.toString(16).padStart(2, '0')}` as Hex
}

// The relay's jobId for a signature.
export const jobIdOf = (signature: Hex): Hex => keccak256(normalizeSignature(signature))

// ---- relay API ----

// A 2xx without a readable job: the relay may have taken the request, so it counts as no answer.
export class UnreadableAnswer extends Error {
  constructor() {
    super('unreadable relay answer')
    this.name = 'UnreadableAnswer'
  }
}

const api = (path: string, init?: RequestInit) => fetchJson(path, init, jobsConfig.timeoutMs)

function parseView(b: unknown): JobView {
  if (!isRecord(b) || typeof b.jobId !== 'string' || typeof b.status !== 'string' || !STATUSES.includes(b.status)) {
    throw new UnreadableAnswer()
  }
  const view: JobView = { jobId: b.jobId, status: b.status as JobStatus }
  if (isHash(b.txHash)) view.txHash = b.txHash
  if (isRelayCode(b.error)) view.error = b.error
  if (isRecord(b.detail)) view.detail = b.detail
  return view
}

function parseJob(b: unknown): Job | null {
  try {
    const v = parseView(b)
    const r = b as Record<string, unknown>
    if (typeof r.owner !== 'string' || (r.kind !== 'supply' && r.kind !== 'withdraw') || !isAsset(r.asset)) return null
    if (typeof r.amount !== 'string' || typeof r.createdAt !== 'number') return null
    return { ...v, owner: r.owner as Address, kind: r.kind, asset: r.asset, amount: r.amount, createdAt: r.createdAt }
  } catch {
    return null
  }
}

export async function postRelay(body: RelayBody): Promise<JobView> {
  const res = await api('/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return parseView(res)
}

export async function getJob(jobId: string): Promise<JobView> {
  return parseView(await api(`/api/relay/${jobId}`))
}

export async function getJobsByOwner(owner: Address): Promise<Job[]> {
  const b = await api(`/api/relay/by-owner/${owner}`)
  if (!isRecord(b) || !Array.isArray(b.jobs)) throw new UnreadableAnswer()
  return b.jobs.map(parseJob).filter((j): j is Job => j !== null)
}

// No answer at all: the request may or may not have reached the relay.
export function isNoAnswer(e: unknown): boolean {
  if (e instanceof HttpError) return false
  if (e instanceof UnreadableAnswer) return true
  const code = toUiError(e).code
  return code === 'NETWORK' || code === 'TIMEOUT'
}

// The relay may have taken (and broadcast) the request without us getting its answer: no answer at all,
// or a 5xx that is not one of its own JSON errors (a Cloudflare 1102 after the relayer already sent).
export function mayHaveArrived(e: unknown): boolean {
  if (isNoAnswer(e)) return true
  return e instanceof HttpError && e.status >= 500 && !(isRecord(e.body) && typeof e.body.error === 'string')
}

// "Nonce already used" where the relay could not look up which tx used it.
export function isStaleUnchecked(e: unknown): boolean {
  if (!(e instanceof HttpError) || !isRecord(e.body) || e.body.error !== 'PERMIT_NONCE_STALE') return false
  return isRecord(e.body.detail) && e.body.detail.landedCheck === 'unavailable'
}

// Worth sending again with the same signature (the relay is idempotent on it): no answer, or a 5xx
// other than the gas limits, which do not clear within seconds.
export function isTransient(e: unknown): boolean {
  if (isNoAnswer(e)) return true
  if (!(e instanceof HttpError) || e.status < 500) return false
  const code = isRecord(e.body) ? e.body.error : undefined
  return code !== 'BUDGET_EXHAUSTED' && code !== 'RELAYER_LOW_GAS'
}

// ---- local store (best effort; the relay's by-owner list is the source of truth) ----

let records: Map<string, LocalJob> | null = null
const views = new Map<string, LocalJob[]>()
const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isLocalJob(r: unknown): r is LocalJob {
  return (
    isRecord(r) &&
    typeof r.jobId === 'string' &&
    typeof r.owner === 'string' &&
    (r.kind === 'supply' || r.kind === 'withdraw') &&
    isAsset(r.asset) &&
    typeof r.amount === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.status === 'string' &&
    LOCAL_STATUSES.includes(r.status) &&
    (r.via === 'relay' || r.via === 'wallet')
  )
}

function load(): Map<string, LocalJob> {
  if (records) return records
  records = new Map()
  try {
    const raw = storage()?.getItem(JOBS_STORAGE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(list)) for (const r of list) if (isLocalJob(r)) records.set(key(r.jobId), r)
  } catch {
    // unreadable storage starts empty; resume still gets every job from the relay
  }
  return records
}

function save(): void {
  const all = load()
  if (all.size > MAX_RECORDS) {
    const oldestSettledFirst = [...all.values()].sort(
      (a, b) => Number(isFinal(b.status)) - Number(isFinal(a.status)) || a.createdAt - b.createdAt,
    )
    for (const r of oldestSettledFirst.slice(0, all.size - MAX_RECORDS)) all.delete(key(r.jobId))
  }
  try {
    storage()?.setItem(JOBS_STORAGE_KEY, JSON.stringify([...all.values()]))
  } catch {
    // quota or privacy mode: memory keeps working for this session
  }
  views.clear()
  for (const l of [...listeners]) l()
}

export function subscribeJobs(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getLocal(jobId: string): LocalJob | undefined {
  return load().get(key(jobId))
}

// Newest first; the same array until something changes (useSyncExternalStore snapshot).
export function listJobs(owner: Address): LocalJob[] {
  const k = key(owner)
  let v = views.get(k)
  if (!v) {
    v = [...load().values()].filter(r => key(r.owner) === k).sort((a, b) => b.createdAt - a.createdAt)
    views.set(k, v)
  }
  return v
}

// An action on the same token that is not final yet. A new signature now would reuse its permit nonce.
export function unresolved(owner: Address, kind: LocalJob['kind'], asset: AssetKey): LocalJob | undefined {
  return listJobs(owner).find(r => r.kind === kind && r.asset === asset && !isFinal(r.status))
}

export function remember(job: LocalJob): void {
  load().set(key(job.jobId), job)
  save()
}

export function forget(jobId: string): void {
  if (load().delete(key(jobId))) save()
}

// Saves (and notifies) only when something changed; `replaces` is the id the record had before.
function store(next: LocalJob, replaces = next.jobId): LocalJob {
  const all = load()
  if (isFinal(next.status)) delete next.body
  const prev = all.get(key(next.jobId))
  if (key(replaces) === key(next.jobId) && prev && sameState(prev, next)) return prev
  all.delete(key(replaces))
  all.set(key(next.jobId), next)
  save()
  return next
}

const sameState = (a: LocalJob, b: LocalJob) =>
  a.status === b.status && a.txHash === b.txHash && a.error === b.error && JSON.stringify(a.detail) === JSON.stringify(b.detail) && a.body === b.body

function withView(base: LocalJob, view: JobView): LocalJob {
  const next: LocalJob = { ...base, jobId: view.jobId, status: view.status }
  if (view.txHash) next.txHash = view.txHash
  if (view.error) next.error = view.error
  if (view.detail) next.detail = view.detail
  return next
}

// Applies a relay answer to the record it belongs to.
export function acknowledge(base: LocalJob, view: JobView): LocalJob {
  return store(withView(base, view), base.jobId)
}

const canResend = (r: LocalJob, now: number) => !!r.body && r.deadline !== undefined && r.deadline - now >= LIMITS.deadlineMinSec
const pastGrace = (r: LocalJob) => r.deadline !== undefined && nowSec() >= r.deadline + jobsConfig.graceSec

const permitToken = (r: LocalJob) => (r.kind === 'supply' ? ASSETS[r.asset].address : ASSETS[r.asset].aToken)

// Whether the permit's nonce has been used on-chain; null when the record does not know its nonce.
async function nonceUsed(r: LocalJob): Promise<boolean | null> {
  const nonce = r.nonce ?? r.body?.nonce
  if (nonce === undefined) return null
  return (await evm.permitNonce(permitToken(r), r.owner)) > BigInt(nonce)
}

// The permit ran, but not through the tx this record followed, so its hash is not known.
export function resolveLanded(r: LocalJob): LocalJob {
  const next: LocalJob = { ...r, status: 'confirmed', detail: { landed: 'elsewhere' } }
  delete next.txHash
  delete next.error
  return store(next, r.jobId)
}

// Past its deadline the permit can no longer execute; once the relay has had time to settle,
// the token's nonce says whether it ran.
async function settleExpired(r: LocalJob): Promise<LocalJob | null> {
  const used = await nonceUsed(r)
  if (used === null) return null
  if (used) return resolveLanded(r)
  return store({ ...r, status: 'failed', error: 'DEADLINE_INVALID', detail: { reason: 'expired_unconfirmed' } })
}

function toJob(r: LocalJob): Job {
  const j: Job = {
    jobId: r.jobId,
    owner: r.owner,
    kind: r.kind,
    asset: r.asset,
    amount: r.amount,
    status: r.status === 'sent' ? 'queued' : r.status,
    createdAt: r.createdAt,
  }
  if (r.txHash) j.txHash = r.txHash
  if (r.error) j.error = r.error
  if (r.detail) j.detail = r.detail
  return j
}

// ---- tracking ----

interface Poller {
  listeners: Set<(u: JobUpdate) => void>
  done: Promise<LocalJob | undefined>
}

const pollers = new Map<string, Poller>()
let generation = 0

function refusal(r: LocalJob, e: HttpError): LocalJob {
  const b = isRecord(e.body) ? e.body : {}
  const next: LocalJob = { ...r, status: 'failed', error: isRelayCode(b.error) ? b.error : 'INTERNAL' }
  delete next.body
  if (isRecord(b.detail)) next.detail = b.detail
  else delete next.detail
  return next
}

async function checkRelay(r: LocalJob): Promise<LocalJob> {
  try {
    return acknowledge(r, await getJob(r.jobId))
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e
    // too close to the deadline to send again: keep asking until the grace period settles it
    if (!canResend(r, nowSec())) throw e
    // the relay lost it or never got it: the same signature again, which the relay treats idempotently
    try {
      return acknowledge(r, await postRelay(r.body!))
    } catch (e2) {
      if (!(e2 instanceof HttpError) || isTransient(e2)) throw e2
      // an earlier send of this very signature most likely used the nonce
      if (isStaleUnchecked(e2)) return resolveLanded(r)
      forget(r.jobId)
      return refusal(r, e2)
    }
  }
}

async function checkWallet(r: LocalJob): Promise<LocalJob> {
  const status = await evm.txStatus(r.jobId as Hex)
  if (status === null) return r
  if (status === 'success') return store({ ...r, status: 'confirmed' })
  // the relay may have landed the same permit first, which makes this tx revert on the spent allowance
  if (await nonceUsed(r)) return resolveLanded(r)
  return store({ ...r, status: 'failed', error: 'SIMULATION_FAILED', detail: { reason: 'reverted_onchain' } })
}

function startPoller(jobId: string): Poller {
  const gen = generation
  const listeners = new Set<(u: JobUpdate) => void>()
  const notify = (u: JobUpdate) => {
    for (const l of [...listeners]) l(u)
  }
  const done = (async (): Promise<LocalJob | undefined> => {
    let id = jobId
    let delay = jobsConfig.pollMs
    const backoff = () => (delay = Math.min(delay * 2, jobsConfig.maxPollMs))
    for (;;) {
      const r = getLocal(id)
      if (gen !== generation || !r) return r
      let next: LocalJob | undefined
      let failure: unknown
      try {
        next = r.via === 'wallet' ? await checkWallet(r) : await checkRelay(r)
      } catch (e) {
        failure = e
      }
      if (!(next && isFinal(next.status)) && pastGrace(next ?? r)) {
        try {
          next = (await settleExpired(next ?? r)) ?? next
        } catch (e) {
          // the nonce could not be read: try again next round
          failure ??= e
        }
      }
      if (gen !== generation) return getLocal(id)
      if (next) {
        id = next.jobId
        notify({ job: next })
        if (isFinal(next.status)) return next
        // no receipt yet: a dropped or replaced tx would otherwise be asked about every few seconds forever
        if (next === r && r.via === 'wallet') backoff()
        else delay = jobsConfig.pollMs
      } else {
        notify({ error: toUiError(failure) })
        backoff()
      }
      await sleep(delay)
    }
  })().finally(() => {
    if (pollers.get(key(jobId))?.done === done) pollers.delete(key(jobId))
  })
  return { listeners, done }
}

// Follows a job until it is final. One poller per job, however many screens listen.
// Resolves with the final record, or the current one when `signal` aborts (the job itself goes on).
export function track(jobId: string, onUpdate?: (u: JobUpdate) => void, signal?: AbortSignal): Promise<LocalJob | undefined> {
  const r = getLocal(jobId)
  if (!r) return Promise.resolve(undefined)
  if (isFinal(r.status)) {
    onUpdate?.({ job: r })
    return Promise.resolve(r)
  }
  let p = pollers.get(key(jobId))
  if (!p) {
    p = startPoller(jobId)
    pollers.set(key(jobId), p)
  }
  if (!onUpdate) return p.done
  const poller = p
  poller.listeners.add(onUpdate)
  return new Promise(resolve => {
    const finish = (rec: LocalJob | undefined) => {
      poller.listeners.delete(onUpdate)
      signal?.removeEventListener('abort', onAbort)
      resolve(rec)
    }
    const onAbort = () => finish(getLocal(jobId))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    void poller.done.then(finish, () => finish(getLocal(jobId)))
  })
}

// On reopen: the relay's by-owner list wins; local records fill in what it does not list
// (a signature whose POST never got an answer, a self-paid tx). Every unfinished job gets its poller back.
export async function resumePending(owner: Address): Promise<Job[]> {
  let server: Job[] | null
  try {
    server = await getJobsByOwner(owner)
  } catch {
    server = null
  }

  const listed = new Set<string>()
  for (const j of server ?? []) {
    listed.add(key(j.jobId))
    const prev = getLocal(j.jobId)
    const base: LocalJob = prev ?? {
      jobId: j.jobId,
      owner: j.owner,
      kind: j.kind,
      asset: j.asset,
      amount: j.amount,
      createdAt: j.createdAt,
      status: j.status,
      via: 'relay',
    }
    const view: JobView = { jobId: j.jobId, status: j.status }
    if (j.txHash) view.txHash = j.txHash
    if (j.error) view.error = j.error
    if (j.detail && isRecord(j.detail)) view.detail = j.detail
    store(withView(base, view))
  }

  const extra = listJobs(owner).filter(r => !listed.has(key(r.jobId)) && !isFinal(r.status))

  for (const r of listJobs(owner)) if (!isFinal(r.status)) void track(r.jobId)

  if (!server) return listJobs(owner).map(toJob)
  const fromServer = server.map(j => {
    const r = getLocal(j.jobId)
    return r ? toJob(r) : j
  })
  return [...fromServer, ...extra.map(toJob)].sort((a, b) => b.createdAt - a.createdAt)
}

// Stops every poller and drops the in-memory copy (the next read reloads from storage).
export function resetJobs(): void {
  generation += 1
  pollers.clear()
  records = null
  views.clear()
}
