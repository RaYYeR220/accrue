import { normalizeAddress, STAKING_CONTRACT, type AssetKey, type NimTx } from '@accrue/shared'
import { maxUint256 } from 'viem'
import type { LocalJob } from '../actions/jobs'
import type { Network } from '../features/nim/api'
import { isRecord } from '../lib/util'

export type NimKind = 'stake' | 'add' | 'switch' | 'deactivate' | 'retire' | 'remove'
export type ActivityKind = 'deposit' | 'withdraw' | NimKind
export type ActivityStatus = 'confirmed' | 'pending' | 'checking' | 'failed'

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

export function classifyNimTx(tx: NimTx, wallet: string): NimKind | null {
  if (same(tx.to, STAKING_CONTRACT) && same(tx.from, wallet)) return DATA_KIND[tx.recipientData.slice(0, 2).toLowerCase()] ?? null
  if (same(tx.from, STAKING_CONTRACT) && same(tx.to, wallet)) return 'remove'
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
  status: 'pending' | 'confirmed' | 'failed'
}

export type ChainTx = NimTx & { executionResult?: boolean }

function nimRow(e: { hash: string; kind: NimKind; luna: bigint | null; at: number; status: ActivityStatus }, network: Network): ActivityRow {
  const row: ActivityRow = { id: e.hash, chain: 'nimiq', kind: e.kind, amount: e.luna, at: e.at, status: e.status, url: nimTxUrl(e.hash, network) }
  if (e.status === 'failed') row.errorKey = 'nim.error.TX_FAILED'
  return row
}

// Set-active and update-staker carry no value; their amount is not what moved.
const valued = (k: NimKind) => k === 'stake' || k === 'add' || k === 'retire' || k === 'remove'

export function buildActivity(args: { jobs: LocalJob[]; nimLog: NimLogEntry[]; nimChain: ChainTx[]; wallet: string | null; network: Network }): ActivityRow[] {
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
        (e.status === 'pending' || e.status === 'confirmed' || e.status === 'failed'),
    )
  } catch {
    return []
  }
}

const subs = new Set<() => void>()
let cache: NimLogEntry[] | null = null

export function nimLog(wallet: string | null): NimLogEntry[] {
  cache ??= readLog()
  return wallet ? cache.filter(e => same(e.wallet, wallet)) : []
}

export function recordNimTx(entry: NimLogEntry): void {
  const next = [entry, ...readLog().filter(e => e.hash !== entry.hash)].slice(0, MAX_ENTRIES)
  cache = next
  try {
    localStorage.setItem(NIM_LOG_KEY, JSON.stringify(next))
  } catch {
    // the chain still lists it once the wallet is connected
  }
  for (const cb of [...subs]) cb()
}

export function subscribeNimLog(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}
