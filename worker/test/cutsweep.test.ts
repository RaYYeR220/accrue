// Review r2 acceptance: a pool is never SHORT (or BEHIND_SCHEDULE) because of where the data was cut,
// only because of what it paid. Cuts land on every macro block, read the way Task 9 reads them.
import { describe, expect, it } from 'vitest'
import { BATCH_BLOCKS, COINBASE_ADDRESS, poolVerdict, type NimTx } from '@accrue/shared'
import { HOUR_MS, aggregate, dayOf, hourOf, poolWindowsFromAggregates, type HourAgg, type StakerDayAgg } from '../src/indexer/aggregate'
import { load } from './chain'

const REWARD = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
const STAKING = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'
const H = 3600
const START = 3600 * 1_000_000
const DAYS = 9
const END = START + DAYS * 24 * H
const WEEK = 7 * 24 * HOUR_MS
type Cfg = { fee: number; payoutType: 'restake'; scheduleMs: number | null }
const CFG: Cfg = { fee: 0.05, payoutType: 'restake', scheduleMs: null }

interface Pool {
  cycleH: number
  spreadH: number
  txs: NimTx[]
  // [start, end] block of every distribution
  dists: [number, number][]
}

// The reviewer's generator (rr-slowrun.mts), same LCG and the same draw order, so trial k of a
// configuration is the very pool the review found SHORT. 120 stakers with Pareto-like stakes, paid
// in a new random order every cycle at a constant pace over `spreadH` hours.
function reviewerPools(pays: number): Map<string, Pool> {
  let seed = 1
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  let n = 0
  const tx = (block: number, from: string, to: string, value: number, data = '', toType = 0) =>
    ({ hash: `s${n++}`, blockNumber: block, timestamp: block * 1000, from, to, fromType: 0, toType, value, fee: 0, senderData: '', recipientData: data, relatedAddresses: [] }) as NimTx
  const out = new Map<string, Pool>()
  for (const cycleH of [12, 24]) {
    for (const spreadH of [2.5, 3.5, 4, 5, 6, 7, 8, 9, 10, 11]) {
      for (let trial = 0; trial < 4; trial++) {
        const stakers = Array.from({ length: 120 }, (_, i) => ({ hex: (i + 16).toString(16).padStart(2, '0').repeat(20), stake: Math.pow(rnd(), -1.2) }))
        const total = stakers.reduce((a, s) => a + s.stake, 0)
        const txs: NimTx[] = []
        for (let b = START; b < END; b += 60) txs.push(tx(b, COINBASE_ADDRESS, REWARD, 1_000_000))
        const offset = Math.floor(rnd() * cycleH * H)
        const dists: [number, number][] = []
        for (let T = START + cycleH * H + offset; T < END; T += cycleH * H) {
          const owed = ((cycleH * H) / 60) * 1_000_000 * pays
          const order = [...stakers].sort(() => rnd() - 0.5)
          const step = Math.floor((spreadH * H) / order.length)
          order.forEach((s, k) => txs.push(tx(T + k * step + 7, REWARD, STAKING, Math.floor((owed * s.stake) / total), `06${s.hex}`, 3)))
          dists.push([T + 7, T + (order.length - 1) * step + 7])
        }
        txs.sort((a, b) => a.blockNumber - b.blockNumber)
        out.set(`${cycleH}/${spreadH}/${trial}`, { cycleH, spreadH, txs, dists })
      }
    }
  }
  return out
}

// What D1 holds when the data reaches `cut`: full rows before the cut's hour (and day), partial ones
// for the hour and day the cut falls in.
function cutter(txs: NimTx[], reward: string, oracle: () => boolean | undefined = () => true) {
  const full = aggregate(txs, { rewardAddress: reward }, oracle)
  const byHour = new Map<number, NimTx[]>()
  const byDay = new Map<number, NimTx[]>()
  for (const t of txs) {
    const h = hourOf(t.timestamp)
    if (!byHour.has(h)) byHour.set(h, [])
    byHour.get(h)!.push(t)
    if (t.from === reward) {
      const d = dayOf(t.timestamp)
      if (!byDay.has(d)) byDay.set(d, [])
      byDay.get(d)!.push(t)
    }
  }
  const sorted = [...txs].sort((a, b) => a.blockNumber - b.blockNumber)
  return (cut: number): { hours: HourAgg[]; days: StakerDayAgg[]; reach: number } => {
    // dated like the indexer dates a macro block: from the newest tx at or below it
    let lo = 0
    let hi = sorted.length - 1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (sorted[m]!.blockNumber <= cut) lo = m
      else hi = m - 1
    }
    const ref = sorted[lo]!
    const reach = ref.timestamp + (cut - ref.blockNumber) * 1000
    const hx = hourOf(reach)
    const dx = dayOf(reach)
    const part = aggregate((byHour.get(hx) ?? []).filter((t) => t.blockNumber <= cut), { rewardAddress: reward }, oracle)
    const dayPart = aggregate((byDay.get(dx) ?? []).filter((t) => t.blockNumber <= cut), { rewardAddress: reward }, oracle)
    return {
      hours: [...full.hours.filter((h) => h.hour < hx), ...part.hours],
      days: [...full.stakerDays.filter((d) => d.day < dx), ...dayPart.stakerDays],
      reach,
    }
  }
}

const verdictAt = (at: ReturnType<ReturnType<typeof cutter>>, cfg: Cfg) => {
  const { window, earlier } = poolWindowsFromAggregates(at.hours, at.days, { fromTs: at.reach - WEEK, toTs: at.reach, scheduleMs: cfg.scheduleMs })
  return { window, v: poolVerdict(window, cfg, at.reach, { earlier }) }
}

describe('cut sweep: honest slow payers are never SHORT (review r2)', () => {
  const pools = reviewerPools(0.95)
  const cases = [
    ...[7, 8, 9].map((s) => [24, s] as const),
    [12, 2.5] as const,
    [12, 10] as const,
    [12, 11] as const,
  ]
  for (const [cycleH, spreadH] of cases) {
    it(`${cycleH} h cycle paid over ${spreadH} h: 0 SHORT at every macro block of the last two cycles`, () => {
      for (let trial = 0; trial < 4; trial++) {
        const p = pools.get(`${cycleH}/${spreadH}/${trial}`)!
        const at = cutter(p.txs, REWARD)
        const tally: Record<string, number> = {}
        for (let cut = END - 2 * cycleH * H; cut < END; cut += BATCH_BLOCKS) {
          const { v } = verdictAt(at(cut), CFG)
          tally[v.verdict] = (tally[v.verdict] ?? 0) + 1
        }
        expect(tally.SHORT ?? 0, `trial ${trial} ${JSON.stringify(tally)}`).toBe(0)
        expect(tally.BEHIND_SCHEDULE ?? 0).toBe(0)
      }
    }, 120_000)
  }
})

describe('cut sweep: a pool paying 80 % stays SHORT (review r2 negative control)', () => {
  const pools = reviewerPools(0.8)
  for (const [cycleH, spreadH] of [[12, 2.5], [24, 7], [24, 9]] as const) {
    it(`${cycleH} h cycle over ${spreadH} h at 80 %: SHORT at every cut after a complete cycle`, () => {
      for (let trial = 0; trial < 4; trial++) {
        const p = pools.get(`${cycleH}/${spreadH}/${trial}`)!
        const at = cutter(p.txs, REWARD)
        let checked = 0
        // cuts between the end of a distribution (plus its run gap) and the start of the next one
        for (let k = p.dists.length - 3; k < p.dists.length - 1; k++) {
          const from = p.dists[k]![1] + (cycleH * H) / 4
          const to = p.dists[k + 1]![0]
          for (let cut = Math.ceil(from / BATCH_BLOCKS) * BATCH_BLOCKS; cut < to; cut += 10 * BATCH_BLOCKS) {
            const { v } = verdictAt(at(cut), CFG)
            expect(v.verdict, `trial ${trial} cut ${cut} ratio ${v.ratio}`).toBe('SHORT')
            checked++
          }
        }
        expect(checked).toBeGreaterThan(5)
      }
    }, 120_000)
  }
})

describe('cut sweep: recorded Garuda (review r2)', () => {
  const garuda = load('garuda-2026-11-07.json')
  const GCFG: Cfg = { fee: 0.05, payoutType: 'restake', scheduleMs: 12 * HOUR_MS }
  const sorted = [...garuda.txs].sort((a, b) => a.blockNumber - b.blockNumber)
  const top = sorted[sorted.length - 1]!.blockNumber

  it('every macro block of the last 24 h: 0 SHORT, 0 BEHIND_SCHEDULE', () => {
    const at = cutter(sorted, garuda.address)
    const tally: Record<string, number> = {}
    for (let cut = Math.floor((top - 86_400) / 60) * 60; cut <= top; cut += 60) {
      const { v } = verdictAt(at(cut), GCFG)
      tally[v.verdict] = (tally[v.verdict] ?? 0) + 1
    }
    expect(tally.SHORT ?? 0).toBe(0)
    expect(tally.BEHIND_SCHEDULE ?? 0).toBe(0)
    expect(tally.PAID_AS_PROMISED ?? 0).toBeGreaterThan(1000)
  }, 120_000)

  it('the same history with every payout x0.8 is SHORT at every cut', () => {
    const scaled = sorted.map((t) => (t.from === garuda.address ? { ...t, value: Math.floor(t.value * 0.8) } : t))
    const at = cutter(scaled, garuda.address)
    const tally: Record<string, number> = {}
    for (let cut = Math.floor((top - 86_400) / 60) * 60; cut <= top; cut += 600) {
      const { v } = verdictAt(at(cut), GCFG)
      tally[v.verdict] = (tally[v.verdict] ?? 0) + 1
    }
    expect(tally).toEqual({ SHORT: expect.any(Number) })
  }, 120_000)
})

describe('live-like streams keep their windows (review r2)', () => {
  // a pool paying every batch, 30 blocks after each reward, to stakers of very different size
  let n = 0
  const tx = (block: number, from: string, to: string, value: number, data = '', toType = 0) =>
    ({ hash: `t${n++}`, blockNumber: block, timestamp: block * 1000, from, to, fromType: 0, toType, value, fee: 0, senderData: '', recipientData: data, relatedAddresses: [] }) as NimTx
  const txs: NimTx[] = []
  const shares = [0.5, 0.3, 0.15, 0.05]
  for (let b = START; b < START + DAYS * 24 * H; b += 60) {
    txs.push(tx(b, COINBASE_ADDRESS, REWARD, 1_000_000))
    shares.forEach((s, i) => txs.push(tx(b + 30, REWARD, STAKING, Math.floor(1_000_000 * 0.99 * s), `06${String(i + 1).repeat(40)}`, 3)))
  }

  it('window at every 10th macro block of the last day, ratio within 0.5 pp of the raw txs between its bounds', () => {
    const at = cutter(txs, REWARD)
    for (let cut = END - 86_400; cut < END; cut += 600) {
      const { window: w, v } = verdictAt(at(cut), { ...CFG, fee: 0.01 })
      expect(v.verdict).toBe('PAID_AS_PROMISED')
      let earned = 0n
      let paid = 0n
      for (const t of txs) {
        if (t.timestamp <= w.windowStartTs || t.timestamp > w.windowEndTs) continue
        if (t.from === COINBASE_ADDRESS) earned += BigInt(t.value)
        else paid += BigInt(t.value)
      }
      const raw = Number((paid * 1_000_000n) / earned) / 1e6
      expect(Math.abs(v.ratio! - raw)).toBeLessThan(0.005)
      expect(w.windowEndTs).toBeLessThanOrEqual(at(cut).reach - HOUR_MS)
    }
  }, 120_000)
})
