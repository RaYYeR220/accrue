import { RELAY_ERROR_CODES, type RelayErrorCode } from '@accrue/shared'

export type UiErrorCode = RelayErrorCode | 'USER_REJECTED' | 'PROVIDER_MISSING' | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN_OUTCOME'

// none: nothing to retry automatically (the user changes something or checks activity first)
// same: send the identical request again
// resign: ask the user for a fresh signature, then send
export type Retry = 'none' | 'same' | 'resign'

export interface UiError {
  code: UiErrorCode
  retry: Retry
  messageKey: string
  detail?: Record<string, unknown>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

export class ProviderMissingError extends Error {
  constructor(readonly provider: 'nimiq' | 'ethereum') {
    super(`${provider} provider is not available`)
    this.name = 'ProviderMissingError'
  }
}

// Every public Polygon RPC failed for a read; viem's own error stays in `cause`.
export class RpcUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Polygon RPC unavailable', { cause })
    this.name = 'RpcUnavailableError'
  }
}

const RELAY_RETRY: Record<RelayErrorCode, Retry> = {
  ASSET_NOT_ALLOWED: 'none',
  AMOUNT_TOO_SMALL: 'none',
  AMOUNT_TOO_LARGE: 'none',
  DEADLINE_INVALID: 'resign',
  BAD_SIGNATURE: 'resign',
  PERMIT_NONCE_STALE: 'resign',
  INSUFFICIENT_BALANCE: 'none',
  RATE_LIMITED: 'none',
  BUDGET_EXHAUSTED: 'none',
  RELAYER_LOW_GAS: 'none',
  SIMULATION_FAILED: 'none',
  AAVE_LIQUIDITY: 'none',
  RPC_UNAVAILABLE: 'same',
  INTERNAL: 'same',
}

const isRelayCode = (s: string): s is RelayErrorCode => (RELAY_ERROR_CODES as readonly string[]).includes(s)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function ui(code: UiErrorCode, retry: Retry, messageKey: string = `error.${code}`, detail?: unknown): UiError {
  return isRecord(detail) ? { code, retry, messageKey, detail } : { code, retry, messageKey }
}

const generic = (): UiError => ui('INTERNAL', 'none', 'error.generic')
const insufficientGas = (message: string) => /insufficient funds/i.test(message)

function fromRelay(code: string, detail: unknown): UiError {
  return isRelayCode(code) ? ui(code, RELAY_RETRY[code], `error.${code}`, detail) : generic()
}

function fromHttp(status: number, body: unknown): UiError {
  if (isRecord(body) && typeof body.error === 'string') return fromRelay(body.error, body.detail)
  if (status === 429) return ui('RATE_LIMITED', 'none')
  if (status === 408) return ui('TIMEOUT', 'same')
  if (status >= 500) return ui('NETWORK', 'same', 'error.serviceDown')
  return generic()
}

// NimiqProviderError.type values from @nimiq/mini-app-sdk
function fromNimiq(type: string, message: string): UiError | null {
  switch (type) {
    case 'PERMISSION_DENIED':
      return ui('USER_REJECTED', 'none')
    case 'NETWORK_ERROR':
      return ui('NETWORK', 'same')
    case 'TRANSACTION_OUTCOME_UNKNOWN':
      return ui('UNKNOWN_OUTCOME', 'none')
    case 'DUPLICATE_PAYMENT':
      return ui('UNKNOWN_OUTCOME', 'none', 'error.duplicatePayment')
    case 'INVALID_TRANSACTION':
      return insufficientGas(message)
        ? ui('INSUFFICIENT_BALANCE', 'none')
        : ui('INTERNAL', 'none', 'error.invalidTransaction')
    case 'UNKNOWN_REQUEST':
      return ui('PROVIDER_MISSING', 'none', 'error.updateWallet')
    case 'INVALID_REQUEST':
      return generic()
    case 'INTERNAL_ERROR':
    case 'UNKNOWN_ERROR':
      return ui('INTERNAL', 'same', 'error.wallet')
    default:
      return null
  }
}

// EIP-1193 provider errors and the JSON-RPC codes wallets commonly return
function fromEip1193(code: number, message: string): UiError {
  switch (code) {
    case 4001:
    case 4100:
      return ui('USER_REJECTED', 'none')
    case 4200:
      return ui('PROVIDER_MISSING', 'none', 'error.updateWallet')
    case 4900:
    case 4901:
      return ui('NETWORK', 'same')
    case 4902:
      return ui('NETWORK', 'none', 'error.chainUnavailable')
    case -32002:
      return ui('INTERNAL', 'same', 'error.walletBusy')
    case -32005:
      return ui('NETWORK', 'same')
    case -32000:
    case -32603:
      return insufficientGas(message)
        ? ui('INSUFFICIENT_BALANCE', 'none', 'error.insufficientGas')
        : ui('INTERNAL', 'same', 'error.wallet')
    default:
      return generic()
  }
}

export function toUiError(e: unknown): UiError {
  if (e instanceof ProviderMissingError) return ui('PROVIDER_MISSING', 'none')
  if (e instanceof RpcUnavailableError) return ui('RPC_UNAVAILABLE', 'same')
  if (e instanceof HttpError) return fromHttp(e.status, e.body)
  if (!isRecord(e)) return generic()
  const o = e

  // relay API body: { error: RelayErrorCode, detail? }
  if (typeof o.error === 'string') return fromRelay(o.error, o.detail)
  // legacy Nimiq handler response: { error: { type, message } }
  if (isRecord(o.error)) return toUiError(o.error)

  const name = typeof o.name === 'string' ? o.name : ''
  const message = typeof o.message === 'string' ? o.message : ''

  if (name === 'TimeoutError' || name === 'AbortError') return ui('TIMEOUT', 'same')
  if (typeof o.type === 'string') {
    const mapped = fromNimiq(o.type, message)
    if (mapped) return mapped
  }
  if (typeof o.code === 'number') return fromEip1193(o.code, message)
  // viem's transport error for the public Polygon RPCs
  if (name === 'HttpRequestError') return ui('NETWORK', 'same')
  if (typeof o.status === 'number') return fromHttp(o.status, o.body)
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) return ui('NETWORK', 'same')
  // thrown by the SDK's init() when window.nimiq never shows up
  if (/provider was not injected/i.test(message)) return ui('PROVIDER_MISSING', 'none')
  return generic()
}
