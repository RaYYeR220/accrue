import { MIN_STAKE_LUNA, type Staker } from '@accrue/shared'
import type { NimAccounts, NimBalances } from '../../providers/nimiq'

export type StakePlan =
  | { kind: 'new' | 'add'; delegationRequired: boolean }
  | { error: 'BELOW_MINIMUM' | 'INSUFFICIENT_BALANCE' }
  | { error: 'FUNDS_SPLIT'; available: bigint }

// One staking transaction is funded from one account. Nimiq Pay funds staking from the HTLC
// (where spendable NIM usually sits; the wallet address often reads 0), so with an HTLC account
// that balance is what can be staked; without one, the wallet's. Home still shows the total.
export function stakeFundsOf(accounts: NimAccounts, b: NimBalances): bigint {
  return accounts.htlc ? b.htlc : b.wallet
}

// The protocol checks the minimum on the staker's non-retired balance after the change,
// so an existing staker may add less than 100 NIM. `total` (wallet + HTLC) tells a split
// balance apart from one that is simply too low.
export function stakePlan(args: { staker: Staker | null; spendable: bigint; amount: bigint; total?: bigint }): StakePlan {
  const { staker, spendable, amount, total } = args
  const staked = staker ? staker.activeLuna + staker.inactiveLuna : 0n
  if (amount <= 0n || staked + amount < MIN_STAKE_LUNA) return { error: 'BELOW_MINIMUM' }
  if (amount > spendable) {
    return total !== undefined && amount <= total ? { error: 'FUNDS_SPLIT', available: spendable } : { error: 'INSUFFICIENT_BALANCE' }
  }
  return staker ? { kind: 'add', delegationRequired: false } : { kind: 'new', delegationRequired: true }
}

// activeAfter: what stays staked (active + inactive) once `removing` is taken out.
export function guardRemove(args: { activeAfter: bigint; removing: bigint }): 'ok' | 'LEAVES_DUST' {
  const { activeAfter, removing } = args
  return removing > 0n && activeAfter > 0n && activeAfter < MIN_STAKE_LUNA ? 'LEAVES_DUST' : 'ok'
}
