import type { Address, Hex } from 'viem'
import type { AssetKey } from './assets'

export const RELAY_ERROR_CODES = [
  'ASSET_NOT_ALLOWED',
  'AMOUNT_TOO_SMALL',
  'AMOUNT_TOO_LARGE',
  'DEADLINE_INVALID',
  'BAD_SIGNATURE',
  'PERMIT_NONCE_STALE',
  'INSUFFICIENT_BALANCE',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'RELAYER_LOW_GAS',
  'SIMULATION_FAILED',
  'AAVE_LIQUIDITY',
  'RPC_UNAVAILABLE',
  'INTERNAL',
] as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]

export const VERDICTS = [
  'PAID_AS_PROMISED',
  'BEHIND_SCHEDULE',
  'SHORT',
  'NOT_ENOUGH_DATA',
  'NO_PAYOUTS_BY_DESIGN',
  'CANT_VERIFY_ROUTED',
] as const
export type Verdict = (typeof VERDICTS)[number]

export const LIMITS = {
  minDepositUnits: 1_000_000n,
  maxTxUnits: 10_000_000_000n,
  relaysPerOwnerPerDay: 10,
  deadlineMinSec: 60,
  deadlineMaxSec: 3600,
} as const

export interface Job {
  jobId: string
  owner: Address
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  amount: string
  status: 'queued' | 'submitted' | 'confirmed' | 'failed'
  txHash?: Hex
  error?: RelayErrorCode
  detail?: object
  createdAt: number
}
