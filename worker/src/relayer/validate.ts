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

export type Failure = {
  ok: false
  error: RelayErrorCode
  detail?: Record<string, unknown>
  /** Set when the HTTP status is not the code's default (malformed input is 400 INTERNAL). */
  status?: number
}

export type ValidateResult = { ok: true; parsed: ParsedRelay } | Failure

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

/** v, r, s of a well-formed 65-byte signature, or null when it is not a usable secp256k1 signature. */
function splitSignature(sig: Hex): { v: 27 | 28; r: Hex; s: Hex } | null {
  const norm = normalizeSignature(sig)
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

const fail = (error: RelayErrorCode, detail?: Record<string, unknown>): Failure => ({ ok: false, error, detail })
const badRequest = (field: string): Failure => ({
  ok: false,
  error: 'INTERNAL',
  status: 400,
  detail: { reason: 'bad_request', field },
})

/**
 * Request shape and product limits: everything that needs neither chain access nor relayer state.
 * Malformed fields are 400 INTERNAL bad_request; well-formed but unacceptable values get their own code.
 * `nowMs` is unix ms; `deadline` is unix seconds.
 */
export function validateStatic(req: RelayRequest, nowMs: number): ValidateResult {
  if (!req || typeof req !== 'object') return badRequest('body')
  if (req.kind !== 'supply' && req.kind !== 'withdraw') return badRequest('kind')
  if (typeof req.asset !== 'string') return badRequest('asset')
  if (typeof req.owner !== 'string' || !isAddress(req.owner, { strict: false })) return badRequest('owner')
  if (!isSignatureHex(req.signature)) return badRequest('signature')
  const amount = parseUint(req.amount)
  if (amount === null) return badRequest('amount')
  const permitValue = req.kind === 'supply' ? amount : parseUint(req.permitValue)
  if (permitValue === null) return badRequest('permitValue')
  const deadline = parseUint(req.deadline)
  if (deadline === null) return badRequest('deadline')
  const nonce = parseUint(req.nonce)
  if (nonce === null) return badRequest('nonce')

  if (!Object.hasOwn(ASSETS, req.asset)) return fail('ASSET_NOT_ALLOWED')
  const sig = splitSignature(req.signature)
  if (!sig) return fail('BAD_SIGNATURE', { reason: 'invalid_signature' })
  if (req.kind === 'supply') {
    if (amount < LIMITS.minDepositUnits) return fail('AMOUNT_TOO_SMALL', { min: LIMITS.minDepositUnits.toString() })
    if (amount > LIMITS.maxTxUnits) return fail('AMOUNT_TOO_LARGE', { max: LIMITS.maxTxUnits.toString() })
  } else if (amount === 0n || permitValue === 0n) {
    // Withdrawals only ever pay the owner back, so the deposit cap and minimum do not apply.
    return fail('AMOUNT_TOO_SMALL', { min: '1' })
  }
  const nowSec = BigInt(Math.floor(nowMs / 1000))
  if (deadline < nowSec + BigInt(LIMITS.deadlineMinSec) || deadline > nowSec + BigInt(LIMITS.deadlineMaxSec))
    return fail('DEADLINE_INVALID', { min: LIMITS.deadlineMinSec, max: LIMITS.deadlineMaxSec })

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

export function rateLimit(ownerCount24h: number): Failure | null {
  return ownerCount24h >= LIMITS.relaysPerOwnerPerDay
    ? fail('RATE_LIMITED', { limit: LIMITS.relaysPerOwnerPerDay, windowHours: 24 })
    : null
}

/** Rate limit, gas budget (spent plus in-flight reservations) and the relayer's gas floor, in that order. */
export function checkLimits(ctx: Omit<ValidateCtx, 'now'>): Failure | null {
  const rate = rateLimit(ctx.ownerCount24h)
  if (rate) return rate
  if (ctx.budgetWeiToday >= ctx.budgetWeiMax) return fail('BUDGET_EXHAUSTED')
  if (ctx.relayerBalanceWei < ctx.floorWei) return fail('RELAYER_LOW_GAS')
  return null
}

/** validateStatic followed by checkLimits. */
export function validateRelay(req: RelayRequest, ctx: ValidateCtx): ValidateResult {
  const v = validateStatic(req, ctx.now)
  if (!v.ok) return v
  return checkLimits(ctx) ?? v
}
