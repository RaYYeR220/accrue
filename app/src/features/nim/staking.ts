import { MIN_STAKE_LUNA, type Staker } from '@accrue/shared'
import type { NimBalances } from '../../providers/nimiq'

export type StakePlan =
  | { kind: 'new' | 'add'; delegationRequired: boolean }
  | { error: 'BELOW_MINIMUM' | 'INSUFFICIENT_BALANCE' }

// Nimiq Pay funds staking from the HTLC, and that is where spendable NIM usually sits
// (the wallet address often reads 0), so both accounts count.
export function spendableOf(b: NimBalances): bigint {
  return b.wallet + b.htlc
}

// The protocol checks the minimum on the staker's non-retired balance after the change,
// so an existing staker may add less than 100 NIM.
export function stakePlan(args: { staker: Staker | null; spendable: bigint; amount: bigint }): StakePlan {
  const { staker, spendable, amount } = args
  const staked = staker ? staker.activeLuna + staker.inactiveLuna : 0n
  if (amount <= 0n || staked + amount < MIN_STAKE_LUNA) return { error: 'BELOW_MINIMUM' }
  if (amount > spendable) return { error: 'INSUFFICIENT_BALANCE' }
  return staker ? { kind: 'add', delegationRequired: false } : { kind: 'new', delegationRequired: true }
}

// activeAfter: what stays staked (active + inactive) once `removing` is taken out.
export function guardRemove(args: { activeAfter: bigint; removing: bigint }): 'ok' | 'LEAVES_DUST' {
  const { activeAfter, removing } = args
  return removing > 0n && activeAfter > 0n && activeAfter < MIN_STAKE_LUNA ? 'LEAVES_DUST' : 'ok'
}
