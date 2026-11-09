import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildPoolWindow,
  buildPoolWindows,
  classifyTx,
  parseSchedule,
  payoutCycleMs,
  poolVerdict,
  RUN_GAP_BLOCKS,
  runGapBlocks,
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
// the fixture ends 9,888 blocks after its last run, less than Garuda's run gap (a quarter of its
// 12 h cycle), so that run is not known to be complete and the window closes one run earlier
const GARUDA_FULL_CYCLES = 6
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

    it('the last run counts once the data reaches the run gap (a quarter of the 12 h cycle) past it', () => {
      const end = lastRun[lastRun.length - 1]!
      const cut = sorted.filter((t) => t.blockNumber <= end.blockNumber)
      const gap = runGapBlocks(12 * HOUR)
      expect(gap).toBe(3 * 3600)
      expect(buildPoolWindow(cut, GARUDA, () => true).windowEndTs).toBe(prevEnd.timestamp)
      expect(buildPoolWindow(cut, GARUDA, () => true, { reachBlock: end.blockNumber + RUN_GAP_BLOCKS }).windowEndTs).toBe(prevEnd.timestamp)
      const known = buildPoolWindow(cut, GARUDA, () => true, { reachBlock: end.blockNumber + gap })
      expect(known.windowEndTs).toBe(end.timestamp)
    })

    it('measures the payout cycle by value: Garuda 12 h, Siam about 30 min', () => {
      const cycle = (f: typeof garuda, cfg: { rewardAddress: string }) => {
        const pays = f.txs.filter((t) => t.from === f.address && t.to !== f.address)
        const span = Math.max(...f.txs.map((t) => t.timestamp)) - Math.min(...f.txs.map((t) => t.timestamp))
        return payoutCycleMs(pays.map((t) => ({ staker: t.toType === 3 ? t.recipientData : t.to, value: BigInt(t.value) })), span)! / HOUR
      }
      expect(cycle(garuda, GARUDA)).toBeGreaterThan(11)
      expect(cycle(garuda, GARUDA)).toBeLessThan(13)
      expect(cycle(siam, SIAM)).toBeGreaterThan(0.4)
      expect(cycle(siam, SIAM)).toBeLessThan(0.6)
    })
  })

  describe('slow payers and cut position', () => {
    // honest pools paying exactly 95 % of a 12 h cycle, spread over hours at a constant pace
    const REWARD = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
    const CFG = { rewardAddress: REWARD, fee: 0.05, payoutType: 'restake' as const, scheduleMs: null }
    const H = 3600
    const START = 3600 * 1_000_000
    let n = 0
    const mk = (block: number, from: string, to: string, value: number, data = '', toType = 0) =>
      ({ hash: `p${n++}`, blockNumber: block, timestamp: block * 1000, from, to, fromType: 0, toType, value, fee: 0, senderData: '', recipientData: data, relatedAddresses: [] }) as NimTx
    function pool(cycleH: number, spreadH: number, pays: number, seed: number) {
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
      const stakers = Array.from({ length: 120 }, (_, i) => ({ hex: (i + 16).toString(16).padStart(2, '0').repeat(20), stake: Math.pow(rnd(), -1.2) }))
      const total = stakers.reduce((a, s) => a + s.stake, 0)
      const txs: NimTx[] = []
      for (let b = START; b < START + 9 * 24 * H; b += 60) txs.push(mk(b, 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000', REWARD, 1_000_000))
      const offset = Math.floor(rnd() * cycleH * H)
      for (let T = START + cycleH * H + offset; T < START + 9 * 24 * H; T += cycleH * H) {
        const owed = ((cycleH * H) / 60) * 1_000_000 * pays
        const order = [...stakers].sort(() => rnd() - 0.5)
        const step = Math.floor((spreadH * H) / order.length)
        order.forEach((s, k) => txs.push(mk(T + k * step + 7, REWARD, 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001', Math.floor((owed * s.stake) / total), `06${s.hex}`, 3)))
      }
      return txs.sort((a, b) => a.blockNumber - b.blockNumber)
    }
    const sweep = (txs: NimTx[], cycleH: number, step: number) => {
      const end = START + 9 * 24 * H
      const verdicts: string[] = []
      let i = 0
      for (let cut = end - 2 * cycleH * H; cut < end; cut += step) {
        while (i < txs.length && txs[i]!.blockNumber <= cut) i++
        const part = txs.slice(0, i)
        const { window, earlier } = buildPoolWindows(part, CFG, () => true, { reachBlock: cut })
        verdicts.push(poolVerdict(window, CFG, cut * 1000, { earlier }).verdict)
      }
      return verdicts
    }

    it('a 12 h cycle paid over 10-11 h at a 300-330 s pace is never SHORT at any cut', () => {
      for (const spreadH of [10, 11]) for (const seed of [3, 7]) expect(sweep(pool(12, spreadH, 0.95, seed), 12, 600)).not.toContain('SHORT')
    }, 60_000)

    it('the same pool paying 80 % is SHORT at every cut once a cycle has completed', () => {
      const verdicts = sweep(pool(12, 2.5, 0.8, 5), 12, 600)
      expect(verdicts.filter((v) => v === 'SHORT').length).toBeGreaterThan(verdicts.length * 0.5)
      expect(verdicts).not.toContain('PAID_AS_PROMISED')
    }, 60_000)
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

  it('negative control: every payout x0.8 is SHORT, confirmed by the earlier window ends', () => {
    const scaled = siam.txs.map((t) => (t.from === siam.address ? { ...t, value: Math.floor(t.value * 0.8) } : t))
    const { window: w2, earlier } = buildPoolWindows(scaled, SIAM, () => undefined, { scheduleMs: SIAM.scheduleMs })
    expect(earlier.length).toBeGreaterThan(0)
    const v = poolVerdict(w2, SIAM, now, { earlier })
    expect(v.ratio).toBeLessThan(0.8)
    expect(v.verdict).toBe('SHORT')
    // a single window is never enough for SHORT
    expect(poolVerdict(w2, SIAM, now).verdict).toBe('NOT_ENOUGH_DATA')
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
  it('too few cycles: the reason states the earnings in NIM, never raw luna', () => {
    const v = poolVerdict({ ...base, cycles: 2, earned: 462_997_721n, paidRestake: 449_107_789n }, cfg, now)
    expect(v.reasons).toEqual(['Only 2 complete payout cycles with 4,629.98 NIM earned in the window; need at least 3.'])
    expect(poolVerdict({ ...base, cycles: 1, earned: 123_456_789_012n }, cfg, now).reasons).toEqual([
      'Only 1 complete payout cycle with 1,234,567.89 NIM earned in the window; need at least 3.',
    ])
    expect(poolVerdict({ ...base, cycles: 0, earned: 5_000_000n }, cfg, now).reasons).toEqual([
      'No complete payout cycle in the window yet (50 NIM earned); need at least 3.',
    ])
    expect(JSON.stringify(v)).not.toMatch(/luna/)
  })
  it('nothing earned in the window says so, whatever the cycle count', () => {
    for (const cycles of [0, 2, 5]) {
      expect(poolVerdict({ ...base, cycles, earned: 0n, paidRestake: 0n }, cfg, now).reasons).toEqual(['No rewards earned in the window yet.'])
    }
  })
  it('the unverified-recipients note appears from 0.05 % of earnings, not for a rounding sliver', () => {
    const note = (paidUnverified: bigint) => poolVerdict({ ...base, earned: 10_000_000n, paidRestake: 9_700_000n, paidUnverified }, cfg, now).reasons
    expect(note(0n).join(' ')).not.toMatch(/not checked/)
    expect(note(4_999n).join(' ')).not.toMatch(/not checked/)
    expect(note(5_000n)).toContain('0.1% of earnings was paid to recipients not checked against the staker set.')
    expect(note(200_000n)).toContain('2.0% of earnings was paid to recipients not checked against the staker set.')
  })
  it('30 h since last payout on a 12 h schedule -> BEHIND_SCHEDULE', () =>
    expect(poolVerdict(base, { ...cfg, scheduleMs: 12 * HOUR }, base.lastPayoutTs! + 30 * HOUR).verdict).toBe('BEHIND_SCHEDULE'))
  it('24 h since last payout on a 12 h schedule is still fine', () =>
    expect(poolVerdict(base, { ...cfg, scheduleMs: 12 * HOUR }, base.lastPayoutTs! + 24 * HOUR).verdict).toBe('PAID_AS_PROMISED'))
  it('otherOut 40 % -> CANT_VERIFY_ROUTED', () =>
    expect(poolVerdict({ ...base, otherOut: 400_000n, paidRestake: 570_000n }, cfg, now).verdict).toBe('CANT_VERIFY_ROUTED'))
  it('ratio 0.80 with clean flows -> SHORT once an earlier window end confirms it', () => {
    const short = { ...base, paidRestake: 800_000n }
    const v = poolVerdict(short, cfg, now, { earlier: [{ ...short, windowEndTs: base.windowEndTs - 12 * HOUR }] })
    expect(v.verdict).toBe('SHORT')
    expect(v.expectedRatio).toBeCloseTo(0.97)
  })
  it('a shortfall no earlier window end confirms is a payout still in progress', () => {
    const short = { ...base, paidRestake: 800_000n }
    for (const earlier of [undefined, [], [base], [{ ...short }, base]]) {
      const v = poolVerdict(short, cfg, now, earlier ? { earlier } : undefined)
      expect(v.verdict).toBe('NOT_ENOUGH_DATA')
      expect(v.reasons.join(' ')).toMatch(/still be in progress/)
    }
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
  it('paying more than 20 pp above the promise stays PAID_AS_PROMISED and says it paid more than it earned', () => {
    // ObsidianStake: one 1.49M NIM transfer to a staker put its week at 237 %
    const over = poolVerdict({ ...base, paidDirect: 1_405_000n, paidRestake: 0n, otherOut: 160_000n }, cfg, now)
    expect(over.verdict).toBe('PAID_AS_PROMISED')
    expect(over.ratio).toBeCloseTo(1.405)
    expect(over.reasons).toContain('Paid more than earned in this window (includes a one-off transfer)')
    // just above the promise and up to 20 pp above it is an ordinary week
    for (const paid of [970_000n, 1_000_000n, 1_170_000n]) {
      const v = poolVerdict({ ...base, paidRestake: paid }, cfg, now)
      expect(v.verdict).toBe('PAID_AS_PROMISED')
      expect(v.reasons.join(' ')).not.toMatch(/more than earned/)
    }
    expect(poolVerdict({ ...base, paidRestake: 1_170_001n }, cfg, now).reasons).toContain('Paid more than earned in this window (includes a one-off transfer)')
  })
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
