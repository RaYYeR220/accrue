import { getAddress, isAddress, keccak256, maxUint256, type Address, type Hex } from 'viem'
import { ASSETS, LIMITS, type AssetKey, type RelayErrorCode } from '@accrue/shared'

export interface RelayRequest {
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  owner: Address
  amount: string
  /** Withdraw only: the aToken permit's signed value (amount may be maxUint256 for "everything"). */
  permitValue?: string
  /** Unix seconds. */
  deadline: string
  nonce: string
  signature: Hex
}

export interface ParsedRelay {
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  owner: Address
  amount: bigint
  /** The permit's signed value; equals `amount` for supply. */
  permitValue: bigint
  deadline: bigint
  nonce: bigint
  signature: Hex
  v: 27 | 28
  r: Hex
  s: Hex
}

export interface ValidateCtx {
  /** Unix ms. */
  now: number
  ownerCount24h: number
  budgetWeiToday: bigint
  budgetWeiMax: bigint
  relayerBalanceWei: bigint
  floorWei: bigint
}

export type ValidateResult =
  | { ok: true; parsed: ParsedRelay }
  | { ok: false; error: RelayErrorCode; detail?: Record<string, unknown> }

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const UINT_RE = /^\d{1,78}$/

export function isSignatureHex(sig: unknown): sig is Hex {
  return typeof sig === 'string' && SIG_RE.test(sig)
}

function parseUint(v: unknown): bigint | null {
  if (typeof v !== 'string' || !UINT_RE.test(v)) return null
  const n = BigInt(v)
  return n <= maxUint256 ? n : null
}

/**
 * Canonical 65-byte form (lowercase, v = 27/28) so the same signature always hashes to the same jobId.
 * Input that is not a 65-byte signature comes back lowercased and is rejected later by validateRelay.
 */
export function normalizeSignature(sig: Hex): Hex {
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return String(sig).toLowerCase() as Hex
  const lower = sig.toLowerCase()
  const v = parseInt(lower.slice(130), 16)
  const canon = v === 0 || v === 1 ? v + 27 : v
  return `${lower.slice(0, 130)}${canon.toString(16).padStart(2, '0')}` as Hex
}

export function jobIdOf(sig: Hex): Hex {
  return keccak256(normalizeSignature(sig))
}

function splitSignature(sig: Hex): { v: 27 | 28; r: Hex; s: Hex } | null {
  const norm = normalizeSignature(sig)
  if (!SIG_RE.test(norm)) return null
  const r = `0x${norm.slice(2, 66)}` as Hex
  const s = `0x${norm.slice(66, 130)}` as Hex
  const v = parseInt(norm.slice(130), 16)
  if (v !== 27 && v !== 28) return null
  const rn = BigInt(r)
  const sn = BigInt(s)
  // Both permit implementations reject high-s; accepting it would also give one permit two jobIds.
  if (rn === 0n || sn === 0n || sn > SECP256K1_HALF_N) return null
  return { v, r, s }
}

const fail = (error: RelayErrorCode, detail?: Record<string, unknown>): ValidateResult => ({ ok: false, error, detail })

/**
 * Checks everything that needs no chain access: request shape, product limits, rate limit, gas budget and the
 * relayer's gas floor. `ctx.now` is unix ms; `deadline` is unix seconds.
 */
export function validateRelay(req: RelayRequest, ctx: ValidateCtx): ValidateResult {
  if (!req || typeof req !== 'object' || (req.kind !== 'supply' && req.kind !== 'withdraw'))
    return fail('INTERNAL', { reason: 'bad_request', field: 'kind' })
  if (typeof req.asset !== 'string' || !Object.hasOwn(ASSETS, req.asset)) return fail('ASSET_NOT_ALLOWED')
  if (typeof req.owner !== 'string' || !isAddress(req.owner, { strict: false }))
    return fail('BAD_SIGNATURE', { reason: 'bad_owner' })
  const sig = splitSignature(req.signature)
  if (!sig) return fail('BAD_SIGNATURE', { reason: 'malformed_signature' })

  const amount = parseUint(req.amount)
  if (amount === null) return fail('AMOUNT_TOO_SMALL', { reason: 'malformed', field: 'amount' })
  let permitValue = amount
  if (req.kind === 'supply') {
    if (amount < LIMITS.minDepositUnits) return fail('AMOUNT_TOO_SMALL', { min: LIMITS.minDepositUnits.toString() })
    if (amount > LIMITS.maxTxUnits) return fail('AMOUNT_TOO_LARGE', { max: LIMITS.maxTxUnits.toString() })
  } else {
    // Withdrawals only ever pay the owner back, so the deposit cap and minimum do not apply.
    const pv = parseUint(req.permitValue)
    if (pv === null) return fail('AMOUNT_TOO_SMALL', { reason: 'malformed', field: 'permitValue' })
    if (amount === 0n || pv === 0n) return fail('AMOUNT_TOO_SMALL', { min: '1' })
    permitValue = pv
  }

  const deadline = parseUint(req.deadline)
  const nowSec = BigInt(Math.floor(ctx.now / 1000))
  if (
    deadline === null ||
    deadline < nowSec + BigInt(LIMITS.deadlineMinSec) ||
    deadline > nowSec + BigInt(LIMITS.deadlineMaxSec)
  )
    return fail('DEADLINE_INVALID', { min: LIMITS.deadlineMinSec, max: LIMITS.deadlineMaxSec })

  const nonce = parseUint(req.nonce)
  if (nonce === null) return fail('PERMIT_NONCE_STALE', { reason: 'malformed' })

  if (ctx.ownerCount24h >= LIMITS.relaysPerOwnerPerDay)
    return fail('RATE_LIMITED', { limit: LIMITS.relaysPerOwnerPerDay, windowHours: 24 })
  if (ctx.budgetWeiToday >= ctx.budgetWeiMax) return fail('BUDGET_EXHAUSTED')
  if (ctx.relayerBalanceWei < ctx.floorWei) return fail('RELAYER_LOW_GAS')

  return {
    ok: true,
    parsed: {
      kind: req.kind,
      asset: req.asset,
      owner: getAddress(req.owner),
      amount,
      permitValue,
      deadline,
      nonce,
      signature: normalizeSignature(req.signature),
      ...sig,
    },
  }
}
