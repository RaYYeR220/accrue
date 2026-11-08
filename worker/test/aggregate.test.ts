import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COINBASE_ADDRESS, RUN_GAP_BLOCKS, addressFromBytesHex, buildPoolWindow, classifyTx, poolVerdict, runGapBlocks, type NimTx } from '@accrue/shared'
import { aggregate, canonicalAddress, delegationOracle, payoutRecipients, poolWindowFromAggregates, shapeClassifier, stakerFromHex } from '../src/indexer/aggregate'

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../../packages/shared/test/fixtures/${f}`, import.meta.url), 'utf8')) as { address: string; txs: NimTx[] }
const siam = load('siam-2026-11-07.json')
const garuda = load('garuda-2026-11-07.json')

const HOUR = 3_600_000
const DAY = 86_400_000
const OTHER_VALIDATOR = 'NQ53 M1NT S3JD TAGM CBTK 01PX YD3U B1DE GYHB'

// Independent reading of a fixture, straight from the raw fields; no shared classifier involved.
function raw(f: { address: string; txs: NimTx[] }) {
  const isRestake = (t: NimTx) => t.from === f.address && t.toType === 3 && /^06[0-9a-f]{40}$/i.test(t.recipientData)
  const isDirect = (t: NimTx) => t.from === f.address && t.toType === 0 && t.to !== f.address
  const sum = (xs: NimTx[]) => xs.reduce((a, t) => a + BigInt(t.value), 0n)
  const coinbase = f.txs.filter((t) => t.from === COINBASE_ADDRESS && t.to === f.address)
  const restake = f.txs.filter(isRestake)
  const direct = f.txs.filter(isDirect)
  return { coinbase, restake, direct, sum, isRestake, isDirect }
}

function clusterCount(payouts: NimTx[]) {
  const blocks = payouts.map((t) => t.blockNumber).sort((a, b) => a - b)
  let n = 0
  for (let i = 0; i < blocks.length; i++) if (i === 0 || blocks[i]! - blocks[i - 1]! >= RUN_GAP_BLOCKS) n++
  return n
}

const total = <T>(xs: T[], f: (x: T) => bigint) => xs.reduce((a, x) => a + f(x), 0n)

describe('aggregate: Siam fixture', () => {
  const r = raw(siam)
  // restake recipients are Siam stakers; the single basic outgoing tx is not a payout
  const oracle = (_: string, kind: 'restake' | 'direct') => kind === 'restake'
  const agg = aggregate(siam.txs, { rewardAddress: siam.address }, oracle)

  it('hour buckets carry exactly the coinbase sum as earned', () => {
    expect(r.coinbase.length).toBeGreaterThan(500)
    expect(total(agg.hours, (h) => h.earned)).toBe(r.sum(r.coinbase))
  })

  it('paid_restake equals the outgoing restake sum; the non-staker basic tx is other_out', () => {
    expect(total(agg.hours, (h) => h.paidRestake)).toBe(r.sum(r.restake))
    expect(total(agg.hours, (h) => h.paidDirect)).toBe(0n)
    expect(total(agg.hours, (h) => h.otherOut)).toBe(r.sum(r.direct))
    expect(total(agg.hours, (h) => h.paidUnverified)).toBe(0n)
  })

  it('counts payout batches as distinct clusters', () => {
    const expected = clusterCount(r.restake)
    expect(expected).toBeGreaterThan(40)
    expect(agg.hours.reduce((a, h) => a + h.payoutBatches, 0)).toBe(expected)
  })

  it('buckets by hour of the tx timestamp and keeps the newest payout per hour', () => {
    const byHour = new Map<number, { earned: bigint; last: number | null }>()
    for (const t of siam.txs) {
      const h = Math.floor(t.timestamp / HOUR)
      const e = byHour.get(h) ?? { earned: 0n, last: null }
      if (t.from === COINBASE_ADDRESS) e.earned += BigInt(t.value)
      if (r.isRestake(t)) e.last = Math.max(e.last ?? 0, t.timestamp)
      byHour.set(h, e)
    }
    expect(agg.hours.map((h) => h.hour).sort()).toEqual([...byHour.keys()].sort())
    for (const h of agg.hours) {
      expect(h.earned).toBe(byHour.get(h.hour)!.earned)
      expect(h.lastPayoutTs).toBe(byHour.get(h.hour)!.last)
    }
  })

  it('staker_day sums over stakers to paid_restake, one row per staker and day', () => {
    expect(total(agg.stakerDays, (s) => s.received)).toBe(r.sum(r.restake))
    expect(agg.stakerDays.reduce((a, s) => a + s.payouts, 0)).toBe(r.restake.length)
    const keys = agg.stakerDays.map((s) => `${s.staker}|${s.day}`)
    expect(new Set(keys).size).toBe(keys.length)
    const known = 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST'
    const mine = r.restake.filter((t) => addressFromBytesHex(t.recipientData.slice(2)) === known)
    const perDay = new Map<number, bigint>()
    for (const t of mine) perDay.set(Math.floor(t.timestamp / DAY), (perDay.get(Math.floor(t.timestamp / DAY)) ?? 0n) + BigInt(t.value))
    const rows = agg.stakerDays.filter((s) => s.staker === known)
    expect(new Map(rows.map((s) => [s.day, s.received]))).toEqual(perDay)
  })

  it('reports the newest payout block for the next tick', () => {
    expect(agg.lastPayoutBlock).toBe(Math.max(...r.restake.map((t) => t.blockNumber)))
  })

  it('split into two ticks it adds up to the same buckets and batch count', () => {
    const sorted = [...siam.txs].sort((a, b) => a.blockNumber - b.blockNumber)
    // cut inside a payout cluster so the second half continues the first half's batch
    const cut = sorted.findIndex((t, i) => i > 1000 && r.isRestake(t) && r.isRestake(sorted[i - 1]!))
    const older = aggregate(sorted.slice(0, cut), { rewardAddress: siam.address }, oracle)
    const newer = aggregate(sorted.slice(cut), { rewardAddress: siam.address }, oracle, older.lastPayoutBlock)
    const batches = [...older.hours, ...newer.hours].reduce((a, h) => a + h.payoutBatches, 0)
    expect(batches).toBe(clusterCount(r.restake))
    expect(total([...older.hours, ...newer.hours], (h) => h.earned)).toBe(r.sum(r.coinbase))
  })

  it('ignores duplicate hashes and failed transactions', () => {
    const failed = { ...r.restake[0]!, hash: 'f'.repeat(64), executionResult: false } as NimTx
    const again = aggregate([...siam.txs, ...siam.txs.slice(0, 50), failed], { rewardAddress: siam.address }, oracle)
    expect(total(again.hours, (h) => h.paidRestake)).toBe(r.sum(r.restake))
    expect(total(again.hours, (h) => h.earned)).toBe(r.sum(r.coinbase))
  })
})

describe('aggregate: Garuda recipients through the delegation map', () => {
  const r = raw(garuda)
  const POOL = garuda.address
  const stakerOf = (t: NimTx) => (r.isRestake(t) ? addressFromBytesHex(t.recipientData.slice(2)) : t.to)
  const directRecipients = [...new Set(r.direct.map((t) => t.to))]
  const outsider = directRecipients[0]!
  const map = new Map<string, string>()
  for (const t of [...r.restake, ...r.direct]) map.set(canonicalAddress(stakerOf(t)), POOL)
  map.set(canonicalAddress(outsider), '')
  const agg = aggregate(garuda.txs, { rewardAddress: POOL }, delegationOracle(map, POOL))
  const outsiderTxs = r.direct.filter((t) => t.to === outsider)

  it('a direct recipient that is not a staker lands in other_out with its full value', () => {
    expect(outsiderTxs.length).toBeGreaterThan(0)
    expect(total(agg.hours, (h) => h.otherOut)).toBe(r.sum(outsiderTxs))
    expect(total(agg.hours, (h) => h.paidDirect)).toBe(r.sum(r.direct) - r.sum(outsiderTxs))
    expect(total(agg.hours, (h) => h.paidRestake)).toBe(r.sum(r.restake))
    expect(total(agg.hours, (h) => h.paidUnverified)).toBe(0n)
  })

  it('staker_day holds every verified payout and nothing for the outsider', () => {
    expect(agg.stakerDays.some((s) => s.staker === canonicalAddress(outsider))).toBe(false)
    expect(total(agg.stakerDays, (s) => s.received)).toBe(r.sum(r.restake) + r.sum(r.direct) - r.sum(outsiderTxs))
  })

  it('batches merge the restake and direct legs of one run', () => {
    const payouts = [...r.restake, ...r.direct.filter((t) => t.to !== outsider)]
    expect(agg.hours.reduce((a, h) => a + h.payoutBatches, 0)).toBe(clusterCount(payouts))
  })

  it('unknown recipients stay paid but unverified; departed restake recipients too', () => {
    const unknown = stakerOf(r.restake[0]!)
    const departed = stakerOf(r.restake.find((t) => stakerOf(t) !== unknown)!)
    const m2 = new Map(map)
    m2.delete(canonicalAddress(unknown))
    m2.set(canonicalAddress(departed), '')
    const a2 = aggregate(garuda.txs, { rewardAddress: POOL }, delegationOracle(m2, POOL))
    const sumOf = (addr: string) => r.sum(r.restake.filter((t) => stakerOf(t) === addr))
    expect(total(a2.hours, (h) => h.paidUnverified)).toBe(sumOf(unknown) + sumOf(departed))
    expect(total(a2.hours, (h) => h.paidRestake)).toBe(r.sum(r.restake))
  })

  it('a restake recipient now delegating to another pool counts as other_out', () => {
    const moved = stakerOf(r.restake[0]!)
    const m3 = new Map(map)
    m3.set(canonicalAddress(moved), OTHER_VALIDATOR)
    const a3 = aggregate(garuda.txs, { rewardAddress: POOL }, delegationOracle(m3, POOL))
    const movedSum = r.sum(r.restake.filter((t) => stakerOf(t) === moved))
    expect(total(a3.hours, (h) => h.otherOut)).toBe(r.sum(outsiderTxs) + movedSum)
    expect(total(a3.hours, (h) => h.paidRestake)).toBe(r.sum(r.restake) - movedSum)
  })
})

describe('stakerFromHex / payoutRecipients', () => {
  it('decodes exactly like shared addressFromBytesHex', () => {
    const hexes = [...siam.txs, ...garuda.txs].filter((t) => /^06[0-9a-f]{40}$/i.test(t.recipientData)).map((t) => t.recipientData.slice(2))
    for (let i = 0; i < 300; i++) hexes.push(Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''))
    hexes.push('0'.repeat(40), 'f'.repeat(40), 'FfEe'.repeat(10))
    for (const h of new Set(hexes)) expect(stakerFromHex(h)).toBe(addressFromBytesHex(h))
  })

  it('lists every restake staker and direct recipient once', () => {
    const r = raw(garuda)
    const want = new Set([
      ...r.restake.map((t) => addressFromBytesHex(t.recipientData.slice(2))),
      ...r.direct.map((t) => canonicalAddress(t.to)),
    ])
    expect(payoutRecipients(garuda.txs, garuda.address)).toEqual(want)
  })
})

describe('poolWindowFromAggregates', () => {
  const span = (f: { txs: NimTx[] }) => ({
    fromTs: Math.min(...f.txs.map((t) => t.timestamp)),
    toTs: Math.max(...f.txs.map((t) => t.timestamp)) + 1,
  })

  it('Garuda: the hourly window matches the tx-level window within half a point', () => {
    const exact = buildPoolWindow(garuda.txs, { rewardAddress: garuda.address }, () => undefined)
    const agg = aggregate(garuda.txs, { rewardAddress: garuda.address }, () => undefined)
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, span(garuda))
    const ratio = (x: typeof w) => Number(((x.paidRestake + x.paidDirect) * 1_000_000n) / x.earned) / 1e6
    expect(Math.abs(ratio(w) - ratio(exact))).toBeLessThan(0.005)
    expect(w.paidUnverified).toBe(w.paidRestake + w.paidDirect)
    expect(w.cycles).toBeGreaterThanOrEqual(3)
    expect(w.cycles).toBeLessThanOrEqual(exact.cycles)
    expect(w.lastPayoutTs).toBe(exact.lastPayoutTs)
  })

  it('Siam: hourly pro-rating stays within half a point of the raw txs between the same bounds', () => {
    const agg = aggregate(siam.txs, { rewardAddress: siam.address }, () => true)
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, span(siam))
    let earned = 0n
    let paid = 0n
    for (const t of siam.txs) {
      if (t.timestamp <= w.windowStartTs || t.timestamp > w.windowEndTs) continue
      if (t.from === COINBASE_ADDRESS) earned += BigInt(t.value)
      else if (t.from === siam.address) paid += BigInt(t.value)
    }
    const rawRatio = Number((paid * 1_000_000n) / earned) / 1e6
    expect(w.paidRestake + w.paidDirect).toBe(paid)
    expect(Math.abs(Number(((w.paidRestake + w.paidDirect) * 1_000_000n) / w.earned) / 1e6 - rawRatio)).toBeLessThan(0.005)
  })

  it('fewer than two payout hours gives an empty window', () => {
    const coinbaseOnly = siam.txs.filter((t) => t.from === COINBASE_ADDRESS)
    const agg = aggregate(coinbaseOnly, { rewardAddress: siam.address }, () => true)
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, span(siam))
    expect(w.cycles).toBe(0)
    expect(w.lastPayoutTs).toBeNull()
  })
})

// Review r1: the window may only close at a payout run known to be complete.
describe('poolWindowFromAggregates: complete runs only (review r1)', () => {
  const GARUDA_CFG = { fee: 0.05, payoutType: 'restake' as const, scheduleMs: null }
  const sorted = [...garuda.txs].sort((a, b) => a.blockNumber - b.blockNumber)
  const isPay = (t: NimTx) => t.from === garuda.address && t.to !== garuda.address
  const runs: NimTx[][] = []
  for (const t of sorted.filter(isPay)) {
    const last = runs[runs.length - 1]
    if (last && t.blockNumber - last[last.length - 1]!.blockNumber < RUN_GAP_BLOCKS) last.push(t)
    else runs.push([t])
  }
  const lastRun = runs[runs.length - 1]!
  const prevRunEnd = runs[runs.length - 2]![runs[runs.length - 2]!.length - 1]!.timestamp
  const windowAt = (cutBlock: number) => {
    const cut = sorted.filter((t) => t.blockNumber <= cutBlock)
    const agg = aggregate(cut, { rewardAddress: garuda.address }, () => true)
    // the data reaches the cut block, dated from the newest tx at or below it (one block a second)
    const ref = cut[cut.length - 1]!
    const toTs = ref.timestamp + (cutBlock - ref.blockNumber) * 1000 + 1
    return poolWindowFromAggregates(agg.hours, agg.stakerDays, { fromTs: cut[0]!.timestamp, toTs })
  }

  it('hour rows carry the first payout of the hour too', () => {
    const agg = aggregate(garuda.txs, { rewardAddress: garuda.address }, () => true)
    for (const h of agg.hours.filter((x) => x.lastPayoutTs !== null)) {
      const inHour = sorted.filter((t) => isPay(t) && Math.floor(t.timestamp / HOUR) === h.hour)
      expect(h.firstPayoutTs).toBe(Math.min(...inHour.map((t) => t.timestamp)))
    }
  })

  it('Garuda cut anywhere inside its last run is never SHORT and closes at the previous run', () => {
    const blocks = [...new Set(lastRun.map((t) => t.blockNumber))]
    expect(blocks.length).toBeGreaterThan(1)
    for (const b of blocks) {
      const w = windowAt(b)
      expect(w.windowEndTs).toBeLessThanOrEqual(prevRunEnd)
      const v = poolVerdict(w, GARUDA_CFG, w.windowEndTs)
      expect(v.verdict).not.toBe('SHORT')
      expect(v.ratio ?? 1).toBeGreaterThan(0.93)
    }
  })

  it('the last run counts once the data reaches the run gap (a quarter of the 12 h cycle) past it', () => {
    const end = lastRun[lastRun.length - 1]!
    const gap = runGapBlocks(12 * HOUR)
    expect(windowAt(end.blockNumber + RUN_GAP_BLOCKS + 60).windowEndTs).toBeLessThanOrEqual(prevRunEnd)
    expect(windowAt(end.blockNumber + gap - 120).windowEndTs).toBeLessThanOrEqual(prevRunEnd)
    expect(windowAt(end.blockNumber + gap + 120).windowEndTs).toBe(end.timestamp)
  })

  // synthetic pools: 1 block per second, a coinbase every 60 blocks
  const REWARD = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
  const STAKERS = ['11'.repeat(20), '22'.repeat(20), '33'.repeat(20)]
  let n = 0
  const tx = (block: number, from: string, to: string, value: number, data = '', toType = 0) =>
    ({ hash: `s${n++}`, blockNumber: block, timestamp: block * 1000, from, to, fromType: 0, toType, value, fee: 0, senderData: '', recipientData: data, relatedAddresses: [] }) as NimTx
  const coinbase = (block: number) => tx(block, COINBASE_ADDRESS, REWARD, 1_000_000)
  const restake = (block: number, staker: string, value: number) =>
    tx(block, REWARD, 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001', value, `06${staker}`, 3)
  const START = 3_600 * 1_000_000 // an hour boundary, in blocks

  it('a pool that pays every batch (one endless run) gets a window, and a fair ratio', () => {
    const txs: NimTx[] = []
    for (let b = START; b < START + 10 * 3600; b += 60) {
      txs.push(coinbase(b))
      for (const s of STAKERS) txs.push(restake(b + 30, s, 323_333))
    }
    const agg = aggregate(txs, { rewardAddress: REWARD }, () => true)
    const toTs = (START + 10 * 3600) * 1000
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, { fromTs: START * 1000, toTs })
    expect(w.windowEndTs).toBeGreaterThan(w.windowStartTs)
    const ratio = Number(((w.paidRestake + w.paidDirect) * 1_000_000n) / w.earned) / 1e6
    expect(Math.abs(ratio - 0.97)).toBeLessThan(0.01)
    // and it never closes within RUN_GAP of the data's end
    expect(w.windowEndTs).toBeLessThanOrEqual(toTs - RUN_GAP_BLOCKS * 1000)
  })

  it('a 12 h cycle paid out slowly over 3 h is a run, not a stream: a cut inside it is not SHORT', () => {
    const txs: NimTx[] = []
    const H = 3600
    for (let b = START; b < START + 40 * H; b += 60) txs.push(coinbase(b))
    for (const cycleStart of [START + 12 * H, START + 24 * H, START + 36 * H]) {
      // 12 h of rewards (720 batches x 1_000_000) x 0.95, spread over 180 payouts 60 blocks apart
      for (let k = 0; k < 180; k++) txs.push(restake(cycleStart + k * 60 + 10, STAKERS[k % 3]!, Math.floor((720 * 1_000_000 * 0.95) / 180)))
    }
    const cutBlock = START + 37 * H + 1800 // in the middle of the third payout
    const cut = txs.filter((t) => t.blockNumber <= cutBlock)
    const agg = aggregate(cut, { rewardAddress: REWARD }, () => true)
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, { fromTs: START * 1000, toTs: cutBlock * 1000 })
    expect(w.windowEndTs).toBeLessThanOrEqual((START + 27 * H) * 1000)
    const v = poolVerdict({ ...w, cycles: Math.max(w.cycles, 3) }, GARUDA_CFG, w.windowEndTs)
    expect(v.verdict).not.toBe('SHORT')
  })

  it('a window never spans an open descent\'s hole', () => {
    const agg = aggregate(garuda.txs, { rewardAddress: garuda.address }, () => true)
    const lo = sorted[0]!.timestamp
    const hi = sorted[sorted.length - 1]!.timestamp + 1
    const mid = lo + (hi - lo) * 0.7
    const hole = { fromTs: mid, toTs: mid + 4 * HOUR }
    // the hole has no rows: drop them, as the indexer would not have folded them yet
    const rows = agg.hours.filter((h) => (h.hour + 1) * HOUR <= hole.fromTs || h.hour * HOUR >= hole.toTs)
    const w = poolWindowFromAggregates(rows, agg.stakerDays, { fromTs: lo, toTs: hi, hole })
    expect(w.windowEndTs <= hole.fromTs || w.windowStartTs >= hole.toTs).toBe(true)
    const backfilling = poolWindowFromAggregates(rows, agg.stakerDays, { fromTs: lo, toTs: hi, hole: { fromTs: 0, toTs: hole.toTs } })
    expect(backfilling.windowStartTs).toBeGreaterThanOrEqual(hole.toTs)
  })

  it('lastPayoutTs is the newest payout known, whichever side of a hole the window uses', () => {
    const agg = aggregate(garuda.txs, { rewardAddress: garuda.address }, () => true)
    const lo = sorted[0]!.timestamp
    const hi = sorted[sorted.length - 1]!.timestamp + 1
    const newestPayout = Math.max(...sorted.filter(isPay).map((t) => t.timestamp))
    // a short catch-up hole near the end: the window uses the longer, older side
    const hole = { fromTs: newestPayout - 8 * HOUR, toTs: Math.floor(newestPayout / HOUR) * HOUR }
    const rows = agg.hours.filter((h) => (h.hour + 1) * HOUR <= hole.fromTs || h.hour * HOUR >= hole.toTs)
    const w = poolWindowFromAggregates(rows, agg.stakerDays, { fromTs: lo, toTs: hi, hole })
    expect(w.windowEndTs).toBeLessThanOrEqual(hole.fromTs)
    expect(w.lastPayoutTs).toBe(newestPayout)
  })
})

describe('classifyShape (the cron hot path)', () => {
  const STAKING = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'
  const hex = (i: number) => (i * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(5)
  // every recorded tx, plus shapes the fixtures lack: lowercase/unspaced addresses, foreign senders,
  // restakes to a non-staking address, malformed staker data, transfers to the pool itself
  function shapes(f: { address: string; txs: NimTx[] }): NimTx[] {
    const base = f.txs[0]!
    const out: NimTx[] = [...f.txs]
    for (let i = 0; i < 60; i++) {
      const h = hex(i)
      out.push({ ...base, from: f.address, to: STAKING, toType: 3, recipientData: `06${h}` })
      out.push({ ...base, from: f.address.toLowerCase().replace(/ /g, ''), to: STAKING.replace(/ /g, ''), toType: 3, recipientData: `06${h.toUpperCase()}` })
      out.push({ ...base, from: f.address, to: OTHER_VALIDATOR, toType: 3, recipientData: `06${h}` })
      out.push({ ...base, from: f.address, to: STAKING, toType: 3, recipientData: `05${h}` })
      out.push({ ...base, from: f.address, to: STAKING, toType: 3, recipientData: `06${h}00` })
      out.push({ ...base, from: f.address, to: addressFromBytesHex(h), toType: 0, recipientData: '' })
      out.push({ ...base, from: f.address, to: f.address, toType: 0, recipientData: '' })
      out.push({ ...base, from: OTHER_VALIDATOR, to: f.address, toType: 0, recipientData: '' })
      out.push({ ...base, from: COINBASE_ADDRESS, to: f.address.toLowerCase(), toType: 0, recipientData: '' })
      out.push({ ...base, from: OTHER_VALIDATOR, to: addressFromBytesHex(h), toType: 0, recipientData: '' })
    }
    return out
  }
  // an oracle that knows some stakers as the pool's, some as another pool's or none, and not the rest
  const oracleFor = (pool: string) => (addr: string, leg: 'restake' | 'direct') => {
    const n = canonicalAddress(addr).charCodeAt(6) % 4
    return n === 0 ? undefined : n === 1 ? false : n === 2 ? leg === 'restake' : true
  }

  for (const f of [siam, garuda]) {
    it(`gives shared classifyTx's answer for every tx shape (${f.address.slice(0, 9)})`, () => {
      const oracle = oracleFor(f.address)
      const fast = shapeClassifier(f.address, oracle)
      for (const tx of shapes(f)) {
        const leg = /^06[0-9a-fA-F]{40}$/.test(tx.recipientData) && tx.toType === 3 ? 'restake' : 'direct'
        const want = classifyTx(tx, { rewardAddress: f.address }, (a) => oracle(a, leg))
        const paid = want.kind === 'RESTAKE_PAYOUT' || want.kind === 'DIRECT_PAYOUT'
        expect(fast(tx)).toEqual({ kind: want.kind, staker: paid ? canonicalAddress(want.staker ?? tx.to) : null, unverified: !!want.unverified })
      }
    })
  }
})
