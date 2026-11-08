import { describe, expect, it } from 'vitest'
import { chipPools, defaultPoolId, toOrbitPool } from '../src/landing/orbit/model'
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
