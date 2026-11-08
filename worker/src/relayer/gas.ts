const GWEI = 1_000_000_000n
const POL = 10n ** 18n

export const GAS_POLICY = {
  minTipWei: 30n * GWEI,
  budgetWeiMax: 3n * POL,
  floorWei: POL / 5n,
  /** Polls for receipts this often while anything is in flight. */
  pollMs: 5_000,
  /** A tx with no receipt after this long gets re-signed with a higher tip. */
  replaceAfterMs: 45_000,
  maxBumps: 3,
  /** Scan window for "someone else already relayed this permit" (~1 h of Polygon blocks). */
  landedLookbackBlocks: 1_800n,
  /** Fallback window every public RPC serves. */
  landedNarrowBlocks: 50n,
  /** A replacement this close to the permit deadline would likely land after it, so cancel instead. */
  deadlineMarginSec: 15,
  /** Polls in a row that see our nonce used with no receipt for any of our hashes before giving up on the job. */
  droppedPolls: 3,
  cancelGas: 21_000n,
} as const

export interface Fees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

const max = (a: bigint, b: bigint) => (a > b ? a : b)

/** tip = max(30 gwei, node suggestion); maxFee = 2 x base + tip. */
export function initialFees(baseFeeWei: bigint, suggestedTipWei: bigint): Fees {
  const tip = max(GAS_POLICY.minTipWei, suggestedTipWei)
  return { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * baseFeeWei + tip }
}

/** Estimate x 1.2, rounded up. */
export function gasLimit(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n
}

/**
 * Replacement fees: +25 % tip, and a max fee that is both +25 % over the old one (nodes require >= +10 % on each
 * field to accept a replacement) and still 2 x the current base fee above the new tip.
 */
export function bumpedFees(prev: Fees, baseFeeWei: bigint): Fees {
  const tip = (prev.maxPriorityFeePerGas * 125n + 99n) / 100n
  const maxFee = max((prev.maxFeePerGas * 125n + 99n) / 100n, 2n * baseFeeWei + tip)
  return { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee }
}

export function shouldReplace(lastSentAt: number, now: number, bumps: number): boolean {
  return bumps < GAS_POLICY.maxBumps && now - lastSentAt >= GAS_POLICY.replaceAfterMs
}

/**
 * Next relayer nonce. The stored counter only matters while our own txs are still pending (a node may not have
 * seen them yet); with nothing in flight the chain is authoritative, which also heals a gap left by a dropped tx.
 */
export function pickNonce(stored: number | undefined, pendingCount: number | undefined, hasInflight: boolean): number {
  if (pendingCount === undefined) {
    if (stored === undefined) throw new Error('no nonce source')
    return stored
  }
  if (!hasInflight || stored === undefined) return pendingCount
  return Math.max(stored, pendingCount)
}

/** UTC day number, the key of relay_budget. */
export function budgetDay(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000)
}
