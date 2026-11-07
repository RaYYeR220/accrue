import { LIMITS, type AssetKey } from '@accrue/shared'
import { runFlow, uiError, type Emit, type FlowOpts } from './flow'

// Supply to Aave through the router: one EIP-2612 permit on the token, gas paid by the relayer.
export function deposit(asset: AssetKey, amount: bigint, opts: FlowOpts, emit: Emit): Promise<void> {
  return runFlow(
    {
      kind: 'supply',
      asset,
      precheck: () => {
        if (amount < LIMITS.minDepositUnits) return uiError('AMOUNT_TOO_SMALL', 'none', undefined, { min: LIMITS.minDepositUnits.toString() })
        if (amount > LIMITS.maxTxUnits) return uiError('AMOUNT_TOO_LARGE', 'none', undefined, { max: LIMITS.maxTxUnits.toString() })
        return null
      },
      values: balance =>
        amount > balance
          ? uiError('INSUFFICIENT_BALANCE', 'none', undefined, { balance: balance.toString() })
          : { amount, permitValue: amount },
    },
    opts,
    emit,
  )
}
