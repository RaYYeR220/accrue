import { toUiError, type Retry, type UiError, type UiErrorCode } from '../../providers/errors'

// Refusals decided in the app before any wallet dialog opens. A staking transaction that breaks
// a protocol rule is not refused by the wallet: testnet included such transactions as failed
// (the fee, if any, is still paid) or dropped them silently, so these checks run first.
export const NIM_ERROR_CODES = [
  'BELOW_MINIMUM',
  'INSUFFICIENT_BALANCE',
  'LEAVES_DUST',
  'INVALID_AMOUNT',
  'NOT_READY',
  'NO_POOL',
  'NOT_STAKING',
  'NOT_CONNECTED',
  'BUSY',
  'TX_FAILED',
] as const
export type NimErrorCode = (typeof NIM_ERROR_CODES)[number]

export class NimPlanError extends Error {
  constructor(readonly code: Exclude<NimErrorCode, 'TX_FAILED'>) {
    super(`NIM staking refused: ${code}`)
    this.name = 'NimPlanError'
  }
}

// The network included the transaction with executionResult false.
export class NimTxFailedError extends Error {
  readonly code = 'TX_FAILED'
  constructor(readonly hash: string) {
    super(`NIM transaction failed on chain: ${hash}`)
    this.name = 'NimTxFailedError'
  }
}

export interface NimUiError extends Omit<UiError, 'code'> {
  code: UiErrorCode | NimErrorCode
  retry: Retry
}

export function toNimUiError(e: unknown): NimUiError {
  if (e instanceof NimPlanError) return { code: e.code, retry: 'none', messageKey: `nim.error.${e.code}` }
  if (e instanceof NimTxFailedError) return { code: 'TX_FAILED', retry: 'none', messageKey: 'nim.error.TX_FAILED', detail: { hash: e.hash } }
  return toUiError(e)
}
