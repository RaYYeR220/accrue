import type { AssetKey } from '@accrue/shared'
import { maxUint256 } from 'viem'
import { runFlow, uiError, type Emit, type FlowOpts } from './flow'

// "All" signs a little above the balance so interest accrued until the tx lands is covered.
// The router pulls min(amount, balance), so the extra allowance can never move more than the position.
export const withdrawAllPermitValue = (balance: bigint) => balance + balance / 100_000n + 10n

// Withdraw from Aave through the router: one EIP-2612 permit on the aToken, gas paid by the relayer.
// Funds only ever go back to the owner.
export function withdraw(asset: AssetKey, amount: bigint | 'all', opts: FlowOpts, emit: Emit): Promise<void> {
  const insufficient = (balance: bigint) => uiError('INSUFFICIENT_BALANCE', 'none', undefined, { balance: balance.toString() })
  return runFlow(
    {
      kind: 'withdraw',
      asset,
      precheck: () => (amount !== 'all' && amount < 1n ? uiError('AMOUNT_TOO_SMALL', 'none', undefined, { min: '1' }) : null),
      values: balance => {
        if (amount === 'all') {
          // the relay reads amount 2^256-1 as "everything"
          return balance === 0n ? insufficient(balance) : { amount: maxUint256, permitValue: withdrawAllPermitValue(balance) }
        }
        return amount > balance ? insufficient(balance) : { amount, permitValue: amount }
      },
    },
    opts,
    emit,
  )
}
