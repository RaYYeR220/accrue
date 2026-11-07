import { NimiqProviderError } from '@nimiq/mini-app-sdk'
import { RELAY_ERROR_CODES } from '@accrue/shared'
import { describe, expect, it } from 'vitest'
import { HttpError, ProviderMissingError, RpcUnavailableError, toUiError, WrongChainError } from '../src/providers/errors'

describe('toUiError: Nimiq provider errors', () => {
  it('PERMISSION_DENIED 4001 is a user rejection with no retry', () => {
    expect(toUiError({ type: 'PERMISSION_DENIED', code: 4001 })).toMatchObject({ code: 'USER_REJECTED', retry: 'none' })
  })

  it('maps the SDK error class', () => {
    const e = new NimiqProviderError('NETWORK_ERROR', 'offline', -32000)
    expect(toUiError(e)).toMatchObject({ code: 'NETWORK', retry: 'same' })
  })

  it('TRANSACTION_OUTCOME_UNKNOWN must not be resent blindly', () => {
    expect(toUiError({ type: 'TRANSACTION_OUTCOME_UNKNOWN', message: 'timeout' })).toMatchObject({
      code: 'UNKNOWN_OUTCOME',
      retry: 'none',
    })
  })

  it('INVALID_TRANSACTION "Insufficient funds" is a balance problem', () => {
    expect(toUiError({ type: 'INVALID_TRANSACTION', code: -32602, message: 'Insufficient funds' })).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      retry: 'none',
    })
  })

  it('other INVALID_TRANSACTION is not a balance problem', () => {
    expect(toUiError({ type: 'INVALID_TRANSACTION', code: -32602, message: 'Invalid delegation' })).toMatchObject({
      code: 'INTERNAL',
      retry: 'none',
      messageKey: 'error.invalidTransaction',
    })
  })

  it('DUPLICATE_PAYMENT means it was already sent', () => {
    expect(toUiError({ type: 'DUPLICATE_PAYMENT', message: 'dup' })).toMatchObject({
      code: 'UNKNOWN_OUTCOME',
      retry: 'none',
      messageKey: 'error.duplicatePayment',
    })
  })

  it('UNKNOWN_REQUEST means the wallet is too old for this call', () => {
    expect(toUiError({ type: 'UNKNOWN_REQUEST', code: 4200, message: 'no' })).toMatchObject({
      code: 'PROVIDER_MISSING',
      messageKey: 'error.updateWallet',
    })
  })

  it('a legacy { error: { type, message } } response is unwrapped', () => {
    expect(toUiError({ error: { type: 'PERMISSION_DENIED', message: 'denied' } })).toMatchObject({ code: 'USER_REJECTED' })
  })
})

describe('toUiError: EIP-1193 errors', () => {
  it('4001 is a user rejection', () => {
    expect(toUiError({ code: 4001 })).toMatchObject({ code: 'USER_REJECTED', retry: 'none' })
  })

  it('4100 unauthorized is treated as a rejection', () => {
    expect(toUiError({ code: 4100, message: 'unauthorized' })).toMatchObject({ code: 'USER_REJECTED' })
  })

  it('a disconnected provider is a network problem worth retrying', () => {
    expect(toUiError({ code: 4900, message: 'disconnected' })).toMatchObject({ code: 'NETWORK', retry: 'same' })
  })

  it('a request already pending in the wallet', () => {
    expect(toUiError({ code: -32002, message: 'already pending' })).toMatchObject({
      retry: 'same',
      messageKey: 'error.walletBusy',
    })
  })

  it('no gas for a self-paid transaction', () => {
    expect(toUiError({ code: -32000, message: 'insufficient funds for gas * price + value' })).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      messageKey: 'error.insufficientGas',
    })
  })
})

describe('toUiError: relay API errors', () => {
  it('PERMIT_NONCE_STALE asks for a fresh signature', () => {
    expect(toUiError({ error: 'PERMIT_NONCE_STALE' })).toMatchObject({
      code: 'PERMIT_NONCE_STALE',
      retry: 'resign',
      messageKey: 'error.PERMIT_NONCE_STALE',
    })
  })

  it('every relay code maps to itself with a retry policy', () => {
    for (const code of RELAY_ERROR_CODES) {
      const ui = toUiError({ error: code })
      expect(ui.code).toBe(code)
      expect(['none', 'same', 'resign']).toContain(ui.retry)
    }
  })

  it('signature problems re-sign, transient ones retry the same request', () => {
    expect(toUiError({ error: 'BAD_SIGNATURE' }).retry).toBe('resign')
    expect(toUiError({ error: 'DEADLINE_INVALID' }).retry).toBe('resign')
    expect(toUiError({ error: 'RPC_UNAVAILABLE' }).retry).toBe('same')
    expect(toUiError({ error: 'AMOUNT_TOO_SMALL' }).retry).toBe('none')
  })

  it('keeps the detail so the UI can show the available liquidity', () => {
    expect(toUiError({ error: 'AAVE_LIQUIDITY', detail: { available: '3000000' } })).toMatchObject({
      code: 'AAVE_LIQUIDITY',
      retry: 'none',
      detail: { available: '3000000' },
    })
  })

  it('reads the relay code out of an HTTP error body', () => {
    expect(toUiError(new HttpError(409, { error: 'PERMIT_NONCE_STALE' }))).toMatchObject({
      code: 'PERMIT_NONCE_STALE',
      retry: 'resign',
    })
  })

  it('a 5xx without a code is the service being down', () => {
    expect(toUiError(new HttpError(503, null))).toMatchObject({
      code: 'NETWORK',
      retry: 'same',
      messageKey: 'error.serviceDown',
    })
  })

  it('a bare 429 is rate limiting', () => {
    expect(toUiError(new HttpError(429, {}))).toMatchObject({ code: 'RATE_LIMITED', retry: 'none' })
  })

  it('an unknown relay code is not trusted', () => {
    expect(toUiError({ error: 'SOMETHING_NEW' })).toMatchObject({ code: 'INTERNAL', messageKey: 'error.generic' })
  })
})

describe('toUiError: everything else', () => {
  it('fetch network failure', () => {
    expect(toUiError(new TypeError('Failed to fetch'))).toMatchObject({ code: 'NETWORK', retry: 'same' })
  })

  it('timeouts', () => {
    expect(toUiError(new DOMException('slow', 'TimeoutError'))).toMatchObject({ code: 'TIMEOUT', retry: 'same' })
    expect(toUiError(new DOMException('slow', 'AbortError'))).toMatchObject({ code: 'TIMEOUT' })
    expect(toUiError(Object.assign(new Error('viem'), { name: 'TimeoutError' }))).toMatchObject({ code: 'TIMEOUT' })
  })

  it('public Polygon RPC failure', () => {
    expect(toUiError(new RpcUnavailableError(new Error('all down')))).toMatchObject({ code: 'RPC_UNAVAILABLE', retry: 'same' })
  })

  it('wallet on the wrong chain: switch first, then the same request again', () => {
    expect(toUiError(new WrongChainError('0x1'))).toEqual({ code: 'WRONG_CHAIN', retry: 'same', messageKey: 'error.WRONG_CHAIN' })
  })

  it('missing provider', () => {
    expect(toUiError(new ProviderMissingError('nimiq'))).toMatchObject({ code: 'PROVIDER_MISSING', retry: 'none' })
    expect(toUiError(new Error('Nimiq provider was not injected. Are you running inside a Nimiq app?'))).toMatchObject({
      code: 'PROVIDER_MISSING',
    })
  })

  it('anything unrecognised is a generic error', () => {
    for (const e of [undefined, null, 'boom', 42, new Error('boom'), {}]) {
      expect(toUiError(e)).toEqual({ code: 'INTERNAL', retry: 'none', messageKey: 'error.generic' })
    }
  })
})
