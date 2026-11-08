import { LIMITS, MIN_STAKE_LUNA, type AssetKey } from '@accrue/shared'

export type IdleOffer =
  | { key: AssetKey | 'nim'; units: bigint; ok: true }
  | { key: AssetKey | 'nim'; units: bigint; ok: false; reason: 'MIN_DEPOSIT' | 'MIN_STAKE' }

// Idle balances, and whether "Put to work" can actually work: deposits start at $1; a first stake at
// 100 NIM, while an existing stake takes any amount.
export function idleOffers(a: { wallet: Partial<Record<AssetKey, bigint>> | undefined; stakeable: bigint | undefined; staking: boolean | undefined }): IdleOffer[] {
  const out: IdleOffer[] = []
  for (const key of ['USDT0', 'USDC'] as const) {
    const units = a.wallet?.[key] ?? 0n
    if (units <= 0n) continue
    out.push(units >= LIMITS.minDepositUnits ? { key, units, ok: true } : { key, units, ok: false, reason: 'MIN_DEPOSIT' })
  }
  const nim = a.stakeable ?? 0n
  if (nim > 0n && a.staking !== undefined) {
    out.push(a.staking || nim >= MIN_STAKE_LUNA ? { key: 'nim', units: nim, ok: true } : { key: 'nim', units: nim, ok: false, reason: 'MIN_STAKE' })
  }
  return out
}
