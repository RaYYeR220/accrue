import { LUNA_PER_NIM } from '@accrue/shared'

// Below this the suggestion is noise.
const MIN_RESTAKE_LUNA = LUNA_PER_NIM
const APR_SCALE = 1_000_000

// Only direct-payout pools leave rewards idle in the wallet; restake pools compound on their own
// and 'none' pools pay nothing.
export function restakeSuggestion(args: {
  walletIdle: bigint
  payoutType: string
  reserve: bigint
  apr: number
}): { amount: bigint; extraPerYearLuna: bigint } | null {
  const { walletIdle, payoutType, reserve, apr } = args
  if (payoutType !== 'direct') return null
  if (!Number.isFinite(apr) || apr <= 0) return null
  const amount = walletIdle - (reserve > 0n ? reserve : 0n)
  if (amount < MIN_RESTAKE_LUNA) return null
  const extraPerYearLuna = (amount * BigInt(Math.round(apr * APR_SCALE))) / BigInt(APR_SCALE)
  return { amount, extraPerYearLuna }
}
