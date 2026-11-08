import { describe, expect, it } from 'vitest'
import { maxUint256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildPermit } from '@accrue/shared'
import {
  checkLimits,
  jobIdOf,
  normalizeSignature,
  validateRelay,
  validateStatic,
  type RelayRequest,
} from '../src/relayer/validate'

const NOW = 1_800_000_000_000
const SEC = NOW / 1000
const POL = 10n ** 18n
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const ROUTER = '0x000000000000000000000000000000000000dEaD'

const signature = await owner.signTypedData(
  buildPermit({
    token: 'asset',
    asset: 'USDT0',
    owner: owner.address,
    spender: ROUTER,
    value: 5_000_000n,
    nonce: 0n,
    deadline: BigInt(SEC + 600),
  }),
)

const ctx = {
  now: NOW,
  ownerCount24h: 0,
  budgetWeiToday: 0n,
  budgetWeiMax: 3n * POL,
  relayerBalanceWei: POL,
  floorWei: POL / 5n,
}

const supply: RelayRequest = {
  kind: 'supply',
  asset: 'USDT0',
  owner: owner.address,
  amount: '5000000',
  deadline: String(SEC + 600),
  nonce: '0',
  signature,
}

const withdraw: RelayRequest = {
  kind: 'withdraw',
  asset: 'USDT0',
  owner: owner.address,
  amount: maxUint256.toString(),
  permitValue: '5100000',
  deadline: String(SEC + 600),
  nonce: '0',
  signature,
}

const errorOf = (req: RelayRequest, over: Partial<typeof ctx> = {}) => {
  const r = validateRelay(req, { ...ctx, ...over })
  return r.ok ? 'ok' : r.error
}

describe('validateRelay', () => {
  it('rejects a deposit under $1', () => {
    expect(errorOf({ ...supply, amount: '999999' })).toBe('AMOUNT_TOO_SMALL')
  })

  it('rejects a deposit over $10,000', () => {
    expect(errorOf({ ...supply, amount: '10000000001' })).toBe('AMOUNT_TOO_LARGE')
  })

  it('accepts the bounds themselves', () => {
    expect(errorOf({ ...supply, amount: '1000000' })).toBe('ok')
    expect(errorOf({ ...supply, amount: '10000000000' })).toBe('ok')
  })

  it('rejects a deadline only 10 s away', () => {
    expect(errorOf({ ...supply, deadline: String(SEC + 10) })).toBe('DEADLINE_INVALID')
  })

  it('rejects a deadline 2 h away', () => {
    expect(errorOf({ ...supply, deadline: String(SEC + 7200) })).toBe('DEADLINE_INVALID')
  })

  it('accepts deadlines at now+60 s and now+60 min', () => {
    expect(errorOf({ ...supply, deadline: String(SEC + 60) })).toBe('ok')
    expect(errorOf({ ...supply, deadline: String(SEC + 3600) })).toBe('ok')
  })

  it('rejects an asset outside the allowlist', () => {
    expect(errorOf({ ...supply, asset: 'USDC.e' as never })).toBe('ASSET_NOT_ALLOWED')
  })

  it('rate-limits the 11th relay of an owner in 24 h', () => {
    expect(errorOf(supply, { ownerCount24h: 9 })).toBe('ok')
    expect(errorOf(supply, { ownerCount24h: 10 })).toBe('RATE_LIMITED')
  })

  it('stops when the daily gas budget is used up', () => {
    expect(errorOf(supply, { budgetWeiToday: 3n * POL })).toBe('BUDGET_EXHAUSTED')
  })

  it('stops when the relayer is below its gas floor', () => {
    expect(errorOf(supply, { relayerBalanceWei: POL / 5n - 1n })).toBe('RELAYER_LOW_GAS')
  })

  it('accepts a valid supply and parses it', () => {
    const r = validateRelay(supply, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.parsed).toMatchObject({
      kind: 'supply',
      asset: 'USDT0',
      owner: owner.address,
      amount: 5_000_000n,
      permitValue: 5_000_000n,
      deadline: BigInt(SEC + 600),
      nonce: 0n,
    })
    expect(r.parsed.v === 27 || r.parsed.v === 28).toBe(true)
    expect(r.parsed.r).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('answers every malformed field with 400 INTERNAL bad_request', () => {
    const cases: [string, RelayRequest][] = [
      ['kind', { ...supply, kind: 'borrow' as never }],
      ['owner', { ...supply, owner: '0x1234' as never }],
      ['signature', { ...supply, signature: '0xdead' }],
      ['amount', { ...supply, amount: '5.5' }],
      ['amount', { ...supply, amount: '-5000000' }],
      ['amount', { ...supply, amount: 5000000 as never }],
      ['permitValue', { ...withdraw, permitValue: undefined }],
      ['permitValue', { ...withdraw, permitValue: '1e6' }],
      ['deadline', { ...supply, deadline: 'soon' }],
      ['nonce', { ...supply, nonce: '0x01' }],
    ]
    for (const [field, req] of cases) {
      const r = validateRelay(req, ctx)
      expect(r, field).toEqual({ ok: false, error: 'INTERNAL', status: 400, detail: { reason: 'bad_request', field } })
    }
    expect(validateRelay(null as never, ctx)).toMatchObject({ ok: false, error: 'INTERNAL', status: 400 })
  })

  it('rejects a high-s (malleated) signature', () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const s = BigInt(`0x${signature.slice(66, 130)}`)
    const v = parseInt(signature.slice(130), 16)
    const flipped = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex
    expect(errorOf({ ...supply, signature: flipped })).toBe('BAD_SIGNATURE')
  })

  it('accepts withdraw-all with a permit value and needs that value', () => {
    expect(errorOf(withdraw)).toBe('ok')
    expect(errorOf({ ...withdraw, amount: '0' })).toBe('AMOUNT_TOO_SMALL')
    expect(errorOf({ ...withdraw, permitValue: '0' })).toBe('AMOUNT_TOO_SMALL')
  })

  it('does not cap withdrawals at the deposit cap', () => {
    expect(errorOf({ ...withdraw, amount: '20000000000', permitValue: '20000000000' })).toBe('ok')
  })
})

describe('static validation and limits are separable', () => {
  it('validateStatic ignores rate, budget and gas floor', () => {
    expect(validateStatic(supply, NOW).ok).toBe(true)
    expect(validateStatic({ ...supply, amount: '1' }, NOW)).toMatchObject({ ok: false, error: 'AMOUNT_TOO_SMALL' })
  })

  it('checkLimits applies rate, then budget, then floor', () => {
    expect(checkLimits(ctx)).toBeNull()
    expect(checkLimits({ ...ctx, ownerCount24h: 10, budgetWeiToday: 3n * POL })).toMatchObject({ error: 'RATE_LIMITED' })
    expect(checkLimits({ ...ctx, budgetWeiToday: 3n * POL, relayerBalanceWei: 0n })).toMatchObject({ error: 'BUDGET_EXHAUSTED' })
    expect(checkLimits({ ...ctx, relayerBalanceWei: 0n })).toMatchObject({ error: 'RELAYER_LOW_GAS' })
  })
})

describe('signature normalisation', () => {
  it('maps v 0/1 to 27/28 so both spellings share one jobId', () => {
    const v = parseInt(signature.slice(130), 16)
    const raw = `${signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}` as Hex
    expect(normalizeSignature(raw)).toBe(signature.toLowerCase())
    expect(jobIdOf(raw)).toBe(jobIdOf(signature.toUpperCase().replace('0X', '0x') as Hex))
  })
})
