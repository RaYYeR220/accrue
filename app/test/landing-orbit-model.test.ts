import { describe, expect, it } from 'vitest'
import { chipPools, defaultPoolId, dotCounts, payoutPlan, toOrbitPool } from '../src/landing/orbit/model'
import { SNAPSHOT } from '../src/landing/snapshot'

const pools = SNAPSHOT.pools.map(toOrbitPool)
const byName = (n: string) => pools.find(p => p.name === n)!

describe('toOrbitPool', () => {
  it('maps each published schedule to how the hero animates it', () => {
    expect(byName('Garuda Pool')).toMatchObject({ kind: 'R', mode: 'periodic', h: 12, fee: 0.05, stake: 257_956_030, stakers: 256 })
    expect(byName('NimiqHub Staking')).toMatchObject({ mode: 'stream', h: 1 / 60 })
    expect(byName('Nimiq Marketing Pool')).toMatchObject({ mode: 'periodic', h: 1 })
    expect(byName('CHIPMUNK POOL')).toMatchObject({ kind: 'D', mode: 'periodic', h: 6 })
    expect(byName('NimiqPocket')).toMatchObject({ mode: 'instant', h: null, thresholdNim: 10 })
    expect(byName('Private Whalidator')).toMatchObject({ kind: 'N', mode: 'none', fee: null })
    expect(byName('Nimiq Base Staking')).toMatchObject({ mode: 'unpub', h: null })
  })

  it('carries the verdict as given, which in the snapshot is none', () => {
    expect(pools.every(p => p.verdict === null)).toBe(true)
  })
})

describe('chips and the default pool', () => {
  it('uses the five named pools, Garuda first', () => {
    expect(chipPools(pools).map(c => c.short)).toEqual(['Garuda', 'Mint', '$NIM_pool', 'Marketing', 'NimiqHub'])
    expect(defaultPoolId(pools)).toBe(byName('Garuda Pool').id)
  })

  it('falls back to the biggest paying pools when the named ones are missing', () => {
    const others = pools.filter(p => !['Garuda Pool', 'Mint Pool', '$NIM_pool', 'Nimiq Marketing Pool'].includes(p.name))
    const chips = chipPools(others)
    expect(chips).toHaveLength(5)
    expect(chips.every(c => c.pool.mode === 'periodic' || c.pool.mode === 'stream')).toBe(true)
    expect(defaultPoolId(others)).toBe(chips[0]!.pool.id)
  })
})

describe('dotCounts', () => {
  it('caps each pool and the whole orbit, whatever the API claims', () => {
    expect(dotCounts([5_000_000])).toEqual([300])
    const many = dotCounts(Array.from({ length: 40 }, () => 10_000))
    expect(many.every(n => n <= 300)).toBe(true)
    expect(many.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500)
  })

  it('leaves small pools alone and keeps every staked pool visible', () => {
    expect(dotCounts([10, 20, 0])).toEqual([10, 20, 0])
    const snap = dotCounts(SNAPSHOT.pools.map(p => p.stakers))
    expect(snap.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500)
    expect(snap.every(n => n >= 1)).toBe(true)
    // bigger pools still look bigger
    expect(snap[0]!).toBeGreaterThan(snap[snap.length - 1]!)
  })

  it('treats garbage as no dots', () => {
    expect(dotCounts([Number.NaN, -3, Infinity])).toEqual([0, 0, 300])
  })
})

describe('payoutPlan', () => {
  const GROSS = 0.08

  it('Garuda: 14 payouts in the week, 8 landed, about 1.04 NIM each on 10,000', () => {
    const p = payoutPlan(byName('Garuda Pool'), 10_000, GROSS)
    expect(p).toMatchObject({ ok: true, why: 'ok', cont: false, direct: false, N: 14, k: 8 })
    expect(p.stakeNow).toBeCloseTo(10_008.33, 2)
    expect(p.per).toBeCloseTo(1.04, 2)
  })

  it('a minute-paying pool streams; an instant pool pays at its threshold', () => {
    expect(payoutPlan(byName('NimiqHub Staking'), 10_000, GROSS)).toMatchObject({ ok: true, cont: true, N: 10_080 })
    const pocket = payoutPlan(byName('NimiqPocket'), 10_000, GROSS)
    expect(pocket.ok).toBe(true)
    expect(pocket.h).toBeCloseTo(10 / (10_000 * GROSS * 0.99) * 8760, 6)
  })

  it('no rhythm to draw for pools without payouts or a schedule', () => {
    expect(payoutPlan(byName('Private Whalidator'), 10_000, GROSS)).toMatchObject({ ok: false, why: 'none' })
    expect(payoutPlan(byName('Nimiq Base Staking'), 10_000, GROSS)).toMatchObject({ ok: false, why: 'unpub' })
  })

  it('a fee that keeps everything gives no yield to draw, and no NaN or Infinity anywhere', () => {
    for (const base of [byName('NimiqPocket'), byName('Garuda Pool'), byName('NimiqHub Staking')]) {
      const p = payoutPlan({ ...base, fee: 1 }, 10_000, GROSS)
      expect(p).toMatchObject({ ok: false, why: 'noYield' })
      for (const v of [p.net, p.h, p.N, p.k, p.stakeNow, p.paid, p.per]) expect(Number.isFinite(v)).toBe(true)
    }
  })
})
