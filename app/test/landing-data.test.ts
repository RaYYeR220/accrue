import { VERDICTS } from '@accrue/shared'
import { describe, expect, it } from 'vitest'
import { describeCheck, describePosition, parseCheck, parsePools, parsePosition } from '../src/landing/data'
import { SNAPSHOT } from '../src/landing/snapshot'

const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
const STAKER = 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST'

const siamRow = {
  address: SIAM,
  name: 'Siam Pool',
  fee: 0.03,
  payoutType: 'restake',
  schedule: 'Every 3 hours',
  balanceLuna: '46633342900000',
  stakers: 104,
  accent: '#1f3047',
  verdict: 'PAID_AS_PROMISED',
  ratio: 0.9748,
  expectedRatio: 0.97,
  lastPayoutTs: 1_762_500_000_000,
  reasons: ['Paid 97.5% of earnings against 97.0% promised.'],
}

describe('parsePools', () => {
  it('reads a well-formed answer', () => {
    const out = parsePools({ asOf: 1_762_510_000_000, windowDays: 7, pools: [siamRow] })
    expect(out.source).toBe('live')
    expect(out.asOf).toBe(1_762_510_000_000)
    expect(out.windowDays).toBe(7)
    expect(out.pools).toHaveLength(1)
    expect(out.pools[0]).toEqual({
      address: SIAM,
      name: 'Siam Pool',
      fee: 0.03,
      payoutType: 'restake',
      schedule: 'Every 3 hours',
      balanceLuna: 46_633_342_900_000n,
      stakers: 104,
      accent: '#1f3047',
      verdict: 'PAID_AS_PROMISED',
      ratio: 0.9748,
      expectedRatio: 0.97,
      lastPayoutTs: 1_762_500_000_000,
      reasons: ['Paid 97.5% of earnings against 97.0% promised.'],
    })
  })

  it('accepts every verdict code and a null fee', () => {
    const pools = VERDICTS.map((verdict, i) => ({ ...siamRow, address: SNAPSHOT.pools[i]!.address, name: `P${i}`, verdict, fee: i === 0 ? null : 0.05 }))
    const out = parsePools({ asOf: 1, windowDays: 7, pools })
    expect(out.pools.map(p => p.verdict)).toEqual([...VERDICTS])
    expect(out.pools[0]!.fee).toBeNull()
  })

  it('never invents a verdict: an unknown code becomes null', () => {
    const out = parsePools({ asOf: 1, windowDays: 7, pools: [{ ...siamRow, verdict: 'GREAT' }] })
    expect(out.pools[0]!.verdict).toBeNull()
  })

  it('drops rows it cannot trust and keeps the rest', () => {
    const out = parsePools({
      asOf: 1,
      windowDays: 7,
      pools: [
        siamRow,
        { ...siamRow, address: 'NQ00 nonsense' },
        { ...siamRow, balanceLuna: '-5' },
        { ...siamRow, name: '' },
        { ...siamRow, payoutType: 'sometimes' },
        'row',
      ],
    })
    expect(out.pools.map(p => p.name)).toEqual(['Siam Pool'])
  })

  it('keeps the first row when an address appears twice', () => {
    const out = parsePools({ asOf: 1, windowDays: 7, pools: [siamRow, { ...siamRow, name: 'Siam again', address: SIAM.replace(/ /g, '').toLowerCase() }] })
    expect(out.pools.map(p => p.name)).toEqual(['Siam Pool'])
  })

  it('keeps colours to plain hex so nothing else reaches CSS or the canvas', () => {
    const out = parsePools({ asOf: 1, windowDays: 7, pools: [{ ...siamRow, accent: 'red;background:url(x)' }] })
    expect(out.pools[0]!.accent).toBeNull()
  })

  it('drops non-string reasons', () => {
    const out = parsePools({ asOf: 1, windowDays: 7, pools: [{ ...siamRow, reasons: ['ok', 3, null] }] })
    expect(out.pools[0]!.reasons).toEqual(['ok'])
  })

  it('throws on a malformed envelope so the caller can fall back', () => {
    expect(() => parsePools(null)).toThrow()
    expect(() => parsePools({ asOf: 'x', windowDays: 7, pools: [] })).toThrow()
    expect(() => parsePools({ asOf: 1, windowDays: 7, pools: 'x' })).toThrow()
    expect(() => parsePools({ asOf: 1, windowDays: 7, pools: [] })).toThrow()
  })
})

describe('SNAPSHOT', () => {
  it('holds the 21 listed pools from the dated facts pack, sorted by stake, with no verdicts', () => {
    expect(SNAPSHOT.source).toBe('snapshot')
    expect(new Date(SNAPSHOT.asOf).toISOString().slice(0, 10)).toBe('2026-11-07')
    expect(SNAPSHOT.pools).toHaveLength(21)
    expect(SNAPSHOT.pools.every(p => p.verdict === null && p.reasons.length === 0)).toBe(true)
    const stakes = SNAPSHOT.pools.map(p => p.balanceLuna)
    expect([...stakes].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(stakes)
    expect(SNAPSHOT.pools.find(p => p.name === 'Garuda Pool')).toMatchObject({ fee: 0.05, payoutType: 'restake', schedule: 'Every 12 hours', stakers: 256 })
  })
})

const check = {
  staker: { activeLuna: '1200000000', inactiveLuna: '0', inactiveFrom: null, retiredLuna: '0', delegation: SIAM },
  pool: siamRow,
  expectedLuna: '1000000',
  receivedLuna: '990000',
  verdict: 'PAID_AS_PROMISED',
  pct: 0.99,
  windowDays: 7,
}

describe('parseCheck', () => {
  it('reads a staker with a verdict', () => {
    const out = parseCheck(check)
    expect(out.staker).toEqual({ activeLuna: 1_200_000_000n, inactiveLuna: 0n, inactiveFrom: null, retiredLuna: 0n, delegation: SIAM })
    expect(out.pool?.name).toBe('Siam Pool')
    expect(out.expectedLuna).toBe(1_000_000n)
    expect(out.receivedLuna).toBe(990_000n)
    expect(out.verdict).toBe('PAID_AS_PROMISED')
    expect(out.pct).toBe(0.99)
  })

  it('accepts luna as safe integers too', () => {
    const out = parseCheck({ ...check, staker: { ...check.staker, activeLuna: 1_200_000_000 } })
    expect(out.staker?.activeLuna).toBe(1_200_000_000n)
  })

  it('reads an address that is not staking', () => {
    expect(parseCheck({ staker: null, windowDays: 7 })).toEqual({
      staker: null,
      pool: null,
      expectedLuna: null,
      receivedLuna: null,
      verdict: null,
      pct: null,
      windowDays: 7,
    })
  })

  it('throws on a malformed answer', () => {
    expect(() => parseCheck({ windowDays: 7 })).toThrow()
    expect(() => parseCheck({ staker: { activeLuna: 'lots' }, windowDays: 7 })).toThrow()
  })
})

describe('describeCheck', () => {
  it('not staking', () => {
    expect(describeCheck(parseCheck({ staker: null, windowDays: 7 }))).toEqual({ kind: 'notStaking' })
  })

  it('staking with a validator that is not one of the listed pools', () => {
    const out = describeCheck(parseCheck({ ...check, pool: undefined, verdict: undefined, expectedLuna: undefined, receivedLuna: undefined, pct: undefined }))
    expect(out).toEqual({ kind: 'unlisted', delegation: SIAM, activeLuna: 1_200_000_000n })
  })

  it('a verdict with its numbers', () => {
    const out = describeCheck(parseCheck(check))
    expect(out).toMatchObject({ kind: 'verdict', verdict: 'PAID_AS_PROMISED', expectedLuna: 1_000_000n, receivedLuna: 990_000n, pct: 0.99 })
  })

  it("the worker's answer as it is sent: the staker window it measured, its bounds, the pool's reach and a behind-data reason", () => {
    const body = {
      ...check,
      pool: { ...siamRow, reachTs: 1_794_065_410_042, reasons: [...siamRow.reasons, 'Data as of 2026-11-07T12:10:10Z; indexing is behind'] },
      windowDays: 5.8,
      fromTs: 1_794_009_600_000,
      toTs: 1_794_510_720_000,
    }
    const out = describeCheck(parseCheck(body))
    expect(out).toMatchObject({ kind: 'verdict', windowDays: 5.8 })
    expect(out.kind === 'verdict' && out.pool.reasons).toEqual(['Paid 97.5% of earnings against 97.0% promised.', 'Data as of 2026-11-07T12:10:10Z; indexing is behind'])
  })

  it('a staker in a listed pool without a verdict from the API keeps no verdict', () => {
    const out = describeCheck(parseCheck({ ...check, verdict: undefined, pct: undefined, expectedLuna: undefined, receivedLuna: undefined }))
    expect(out).toMatchObject({ kind: 'verdict', verdict: null, pct: null })
  })
})

describe('parsePosition / describePosition', () => {
  const body = {
    assets: {
      USDT0: { aTokenBalance: '12345678', scaledFromAccrue: '12000000', principal: '12000000', earned: '345678' },
      USDC: { aTokenBalance: '0', scaledFromAccrue: '0', principal: '0', earned: '0' },
    },
  }

  it('reads assets in 6-decimal units', () => {
    expect(parsePosition(body).assets.USDT0).toEqual({ aTokenBalance: 12_345_678n, scaledFromAccrue: 12_000_000n, principal: 12_000_000n, earned: 345_678n })
  })

  it('ignores unknown assets and throws on garbage', () => {
    expect(Object.keys(parsePosition({ assets: { ...body.assets, DAI: body.assets.USDT0 } }).assets).sort()).toEqual(['USDC', 'USDT0'])
    expect(() => parsePosition({ assets: { USDT0: { aTokenBalance: 'x' } } })).toThrow()
    expect(() => parsePosition({})).toThrow()
  })

  it('lists only assets with a balance, and says when there is none', () => {
    expect(describePosition(parsePosition(body))).toEqual({
      kind: 'position',
      rows: [{ asset: 'USDT0', aTokenBalance: 12_345_678n, principal: 12_000_000n, earned: 345_678n }],
    })
    expect(describePosition(parsePosition({ assets: { USDC: body.assets.USDC } }))).toEqual({ kind: 'empty' })
  })
})
