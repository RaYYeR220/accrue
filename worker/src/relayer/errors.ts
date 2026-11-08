import { BaseError, decodeErrorResult, HttpRequestError, TimeoutError, type Abi, type Hex } from 'viem'
import type { RelayErrorCode } from '@accrue/shared'

export type Detail = Record<string, unknown>

export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    readonly detail?: Detail,
    /** Overrides HTTP_STATUS[code]; malformed input is 400 INTERNAL. */
    readonly status?: number,
  ) {
    super(code)
    this.name = 'RelayError'
  }
}

export const HTTP_STATUS: Record<RelayErrorCode, number> = {
  ASSET_NOT_ALLOWED: 400,
  AMOUNT_TOO_SMALL: 400,
  AMOUNT_TOO_LARGE: 400,
  DEADLINE_INVALID: 400,
  BAD_SIGNATURE: 400,
  PERMIT_NONCE_STALE: 409,
  INSUFFICIENT_BALANCE: 422,
  SIMULATION_FAILED: 422,
  AAVE_LIQUIDITY: 422,
  RATE_LIMITED: 429,
  BUDGET_EXHAUSTED: 503,
  RELAYER_LOW_GAS: 503,
  RPC_UNAVAILABLE: 503,
  INTERNAL: 500,
}

export function errorBody(code: RelayErrorCode, detail?: Detail) {
  return detail ? { error: code, detail } : { error: code }
}

export interface RelayResponse {
  status: number
  body: Record<string, unknown>
}

/** A RelayError becomes its code; anything else is logged and becomes a bare INTERNAL. */
export function toResponse(e: unknown, where: string): RelayResponse {
  if (e instanceof RelayError) return { status: e.status ?? HTTP_STATUS[e.code], body: errorBody(e.code, e.detail) }
  console.error(`${where} internal`, e instanceof Error ? e.message.slice(0, 200) : String(e))
  return { status: 500, body: errorBody('INTERNAL') }
}

/** True when the failure is the transport (timeout, HTTP error, refused), not the chain saying no. */
export function isTransportError(err: unknown): boolean {
  return err instanceof BaseError && !!err.walk(e => e instanceof HttpRequestError || e instanceof TimeoutError)
}

function revertData(err: unknown): Hex | undefined {
  let e = err as { data?: unknown; cause?: unknown } | undefined
  for (let i = 0; e && i < 12; i++) {
    const d = e.data as unknown
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') {
      const inner = (d as { data: string }).data
      if (/^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex
    }
    e = e.cause as typeof e
  }
  return undefined
}

export interface Revert {
  /** Custom error name, `Error(string)` message, `Panic(n)`, the raw selector, or `reverted` when no data came back. */
  reason: string
  name?: string
}

/** Decodes an eth_call / estimateGas revert against `abi` (plus Error/Panic); undefined if it was not a revert. */
export function decodeRevert(err: unknown, abi: Abi): Revert | undefined {
  if (isTransportError(err)) return undefined
  const data = revertData(err)
  if (data) {
    try {
      const d = decodeErrorResult({ abi, data })
      if (d.errorName === 'Error') return { reason: String(d.args?.[0] ?? ''), name: 'Error' }
      if (d.errorName === 'Panic') return { reason: `Panic(${String(d.args?.[0])})`, name: 'Panic' }
      return { reason: d.errorName, name: d.errorName }
    } catch {
      return { reason: data.slice(0, 10) }
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/revert/i.test(msg)) return { reason: 'reverted' }
  return undefined
}
