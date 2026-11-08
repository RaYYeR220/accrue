import { normalizeAddress, STAKING_CONTRACT, type AssetKey, type NimTx } from '@accrue/shared'
import { maxUint256 } from 'viem'
import type { LocalJob } from '../actions/jobs'
import type { Network } from '../features/nim/api'
import { isRecord } from '../lib/util'

export type NimKind = 'stake' | 'add' | 'switch' | 'deactivate' | 'retire' | 'remove'
export type ActivityKind = 'deposit' | 'withdraw' | NimKind
// unknown: a NIM transaction the chain never showed within the bound; the wallet has the answer
export type ActivityStatus = 'confirmed' | 'pending' | 'checking' | 'failed' | 'unknown'

export interface ActivityRow {
  id: string
  chain: 'polygon' | 'nimiq'
  kind: ActivityKind
  asset?: AssetKey
  // token units (6 decimals) or luna; null when there is no fixed amount (withdraw everything)
  amount: bigint | null
  at: number
  status: ActivityStatus
  url: string | null
  errorKey?: string
  elsewhere?: boolean
  selfPaid?: boolean
}

export const polygonTxUrl = (hash: string) => `https://polygonscan.com/tx/${hash}`
export const nimTxUrl = (hash: string, network: Network) => `${network === 'testnet' ? 'https://test.nimiq.watch' : 'https://nimiq.watch'}/#${hash}`

const JOB_STATUS: Record<LocalJob['status'], ActivityStatus> = {
  sent: 'checking',
  queued: 'pending',
  submitted: 'pending',
  confirmed: 'confirmed',
  failed: 'failed',
}

export function jobRow(j: LocalJob): ActivityRow {
  const amount = BigInt(j.amount)
  const row: ActivityRow = {
    id: j.jobId,
    chain: 'polygon',
    kind: j.kind === 'supply' ? 'deposit' : 'withdraw',
    asset: j.asset,
    amount: amount === maxUint256 ? null : amount,
    at: j.createdAt,
    status: JOB_STATUS[j.status],
    url: j.txHash ? polygonTxUrl(j.txHash) : null,
  }
  if (j.status === 'failed') row.errorKey = `error.${j.error ?? 'INTERNAL'}`
  if (j.detail?.landed === 'elsewhere') row.elsewhere = true
  if (j.via === 'wallet') row.selfPaid = true
  return row
}

// Albatross incoming staking data starts with its type: 5 create staker, 6 add stake,
// 7 update staker, 8 set active stake, 9 retire stake. Remove is the contract paying out.
const DATA_KIND: Record<string, NimKind> = { '05': 'stake', '06': 'add', '07': 'switch', '08': 'deactivate', '09': 'retire' }

const same = (a: string, b: string) => normalizeAddress(a) === normalizeAddress(b)

// own: the wallet, and the HTLC account a staking transaction may be funded from
export function classifyNimTx(tx: NimTx, own: string | readonly string[]): NimKind | null {
  const mine = (a: string) => (typeof own === 'string' ? [own] : own).some(o => same(a, o))
  if (same(tx.to, STAKING_CONTRACT) && mine(tx.from)) return DATA_KIND[tx.recipientData.slice(0, 2).toLowerCase()] ?? null
  if (same(tx.from, STAKING_CONTRACT) && mine(tx.to)) return 'remove'
  return null
}

// A staking transaction this app sent, kept on the phone until the chain shows it.
export interface NimLogEntry {
  hash: string
  wallet: string
  kind: NimKind
  luna: string
  pool?: string
  at: number
  status: 'pending' | 'confirmed' | 'failed' | 'unknown'
}

// How long a sent staking transaction may stay unseen before the app stops claiming it is on its way.
export const NIM_PENDING_MAX_MS = 30 * 60_000

// A pending entry, settled by looking the transaction up by hash (getTransactionByHash), for hosts
// whose address history does not list it.
export async function resolveNimEntry(
  e: NimLogEntry,
  lookup: (hash: string) => Promise<'confirmed' | 'failed' | 'pending'>,
  now: number,
): Promise<NimLogEntry['status']> {
  let found: 'confirmed' | 'failed' | 'pending'
  try {
    found = await lookup(e.hash)
  } catch {
    found = 'pending'
  }
  if (found !== 'pending') return found
  return now - e.at > NIM_PENDING_MAX_MS ? 'unknown' : 'pending'
}

// What a finished dollar sheet reports: its own draft, or the job it was following.
export function settledAmount(
  draft: { kind: 'supply' | 'withdraw'; asset: AssetKey; amount: bigint | 'all' } | undefined,
  job: LocalJob | undefined,
): { kind: 'supply' | 'withdraw'; asset: AssetKey; amount: bigint | 'all' } | null {
  if (draft) return { kind: draft.kind, asset: draft.asset, amount: draft.amount }
  if (!job) return null
  const amount = BigInt(job.amount)
  return { kind: job.kind, asset: job.asset, amount: amount === maxUint256 ? 'all' : amount }
}

export type ChainTx = NimTx & { executionResult?: boolean }

function nimRow(e: { hash: string; kind: NimKind; luna: bigint | null; at: number; status: ActivityStatus }, network: Network): ActivityRow {
  const row: ActivityRow = { id: e.hash, chain: 'nimiq', kind: e.kind, amount: e.luna, at: e.at, status: e.status, url: nimTxUrl(e.hash, network) }
  if (e.status === 'failed') row.errorKey = 'nim.error.TX_FAILED'
  if (e.status === 'unknown') row.errorKey = 'act.unknownNote'
  return row
}

// Set-active and update-staker carry no value; their amount is not what moved.
const valued = (k: NimKind) => k === 'stake' || k === 'add' || k === 'retire' || k === 'remove'

export function buildActivity(args: { jobs: LocalJob[]; nimLog: NimLogEntry[]; nimChain: ChainTx[]; wallet: string | readonly string[] | null; network: Network }): ActivityRow[] {
  const { jobs, nimLog, nimChain, wallet, network } = args
  const rows = jobs.map(jobRow)
  const seen = new Set<string>()
  for (const tx of nimChain) {
    const kind = wallet ? classifyNimTx(tx, wallet) : null
    if (!kind) continue
    seen.add(tx.hash)
    const logged = nimLog.find(e => e.hash === tx.hash)
    const luna = logged ? BigInt(logged.luna) : valued(kind) ? BigInt(tx.value) : null
    const status: ActivityStatus = tx.executionResult === false ? 'failed' : 'confirmed'
    rows.push(nimRow({ hash: tx.hash, kind, luna, at: logged?.at ?? tx.timestamp, status }, network))
  }
  for (const e of nimLog) {
    if (seen.has(e.hash)) continue
    rows.push(nimRow({ hash: e.hash, kind: e.kind, luna: BigInt(e.luna), at: e.at, status: e.status }, network))
  }
  return rows.sort((a, b) => b.at - a.at)
}

// ---- the local NIM log ----

export const NIM_LOG_KEY = 'accrue.nim.txs.v1'
const KINDS: readonly string[] = ['stake', 'add', 'switch', 'deactivate', 'retire', 'remove']
const MAX_ENTRIES = 50

function readLog(): NimLogEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(NIM_LOG_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is NimLogEntry =>
        isRecord(e) &&
        typeof e.hash === 'string' &&
        typeof e.wallet === 'string' &&
        typeof e.kind === 'string' &&
        KINDS.includes(e.kind) &&
        typeof e.luna === 'string' &&
        /^\d+$/.test(e.luna) &&
        typeof e.at === 'number' &&
        (e.status === 'pending' || e.status === 'confirmed' || e.status === 'failed' || e.status === 'unknown'),
    )
  } catch {
    return []
  }
}

const subs = new Set<() => void>()
let cache: NimLogEntry[] | null = null
// one stable array per wallet until the log changes (useSyncExternalStore snapshots)
const views = new Map<string, NimLogEntry[]>()
const NONE: NimLogEntry[] = []

export function nimLog(wallet: string | null): NimLogEntry[] {
  if (!wallet) return NONE
  const k = normalizeAddress(wallet)
  let v = views.get(k)
  if (!v) {
    cache ??= readLog()
    v = cache.filter(e => same(e.wallet, wallet))
    views.set(k, v)
  }
  return v
}

export function recordNimTx(entry: NimLogEntry): void {
  const next = [entry, ...readLog().filter(e => e.hash !== entry.hash)].slice(0, MAX_ENTRIES)
  cache = next
  views.clear()
  try {
    localStorage.setItem(NIM_LOG_KEY, JSON.stringify(next))
  } catch {
    // the chain still lists it once the wallet is connected
  }
  for (const cb of [...subs]) cb()
}

export function updateNimTx(hash: string, status: NimLogEntry['status']): void {
  const e = readLog().find(x => x.hash === hash)
  if (e && e.status !== status) recordNimTx({ ...e, status })
}

export function subscribeNimLog(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}
