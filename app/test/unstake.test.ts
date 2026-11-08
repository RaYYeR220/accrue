import { nimToLuna, type Staker } from '@accrue/shared'
import { describe, expect, it } from 'vitest'
import { guardRemove } from '../src/features/nim/staking'
import {
  checkUnstake,
  deactivateTarget,
  electionBlockAfter,
  releaseBlock,
  removeAmount,
  retireAmount,
  switchPoolPlan,
  unstakeSteps,
} from '../src/features/nim/unstake'

const nim = (s: string) => nimToLuna(s)

// Policy constants as getPolicyConstants returns them. Testnet's genesis (3,032,010) is not a
// multiple of the epoch length, mainnet's (3,456,000) is.
const testnet = { blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000, genesisBlockNumber: 3_032_010, jailEpochs: 8 }
const mainnet = { blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000, genesisBlockNumber: 3_456_000, jailEpochs: 8 }

// Recorded on Nimiq testnet, 2026-11-07 (see task-12 report):
// B2 set-active 0 included in block 16,172,364 -> inactiveFrom 16,208,010 (the next election block).
const DEACTIVATED_IN = 16_172_364
const INACTIVE_FROM = 16_208_010
const RELEASE = INACTIVE_FROM + 43_200 + 1 // 16,251,211

const V1 = 'NQ35 YFBF ES7X R9PS 36R4 11FG 3HQF YL9Q NL2S'
const staker = (over: Partial<Staker> = {}): Staker => ({
  address: 'NQ66 C3X6 BV1F 0R6U 8QJT XV0U QHEV EKLJ 0DSN',
  delegation: V1,
  activeLuna: 0n,
  inactiveLuna: 0n,
  inactiveFrom: null,
  retiredLuna: 0n,
  ...over,
})
const deactivated = (over: Partial<Staker> = {}) =>
  staker({ inactiveLuna: nim('250'), inactiveFrom: INACTIVE_FROM, ...over })

describe('epoch arithmetic', () => {
  it('election block after a block counts epochs from genesis', () => {
    expect(electionBlockAfter(DEACTIVATED_IN, testnet)).toBe(INACTIVE_FROM)
    expect(electionBlockAfter(16_172_349, testnet)).toBe(INACTIVE_FROM)
    expect(electionBlockAfter(INACTIVE_FROM, testnet)).toBe(INACTIVE_FROM + 43_200)
    expect(electionBlockAfter(66_302_152, mainnet)).toBe(66_312_000)
  })

  it('a missing genesis means epochs start at block 0, which matches mainnet', () => {
    const { genesisBlockNumber: _g, ...noGenesis } = mainnet
    expect(electionBlockAfter(66_302_152, noGenesis)).toBe(66_312_000)
  })

  it('inactive stake is released one block after a full epoch past inactiveFrom', () => {
    expect(releaseBlock({ inactiveFrom: INACTIVE_FROM, policy: testnet })).toBe(16_251_211)
  })

  it('a jailed pool holds the stake until its jail ends, if that is later', () => {
    const jailedFrom = 16_200_000
    expect(releaseBlock({ inactiveFrom: INACTIVE_FROM, policy: testnet, jailedFrom })).toBe(jailedFrom + 8 * 43_200 + 1)
    expect(releaseBlock({ inactiveFrom: INACTIVE_FROM, policy: testnet, jailedFrom: 10_000_000 })).toBe(RELEASE)
  })

  it('with nothing inactive only the jail counts', () => {
    expect(releaseBlock({ inactiveFrom: null, policy: testnet, jailedFrom: 16_200_000 })).toBe(16_200_000 + 8 * 43_200 + 1)
  })
})

describe('unstakeSteps', () => {
  it('lists the four steps in order', () => {
    const steps = unstakeSteps({ staker: staker({ activeLuna: nim('250') }), amount: nim('250'), blockNow: 16_172_360, policy: testnet })
    expect(steps.map(s => s.step)).toEqual(['deactivate', 'wait', 'retire', 'remove'])
  })

  it('after deactivation the wait ends at inactiveFrom + one epoch + 1, not at inactiveFrom', () => {
    const blockNow = 16_172_367
    const steps = unstakeSteps({ staker: deactivated(), amount: nim('250'), blockNow, policy: testnet })
    expect(steps[0]).toEqual({ step: 'deactivate', done: true })
    expect(steps[1]).toEqual({ step: 'wait', readyAtBlock: RELEASE, etaMs: (RELEASE - blockNow) * 1_000, done: false })
    expect(steps[2]).toEqual({ step: 'retire', readyAtBlock: RELEASE, etaMs: (RELEASE - blockNow) * 1_000, done: false })
    expect(steps[3]).toEqual({ step: 'remove', readyAtBlock: RELEASE, etaMs: (RELEASE - blockNow) * 1_000, done: false })
    // about 21.9 hours from the deactivation, the "up to a day" users are told about
    expect(steps[1]!.etaMs! / 3_600_000).toBeCloseTo(21.9, 1)
  })

  // Testnet A5/B3 showed retire refused before inactiveFrom; the release one epoch + 1 block after
  // it is Policy::block_after_collateral_lockup in core-rs-albatross (staker.rs is_inactive_stake_released).
  it('passing inactiveFrom is not enough: the stake stays locked for one more epoch', () => {
    const steps = unstakeSteps({ staker: deactivated(), amount: nim('250'), blockNow: INACTIVE_FROM + 10, policy: testnet })
    expect(steps[1]).toMatchObject({ step: 'wait', done: false, readyAtBlock: RELEASE })
  })

  it('one block early is still waiting; at the release block retire is ready', () => {
    const early = unstakeSteps({ staker: deactivated(), amount: nim('250'), blockNow: RELEASE - 1, policy: testnet })
    expect(early[1]).toMatchObject({ done: false, etaMs: 1_000 })
    const ready = unstakeSteps({ staker: deactivated(), amount: nim('250'), blockNow: RELEASE, policy: testnet })
    expect(ready[1]).toEqual({ step: 'wait', readyAtBlock: RELEASE, etaMs: 0, done: true })
    expect(ready[2]).toEqual({ step: 'retire', readyAtBlock: RELEASE, etaMs: 0, done: false })
  })

  it('before deactivating, the countdown is projected from the next election block', () => {
    const steps = unstakeSteps({ staker: staker({ activeLuna: nim('250') }), amount: nim('250'), blockNow: DEACTIVATED_IN, policy: testnet })
    expect(steps[0]).toEqual({ step: 'deactivate', done: false })
    expect(steps[1]).toEqual({ step: 'wait', readyAtBlock: RELEASE, etaMs: (RELEASE - DEACTIVATED_IN) * 1_000, done: false })
  })

  it('deactivating more restarts the wait for everything already inactive', () => {
    // 100 NIM waits since the last election; unstaking 200 needs 100 more deactivated after it
    const s = staker({ activeLuna: nim('300'), inactiveLuna: nim('100'), inactiveFrom: INACTIVE_FROM })
    const blockNow = INACTIVE_FROM + 10
    const steps = unstakeSteps({ staker: s, amount: nim('200'), blockNow, policy: testnet })
    expect(steps[0]).toEqual({ step: 'deactivate', done: false })
    expect(steps[1]).toMatchObject({ readyAtBlock: INACTIVE_FROM + 2 * 43_200 + 1 })
    expect(deactivateTarget(s, nim('200'))).toEqual({ newActive: nim('200'), resetsWait: true })
  })

  it('a jailed pool pushes the wait to the end of the jail', () => {
    const jailedFrom = 16_200_000
    const steps = unstakeSteps({ staker: deactivated(), amount: nim('250'), blockNow: RELEASE, policy: testnet, jailedFrom })
    expect(steps[1]).toMatchObject({ readyAtBlock: jailedFrom + 8 * 43_200 + 1, done: false })
  })

  it('retired stake only needs the remove, which works right away', () => {
    const steps = unstakeSteps({ staker: staker({ retiredLuna: nim('250') }), amount: nim('250'), blockNow: 16_172_600, policy: testnet })
    expect(steps.map(s => s.done)).toEqual([true, true, true, false])
    expect(steps[3]).toEqual({ step: 'remove', done: false })
  })

  it('works with the staking policy without a genesis block for mainnet stakers', () => {
    const steps = unstakeSteps({
      staker: deactivated({ inactiveFrom: 66_312_000 }),
      amount: nim('250'),
      blockNow: 66_302_152,
      policy: { blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000 },
    })
    expect(steps[1]).toMatchObject({ readyAtBlock: 66_312_000 + 43_200 + 1 })
  })

  // A staker with no pool has nothing a pool could be punished for, so nothing is locked
  // (testnet C2 -> C4: retired right after deactivating, inactiveFrom notwithstanding).
  it('without a pool there is no wait: no future block, no 12-24 h projection', () => {
    const noPool = staker({ delegation: '', inactiveLuna: nim('250'), inactiveFrom: INACTIVE_FROM })
    const steps = unstakeSteps({ staker: noPool, amount: nim('250'), blockNow: 16_172_568, policy: testnet })
    expect(steps).toEqual([
      { step: 'deactivate', done: true },
      { step: 'wait', etaMs: 0, done: true },
      { step: 'retire', done: false },
      { step: 'remove', done: false },
    ])
    const active = unstakeSteps({ staker: staker({ delegation: '', activeLuna: nim('250') }), amount: nim('250'), blockNow: 16_172_560, policy: testnet })
    expect(active[1]).toEqual({ step: 'wait', etaMs: 0, done: false })
    expect(active[2]).toEqual({ step: 'retire', done: false })
  })

  it('rejects amounts it cannot plan', () => {
    expect(() => unstakeSteps({ staker: deactivated(), amount: 0n, blockNow: 1, policy: testnet })).toThrow(RangeError)
    expect(() => unstakeSteps({ staker: deactivated(), amount: nim('251'), blockNow: 1, policy: testnet })).toThrow(RangeError)
  })
})

describe('transaction amounts', () => {
  it('no deactivation when enough is inactive already', () => {
    expect(deactivateTarget(deactivated(), nim('250'))).toBeNull()
    expect(deactivateTarget(staker({ activeLuna: nim('250') }), nim('250'))).toEqual({ newActive: 0n, resetsWait: false })
    expect(deactivateTarget(staker({ activeLuna: nim('400') }), nim('150'))).toEqual({ newActive: nim('250'), resetsWait: false })
  })

  it('retire takes what is not retired yet; remove always takes all retired stake', () => {
    expect(retireAmount(deactivated(), nim('250'))).toBe(nim('250'))
    expect(retireAmount(deactivated({ retiredLuna: nim('50') }), nim('250'))).toBe(nim('200'))
    // a partial remove was dropped on testnet (C5); only the full retired balance goes through (C6)
    expect(removeAmount(staker({ retiredLuna: nim('150'), inactiveLuna: nim('100'), inactiveFrom: INACTIVE_FROM }))).toBe(nim('150'))
  })
})

describe('checkUnstake', () => {
  it('unstaking everything is fine', () => {
    expect(checkUnstake({ staker: staker({ activeLuna: nim('250') }), amount: nim('250') })).toBe('ok')
  })

  it('leaving under 100 NIM staked is LEAVES_DUST (testnet C3: retire 200 of 250 failed)', () => {
    expect(checkUnstake({ staker: deactivated(), amount: nim('200') })).toBe('LEAVES_DUST')
    expect(guardRemove({ activeAfter: nim('50'), removing: nim('200') })).toBe('LEAVES_DUST')
  })

  it('leaving exactly 100 NIM is fine (testnet C4: retire 150 of 250 went through)', () => {
    expect(checkUnstake({ staker: deactivated(), amount: nim('150') })).toBe('ok')
  })

  it('more than the staker holds, or nothing, is INVALID_AMOUNT', () => {
    expect(checkUnstake({ staker: deactivated(), amount: nim('251') })).toBe('INVALID_AMOUNT')
    expect(checkUnstake({ staker: deactivated(), amount: 0n })).toBe('INVALID_AMOUNT')
  })
})

describe('switchPoolPlan', () => {
  const at = (blockNow: number) => ({ blockNow, policy: testnet })

  it('with active stake the pool cannot change yet (testnet A2 failed): deactivate, wait, then switch', () => {
    const plan = switchPoolPlan(staker({ activeLuna: nim('200') }), at(16_172_345))
    expect(plan).toEqual({
      kind: 'deactivate-first',
      steps: [
        { step: 'deactivate', done: false },
        { step: 'wait', readyAtBlock: RELEASE, etaMs: (RELEASE - 16_172_345) * 1_000, done: false },
      ],
    })
  })

  it('inactive but still locked is not enough either (testnet A4 failed)', () => {
    const plan = switchPoolPlan(staker({ inactiveLuna: nim('200'), inactiveFrom: INACTIVE_FROM }), at(16_172_352))
    expect(plan).toEqual({
      kind: 'deactivate-first',
      steps: [
        { step: 'deactivate', done: true },
        { step: 'wait', readyAtBlock: RELEASE, etaMs: (RELEASE - 16_172_352) * 1_000, done: false },
      ],
    })
  })

  it('once the inactive stake is released, the switch is one transaction', () => {
    expect(switchPoolPlan(staker({ inactiveLuna: nim('200'), inactiveFrom: INACTIVE_FROM }), at(RELEASE))).toEqual({ kind: 'direct' })
  })

  it('a staker holding only retired stake can switch directly', () => {
    expect(switchPoolPlan(staker({ retiredLuna: nim('200') }), at(16_172_352))).toEqual({ kind: 'direct' })
  })

  // is_inactive_stake_released checks the jail for any delegated staker, even with nothing inactive.
  it('a retired-only staker of a jailed pool waits for the jail too', () => {
    const jailedFrom = 16_200_000
    const jailEnd = jailedFrom + 8 * 43_200 + 1
    expect(switchPoolPlan(staker({ retiredLuna: nim('200') }), { ...at(16_172_352), jailedFrom })).toEqual({
      kind: 'deactivate-first',
      steps: [
        { step: 'deactivate', done: true },
        { step: 'wait', readyAtBlock: jailEnd, etaMs: (jailEnd - 16_172_352) * 1_000, done: false },
      ],
    })
    expect(switchPoolPlan(staker({ retiredLuna: nim('200') }), { ...at(jailEnd), jailedFrom })).toEqual({ kind: 'direct' })
  })

  it('a staker without a pool can pick one directly (testnet C7)', () => {
    expect(switchPoolPlan(staker({ delegation: '', inactiveLuna: nim('100'), inactiveFrom: INACTIVE_FROM }), at(16_172_767))).toEqual({
      kind: 'direct',
    })
  })

  it('a jailed pool keeps the stake locked until its jail ends', () => {
    const plan = switchPoolPlan(staker({ inactiveLuna: nim('200'), inactiveFrom: INACTIVE_FROM }), { ...at(RELEASE), jailedFrom: 16_200_000 })
    expect(plan).toMatchObject({ kind: 'deactivate-first', steps: [{ done: true }, { done: false, readyAtBlock: 16_200_000 + 8 * 43_200 + 1 }] })
  })
})
