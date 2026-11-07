import type { Staker } from '@accrue/shared'
import { guardRemove } from './staking'

// From getPolicyConstants. Mainnet's genesis (3,456,000) is a multiple of the epoch length,
// so leaving it out is exact there; testnet's (3,032,010) is not.
export interface StakingPolicy {
  blocksPerEpoch: number
  blockSeparationTimeMs: number
  genesisBlockNumber?: number
  jailEpochs?: number
}

export type UnstakeStepName = 'deactivate' | 'wait' | 'retire' | 'remove'

export interface UnstakeStep {
  step: UnstakeStepName
  readyAtBlock?: number
  etaMs?: number
  done: boolean
}

export const STEP_KEYS: Record<UnstakeStepName, string> = {
  deactivate: 'nim.step.deactivate',
  wait: 'nim.step.wait',
  retire: 'nim.step.retire',
  remove: 'nim.step.remove',
}

const DEFAULT_JAIL_EPOCHS = 8

// Policy::election_block_after: the next election block strictly after `block`.
export function electionBlockAfter(block: number, policy: StakingPolicy): number {
  const genesis = policy.genesisBlockNumber ?? 0
  if (block < genesis) return genesis
  return (Math.floor((block - genesis) / policy.blocksPerEpoch) + 1) * policy.blocksPerEpoch + genesis
}

// Set-active stores inactiveFrom = the next election block. The stake can be retired (or
// re-delegated) from block_after_collateral_lockup(inactiveFrom) = inactiveFrom + one epoch + 1,
// and not while the pool it is delegated to sits in jail (jailedFrom + jailEpochs epochs + 1).
// Confirmed on testnet: deactivated in 16,172,364 -> inactiveFrom 16,208,010; retire refused before.
export function releaseBlock(args: { inactiveFrom: number; policy: StakingPolicy; jailedFrom?: number | null }): number {
  const { inactiveFrom, policy, jailedFrom } = args
  const lockup = inactiveFrom + policy.blocksPerEpoch + 1
  if (jailedFrom === null || jailedFrom === undefined) return lockup
  const jail = jailedFrom + policy.blocksPerEpoch * (policy.jailEpochs ?? DEFAULT_JAIL_EPOCHS) + 1
  return Math.max(lockup, jail)
}

const nonRetired = (s: Staker) => s.activeLuna + s.inactiveLuna
const total = (s: Staker) => nonRetired(s) + s.retiredLuna

// What stays staked once `amount` has left: 0 or at least 100 NIM, or the retire fails on chain.
export function checkUnstake(args: { staker: Staker; amount: bigint }): 'ok' | 'LEAVES_DUST' | 'INVALID_AMOUNT' {
  const { staker, amount } = args
  if (amount <= 0n || amount > total(staker)) return 'INVALID_AMOUNT'
  const retiring = amount > staker.retiredLuna ? amount - staker.retiredLuna : 0n
  return guardRemove({ activeAfter: nonRetired(staker) - retiring, removing: amount })
}

// The set-active value for the deactivate step, or null when enough is inactive already.
// resetsWait: set-active moves the whole inactive balance to the new election block, so NIM that
// was already waiting starts over.
export function deactivateTarget(staker: Staker, amount: bigint): { newActive: bigint; resetsWait: boolean } | null {
  const needInactive = amount - staker.retiredLuna
  if (needInactive <= staker.inactiveLuna) return null
  return { newActive: nonRetired(staker) - needInactive, resetsWait: staker.inactiveLuna > 0n }
}

export function retireAmount(staker: Staker, amount: bigint): bigint {
  return amount > staker.retiredLuna ? amount - staker.retiredLuna : 0n
}

// Remove must take the whole retired balance; a partial remove is dropped by the network.
export function removeAmount(staker: Staker): bigint {
  return staker.retiredLuna
}

interface Timing {
  blockNow: number
  policy: StakingPolicy
  jailedFrom?: number | null
}

// No delegation means no lock-up (the protocol only locks stake that a pool could be punished for).
function released(staker: Staker, readyAt: number, blockNow: number): boolean {
  return !staker.delegation || blockNow >= readyAt
}

function waitStep(staker: Staker, deactivated: boolean, t: Timing): { readyAtBlock: number; etaMs: number; done: boolean } {
  const from = deactivated && staker.inactiveFrom !== null ? staker.inactiveFrom : electionBlockAfter(t.blockNow, t.policy)
  const readyAtBlock = releaseBlock({ inactiveFrom: from, policy: t.policy, jailedFrom: t.jailedFrom })
  const done = deactivated && released(staker, readyAtBlock, t.blockNow)
  const etaMs = done ? 0 : Math.max(0, readyAtBlock - t.blockNow) * t.policy.blockSeparationTimeMs
  return { readyAtBlock, etaMs, done }
}

export function unstakeSteps(args: {
  staker: Staker
  amount: bigint
  blockNow: number
  policy: StakingPolicy
  jailedFrom?: number | null
}): UnstakeStep[] {
  const { staker, amount } = args
  if (amount <= 0n || amount > total(staker)) throw new RangeError(`cannot unstake ${amount} luna`)
  const retired = staker.retiredLuna >= amount
  if (retired) {
    return [
      { step: 'deactivate', done: true },
      { step: 'wait', done: true },
      { step: 'retire', done: true },
      { step: 'remove', done: false },
    ]
  }
  const deactivated = deactivateTarget(staker, amount) === null
  const wait = waitStep(staker, deactivated, args)
  const gate = { readyAtBlock: wait.readyAtBlock, etaMs: wait.etaMs }
  return [
    { step: 'deactivate', done: deactivated },
    { step: 'wait', ...wait },
    { step: 'retire', ...gate, done: false },
    { step: 'remove', ...gate, done: false },
  ]
}

// Changing pool needs active stake 0 and the inactive stake released (testnet: A2 with active
// stake and A4 with locked inactive stake both failed). Then one update-staker transaction with
// reactivateAllStake moves everything to the new pool.
export function switchPoolPlan(
  staker: Staker,
  at: Timing,
): { kind: 'direct' } | { kind: 'deactivate-first'; steps: ReturnType<typeof unstakeSteps> } {
  if (!staker.delegation) return { kind: 'direct' }
  const deactivated = staker.activeLuna === 0n
  if (deactivated && staker.inactiveLuna === 0n) return { kind: 'direct' }
  const wait = waitStep(staker, deactivated, at)
  if (wait.done) return { kind: 'direct' }
  return { kind: 'deactivate-first', steps: [{ step: 'deactivate', done: deactivated }, { step: 'wait', ...wait }] }
}
