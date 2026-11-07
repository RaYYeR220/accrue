import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildPoolWindow,
  classifyTx,
  parseSchedule,
  poolVerdict,
  RUN_GAP_BLOCKS,
  userExpected,
  userVerdict,
  type NimTx,
  type PoolWindow,
} from '../src/index'

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as { address: string; txs: NimTx[] }
const siam = load('siam-2026-11-07.json')
const garuda = load('garuda-2026-11-07.json')

const SIAM = { rewardAddress: siam.address, fee: 0.03, payoutType: 'restake' as const, scheduleMs: parseSchedule('Every 3 hours') }
const GARUDA = { rewardAddress: garuda.address, fee: 0.05, payoutType: 'restake' as const, scheduleMs: parseSchedule('Every 12 hours') }

const HOUR = 3_600_000
const GARUDA_FULL_CYCLES = 7
const base: PoolWindow = {
  earned: 1_000_000n, paidRestake: 970_000n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n,
  cycles: 10, lastPayoutTs: 1_000_000_000, windowStartTs: 0, windowEndTs: 1_000_000_000,
}
const cfg = { fee: 0.03, payoutType: 'restake' as const, scheduleMs: 3 * HOUR }

describe('classifyTx', () => {
  it('Siam: coinbase is EARNED, restake payouts carry the staker', () => {
    const kinds = new Map<string, number>()
    for (const tx of siam.txs) {
      const c = classifyTx(tx, SIAM, () => undefined)
      kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
    }
    expect(kinds.get('EARNED')).toBeGreaterThan(500)
    expect(kinds.get('RESTAKE_PAYOUT')).toBeGreaterThan(1000)
    const known = siam.txs.find((t) => t.recipientData === '06e73a195f75f58532aa29d44dfac38aab63378f5b')!
    const c = classifyTx(known, SIAM, () => undefined)
    expect(c.kind).toBe('RESTAKE_PAYOUT')
    expect(c.staker).toBe('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')
    expect(c.value).toBe(BigInt(known.value))
  })

  it('Garuda: basic outgoing txs are DIRECT_PAYOUT, unverified without a staker oracle', () => {
    const basic = garuda.txs.filter((t) => t.from === garuda.address && t.toType === 0)
    expect(basic.length).toBeGreaterThan(50)
    for (const tx of basic.slice(0, 20)) {
      const c = classifyTx(tx, GARUDA, () => undefined)
      expect(c.kind).toBe('DIRECT_PAYOUT')
      expect(c.unverified).toBe(true)
    }
  })

  it('uses the staker oracle for basic outgoing txs', () => {
    const tx = garuda.txs.find((t) => t.from === garuda.address && t.toType === 0)!
    expect(classifyTx(tx, GARUDA, () => true)).toMatchObject({ kind: 'DIRECT_PAYOUT' })
    expect(classifyTx(tx, GARUDA, () => true).unverified).toBeFalsy()
    expect(classifyTx(tx, GARUDA, () => false).kind).toBe('OTHER_OUT')
  })

  it('restake payouts go through the staker oracle', () => {
    const tx = siam.txs.find((t) => t.recipientData === '06e73a195f75f58532aa29d44dfac38aab63378f5b')!
    expect(classifyTx(tx, SIAM, () => undefined)).toMatchObject({ kind: 'RESTAKE_PAYOUT', unverified: true })
    expect(classifyTx(tx, SIAM, () => true).unverified).toBeFalsy()
    expect(classifyTx(tx, SIAM, () => false).kind).toBe('OTHER_OUT')
  })

  it('other flows', () => {
    const inc: NimTx = { ...siam.txs[0]!, from: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', toType: 0 }
    expect(classifyTx(inc, SIAM, () => undefined).kind).toBe('OTHER_IN')
    const out: NimTx = { ...inc, from: siam.address, to: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', toType: 3, recipientData: '07' }
    expect(classifyTx(out, SIAM, () => undefined).kind).toBe('OTHER_OUT')
  })
})

// Independent check of `cycles`: count payouts per staker straight from the raw txs between the
// window bounds the builder reports, then take the median. No run/cluster logic involved.
function medianPayoutsPerStaker(file: { address: string; txs: NimTx[] }, w: PoolWindow) {
  const per = new Map<string, number>()
  for (const t of file.txs) {
    if (t.from !== file.address || t.timestamp <= w.windowStartTs || t.timestamp > w.windowEndTs) continue
    const key = t.toType === 3 ? t.recipientData.slice(2).toLowerCase() : t.to
    if (t.toType !== 3 && t.toType !== 0) continue
    per.set(key, (per.get(key) ?? 0) + 1)
  }
  const c = [...per.values()].sort((x, y) => x - y)
  const m = c.length >> 1
  return c.length % 2 ? c[m]! : Math.floor((c[m - 1]! + c[m]!) / 2)
}

describe('buildPoolWindow', () => {
  it('Siam: cycles is the per-staker payout count (~24), not the number of batches', () => {
    const w = buildPoolWindow(siam.txs, SIAM, () => undefined)
    expect(w.cycles).toBe(medianPayoutsPerStaker(siam, w))
    expect(w.cycles).toBeGreaterThanOrEqual(20)
    expect(w.cycles).toBeLessThanOrEqual(28)
    expect(w.lastPayoutTs).toBe(siam.txs.find((t) => t.from === siam.address)!.timestamp)
  })

  it('Garuda full fixture: restake and direct legs of one run count once', () => {
    const w = buildPoolWindow(garuda.txs, GARUDA, () => undefined)
    expect(w.cycles).toBe(medianPayoutsPerStaker(garuda, w))
    expect(w.cycles).toBe(GARUDA_FULL_CYCLES)
    expect(w.paidDirect).toBeGreaterThan(0n)
    const v = poolVerdict(w, GARUDA, w.lastPayoutTs! + 60_000)
    expect(v.verdict).toBe('PAID_AS_PROMISED')
    expect(v.ratio).toBeCloseTo(0.9499, 3)
    expect(v.reasons.join(' ')).toContain('not checked against the staker set')
  })

  it('Garuda newest 2000 txs is NOT_ENOUGH_DATA', () => {
    const newest = [...garuda.txs].sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 2000)
    const w = buildPoolWindow(newest, GARUDA, () => undefined)
    expect(w.cycles).toBeLessThan(3)
    expect(poolVerdict(w, GARUDA, w.lastPayoutTs! + 60_000).verdict).toBe('NOT_ENOUGH_DATA')
  })

  it('works regardless of input order', () => {
    const a = buildPoolWindow(siam.txs, SIAM, () => undefined)
    const b = buildPoolWindow([...siam.txs].reverse(), SIAM, () => undefined)
    expect(b).toEqual(a)
  })

  it('a single run still reports lastPayoutTs', () => {
    const first = siam.txs.filter((t) => t.from === siam.address)
    const w = buildPoolWindow(first.slice(0, 3), SIAM, () => undefined)
    expect(w.lastPayoutTs).toBe(Math.max(...first.slice(0, 3).map((t) => t.timestamp)))
    expect(w.cycles).toBe(0)
  })

  // data that ends inside a payout run would count the run's earnings without all of its payouts
  describe('closes only at a complete run', () => {
    const sorted = [...garuda.txs].sort((a, b) => a.blockNumber - b.blockNumber)
    const pays = sorted.filter((t) => t.from === garuda.address && t.to !== garuda.address)
    const runs: NimTx[][] = []
    for (const t of pays) {
      const last = runs[runs.length - 1]
      if (last && t.blockNumber - last[last.length - 1]!.blockNumber < RUN_GAP_BLOCKS) last.push(t)
      else runs.push([t])
    }
    const lastRun = runs[runs.length - 1]!
    const prevEnd = runs[runs.length - 2]![runs[runs.length - 2]!.length - 1]!

    it('Garuda cut at any block of its last run is never SHORT and ends at the previous run', () => {
      for (const b of [...new Set(lastRun.map((t) => t.blockNumber))]) {
        const cut = sorted.filter((t) => t.blockNumber <= b)
        const w = buildPoolWindow(cut, GARUDA, () => true)
        expect(w.windowEndTs).toBe(prevEnd.timestamp)
        expect(poolVerdict(w, GARUDA, w.windowEndTs).verdict).not.toBe('SHORT')
      }
    })

    it('the last run counts once the data reaches RUN_GAP_BLOCKS past it', () => {
      const end = lastRun[lastRun.length - 1]!
      const cut = sorted.filter((t) => t.blockNumber <= end.blockNumber)
      expect(buildPoolWindow(cut, GARUDA, () => true).windowEndTs).toBe(prevEnd.timestamp)
      const known = buildPoolWindow(cut, GARUDA, () => true, { reachBlock: end.blockNumber + RUN_GAP_BLOCKS })
      expect(known.windowEndTs).toBe(end.timestamp)
    })
  })

  it('unverified payouts are tracked and cleared by the staker oracle', () => {
    expect(buildPoolWindow(siam.txs, SIAM, () => undefined).paidUnverified).toBeGreaterThan(0n)
    const verified = buildPoolWindow(siam.txs, SIAM, () => true)
    expect(verified.paidUnverified).toBe(0n)
  })
})

describe('poolVerdict on recorded mainnet data', () => {
  const w = buildPoolWindow(siam.txs, SIAM, () => undefined)
  const now = w.lastPayoutTs! + 60_000

  it('Siam is PAID_AS_PROMISED within 0.97 +- 0.02', () => {
    const v = poolVerdict(w, SIAM, now)
    expect(v.ratio).toBeGreaterThan(0.95)
    expect(v.ratio).toBeLessThan(0.99)
    expect(v.verdict).toBe('PAID_AS_PROMISED')
  })

  it('negative control: every payout x0.8 is SHORT', () => {
    const scaled = siam.txs.map((t) => (t.from === siam.address ? { ...t, value: Math.floor(t.value * 0.8) } : t))
    const w2 = buildPoolWindow(scaled, SIAM, () => undefined)
    const v = poolVerdict(w2, SIAM, now)
    expect(v.ratio).toBeLessThan(0.8)
    expect(v.verdict).toBe('SHORT')
  })

  it('Garuda verdict is computed from restake plus direct payouts', () => {
    const gw = buildPoolWindow(garuda.txs, GARUDA, () => undefined)
    const v = poolVerdict(gw, GARUDA, gw.lastPayoutTs! + 60_000)
    expect(gw.cycles).toBeGreaterThanOrEqual(3)
    expect(v.ratio).not.toBeNull()
    expect(['PAID_AS_PROMISED', 'SHORT', 'CANT_VERIFY_ROUTED', 'NOT_ENOUGH_DATA']).toContain(v.verdict)
  })
})

describe('poolVerdict rules', () => {
  const now = base.lastPayoutTs! + HOUR

  it('baseline is PAID_AS_PROMISED', () => expect(poolVerdict(base, cfg, now).verdict).toBe('PAID_AS_PROMISED'))
  it('payoutType none -> NO_PAYOUTS_BY_DESIGN', () =>
    expect(poolVerdict(base, { ...cfg, payoutType: 'none' }, now).verdict).toBe('NO_PAYOUTS_BY_DESIGN'))
  it('2 cycles -> NOT_ENOUGH_DATA', () => expect(poolVerdict({ ...base, cycles: 2 }, cfg, now).verdict).toBe('NOT_ENOUGH_DATA'))
  it('earned 0 -> NOT_ENOUGH_DATA', () =>
    expect(poolVerdict({ ...base, earned: 0n, paidRestake: 0n }, cfg, now).verdict).toBe('NOT_ENOUGH_DATA'))
  it('30 h since last payout on a 12 h schedule -> BEHIND_SCHEDULE', () =>
    expect(poolVerdict(base, { ...cfg, scheduleMs: 12 * HOUR }, base.lastPayoutTs! + 30 * HOUR).verdict).toBe('BEHIND_SCHEDULE'))
  it('24 h since last payout on a 12 h schedule is still fine', () =>
    expect(poolVerdict(base, { ...cfg, scheduleMs: 12 * HOUR }, base.lastPayoutTs! + 24 * HOUR).verdict).toBe('PAID_AS_PROMISED'))
  it('otherOut 40 % -> CANT_VERIFY_ROUTED', () =>
    expect(poolVerdict({ ...base, otherOut: 400_000n, paidRestake: 570_000n }, cfg, now).verdict).toBe('CANT_VERIFY_ROUTED'))
  it('ratio 0.80 with clean flows -> SHORT', () => {
    const v = poolVerdict({ ...base, paidRestake: 800_000n }, cfg, now)
    expect(v.verdict).toBe('SHORT')
    expect(v.expectedRatio).toBeCloseTo(0.97)
  })
  it('SHORT is never issued with other outflow >= 5 %', () =>
    expect(poolVerdict({ ...base, paidRestake: 700_000n, otherOut: 60_000n }, cfg, now).verdict).not.toBe('SHORT'))
  it('shortfall between 2 and 5 pp is inconclusive with its own reason', () => {
    const v = poolVerdict({ ...base, paidRestake: 930_000n }, cfg, now)
    expect(v.verdict).toBe('NOT_ENOUGH_DATA')
    expect(v.reasons.join(' ')).toContain('uncertainty band')
  })
  it('big shortfall with 5-30 % other outflow says other outflows are too large', () => {
    const v = poolVerdict({ ...base, paidRestake: 650_000n, otherOut: 100_000n }, cfg, now)
    expect(v.verdict).toBe('NOT_ENOUGH_DATA')
    expect(v.reasons.join(' ')).toContain('Other outflows too large')
  })
  it('unverified payouts add a reason', () => {
    const v = poolVerdict({ ...base, paidUnverified: 200_000n }, cfg, now)
    expect(v.verdict).toBe('PAID_AS_PROMISED')
    expect(v.reasons.join(' ')).toContain('not checked against the staker set')
  })
  it('single cycle but last payout far past schedule -> BEHIND_SCHEDULE', () =>
    expect(poolVerdict({ ...base, cycles: 0 }, { ...cfg, scheduleMs: 12 * HOUR }, base.lastPayoutTs! + 30 * HOUR).verdict).toBe('BEHIND_SCHEDULE'))
  it('direct payouts count toward the ratio', () =>
    expect(poolVerdict({ ...base, paidRestake: 500_000n, paidDirect: 470_000n }, cfg, now).verdict).toBe('PAID_AS_PROMISED'))
})

describe('user math', () => {
  it('userExpected is the stake share of earned net of fee', () => {
    expect(userExpected({ userActiveStake: 1_000n, poolStake: 10_000n, poolEarned: 1_000_000n, fee: 0.03 })).toBe(97_000n)
    expect(userExpected({ userActiveStake: 0n, poolStake: 10_000n, poolEarned: 1_000_000n, fee: 0.03 })).toBe(0n)
    expect(userExpected({ userActiveStake: 5n, poolStake: 0n, poolEarned: 1_000_000n, fee: 0.03 })).toBe(0n)
  })
  it('userVerdict', () => {
    expect(userVerdict({ expected: 1000n, received: 990n, cycles: 5 })).toEqual({ verdict: 'PAID_AS_PROMISED', pct: 0.99 })
    expect(userVerdict({ expected: 1000n, received: 800n, cycles: 5 }).verdict).toBe('SHORT')
    expect(userVerdict({ expected: 1000n, received: 800n, cycles: 2 })).toEqual({ verdict: 'NOT_ENOUGH_DATA', pct: null })
    expect(userVerdict({ expected: 0n, received: 0n, cycles: 9 })).toEqual({ verdict: 'NOT_ENOUGH_DATA', pct: null })
  })
})
