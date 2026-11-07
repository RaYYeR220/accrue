import type { Address, Hex } from 'viem'
import type { AssetKey, RelayErrorCode } from '@accrue/shared'
import type { Detail } from './errors'
import type { ParsedRelay } from './validate'

export type JobStatus = 'queued' | 'submitted' | 'confirmed' | 'failed'

export interface JobRow {
  id: string
  owner: string
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  amount: string
  status: JobStatus
  tx_hash: string | null
  nonce: number | null
  error: string | null
  detail: string | null
  created_at: number
}

/** What the Worker hands the Durable Object once a relay has passed every stateless check. Strings only. */
export interface SubmitRequest {
  jobId: Hex
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  owner: Address
  amount: string
  permitValue: string
  deadline: string
  nonce: string
  v: 27 | 28
  r: Hex
  s: Hex
}

export const toSubmit = (jobId: Hex, p: ParsedRelay): SubmitRequest => ({
  jobId,
  kind: p.kind,
  asset: p.asset,
  owner: p.owner,
  amount: p.amount.toString(),
  permitValue: p.permitValue.toString(),
  deadline: p.deadline.toString(),
  nonce: p.nonce.toString(),
  v: p.v,
  r: p.r,
  s: p.s,
})

export const fromSubmit = (q: SubmitRequest): ParsedRelay => ({
  kind: q.kind,
  asset: q.asset,
  owner: q.owner,
  amount: BigInt(q.amount),
  permitValue: BigInt(q.permitValue),
  deadline: BigInt(q.deadline),
  nonce: BigInt(q.nonce),
  signature: '0x',
  v: q.v,
  r: q.r,
  s: q.s,
})

export function jobView(row: JobRow) {
  return {
    jobId: row.id,
    status: row.status,
    ...(row.tx_hash ? { txHash: row.tx_hash as Hex } : {}),
    ...(row.error ? { error: row.error as RelayErrorCode } : {}),
    ...(row.detail ? { detail: JSON.parse(row.detail) as Detail } : {}),
  }
}

export async function upsertJob(
  db: D1Database,
  jobId: Hex,
  p: Pick<ParsedRelay, 'owner' | 'kind' | 'asset' | 'amount' | 'nonce'>,
  createdAt: number,
  status: JobStatus,
  txHash: Hex | null,
  error: RelayErrorCode | null,
  detail: Detail | null,
) {
  await db
    .prepare(
      `INSERT INTO relay_jobs (id, owner, kind, asset, amount, status, tx_hash, nonce, error, detail, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash, error = excluded.error,
         detail = excluded.detail, updated_at = excluded.updated_at`,
    )
    .bind(
      jobId,
      p.owner.toLowerCase(),
      p.kind,
      p.asset,
      p.amount.toString(),
      status,
      txHash,
      p.nonce.toString(),
      error,
      detail ? JSON.stringify(detail) : null,
      createdAt,
      Date.now(),
    )
    .run()
}
