import {
  COINBASE_ADDRESS,
  RUN_GAP_BLOCKS,
  STAKING_CONTRACT,
  addressFromBytesHex,
  normalizeAddress,
  payoutCycleMs,
  runGapBlocks,
  type NimTx,
  type PayoutTxKind,
  type PoolWindow,
} from '@accrue/shared'

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export const hourOf = (ts: number) => Math.floor(ts / HOUR_MS)
export const dayOf = (ts: number) => Math.floor(ts / DAY_MS)

const CANONICAL = /^NQ\d{2}( [0-9A-Z]{4}){8}$/

/** "NQ94 UUV1 ..." with single spaces, the form the RPC and the validators API use. */
export function canonicalAddress(a: string): string {
  return CANONICAL.test(a) ? a : normalizeAddress(a).replace(/(.{4})(?=.)/g, '$1 ')
}

export type PayoutLeg = 'restake' | 'direct'
/** true = staker of the pool, false = not a payout, undefined = could not check. */
export type Oracle = (staker: string, leg: PayoutLeg) => boolean | undefined

/**
 * Reads the recipient_delegation cache: address -> validator it delegates to, '' when the
 * address is not a staker, missing when never looked up.
 * A restake (add-stake) only succeeds for an existing staker, so a restake recipient that is no
 * longer a staker left after being paid: unverifiable, not an outflow. A direct recipient that is
 * not a staker is just an address the pool sent money to.
 */
export function delegationOracle(cache: ReadonlyMap<string, string>, poolAddress: string): Oracle {
  const pool = canonicalAddress(poolAddress)
  return (staker, leg) => {
    const d = cache.get(staker) ?? cache.get(canonicalAddress(staker))
    if (d === undefined) return undefined
    if (d === '') return leg === 'restake' ? undefined : false
    return d === pool || canonicalAddress(d) === pool
  }
}

export function isRestakeTx(tx: Pick<NimTx, 'toType' | 'recipientData'>): boolean {
  return tx.toType === 3 && /^06[0-9a-fA-F]{40}$/.test(tx.recipientData)
}

/** Every address a payout in `txs` would credit (restake: the staker in recipientData; basic: `to`). */
export function payoutRecipients(txs: readonly NimTx[], rewardAddress: string): Set<string> {
  const reward = normalizeAddress(rewardAddress)
  const isReward = memo((a: string) => normalizeAddress(a) === reward)
  const restakeData = new Set<string>()
  const direct = new Set<string>()
  for (const tx of txs) {
    if (!isReward(tx.from) || failed(tx)) continue
    if (tx.toType === 3) {
      if (isRestakeTx(tx)) restakeData.add(tx.recipientData.slice(2).toLowerCase())
    } else if (tx.toType === 0 && !isReward(tx.to)) direct.add(tx.to)
  }
  const out = new Set<string>()
  for (const a of direct) out.add(canonicalAddress(a))
  for (const hex of restakeData) out.add(stakerOf(hex))
  return out
}

const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'
const HEX_VALUE = (() => {
  const t = new Int8Array(128).fill(-1)
  for (let i = 0; i < 10; i++) t[48 + i] = i
  for (let i = 0; i < 6; i++) t[65 + i] = t[97 + i] = 10 + i
  return t
})()

/**
 * Same result as shared `addressFromBytesHex`, with integer bit math instead of bit strings: the
 * cron decodes every restake recipient of a tick and the free plan allows 10 ms of CPU.
 */
export function stakerFromHex(hex: string): string {
  if (hex.length !== 40) return addressFromBytesHex(hex)
  let body = ''
  let acc = 0
  let bits = 0
  for (let i = 0; i < 40; i++) {
    const c = hex.charCodeAt(i)
    const v = c < 128 ? HEX_VALUE[c]! : -1
    if (v < 0) return addressFromBytesHex(hex)
    acc = ((acc << 4) | v) & 0xff
    bits += 4
    if (bits >= 5) {
      bits -= 5
      body += B32[(acc >> bits) & 31]
    }
  }
  let rem = 0
  for (let i = 0; i < 36; i++) {
    const code = i < 32 ? body.charCodeAt(i) : 'NQ00'.charCodeAt(i - 32)
    rem = code >= 65 ? (rem * 100 + code - 55) % 97 : (rem * 10 + code - 48) % 97
  }
  let out = `NQ${String(98 - rem).padStart(2, '0')}`
  for (let i = 0; i < 32; i += 4) out += ` ${body.slice(i, i + 4)}`
  return out
}

// Stakers recur tick after tick; an isolate that stays warm decodes each one once.
const STAKERS = new Map<string, string>()
const MAX_STAKERS = 20_000

function stakerOf(hex: string): string {
  const key = hex.toLowerCase()
  let a = STAKERS.get(key)
  if (a === undefined) {
    if (STAKERS.size >= MAX_STAKERS) STAKERS.clear()
    a = stakerFromHex(key)
    STAKERS.set(key, a)
  }
  return a
}

export interface Shape {
  kind: PayoutTxKind
  /** canonical address of the paid staker, for payouts */
  staker: string | null
  unverified: boolean
}

const COINBASE = normalizeAddress(COINBASE_ADDRESS)
const STAKING = normalizeAddress(STAKING_CONTRACT)
const RESTAKE_DATA = /^06[0-9a-fA-F]{40}$/
const OTHER_IN: Shape = Object.freeze({ kind: 'OTHER_IN', staker: null, unverified: false })
const OTHER_OUT: Shape = Object.freeze({ kind: 'OTHER_OUT', staker: null, unverified: false })
const EARNED: Shape = Object.freeze({ kind: 'EARNED', staker: null, unverified: false })

/**
 * Shared `classifyTx`, reduced to what aggregation keeps (kind, the paid staker in canonical form,
 * unverified) and computed with this call's address caches. A test holds it to classifyTx's answer
 * for every recorded tx and for generated shapes. `value` is left to the caller.
 */
export function shapeClassifier(rewardAddress: string, oracle: Oracle): (tx: NimTx) => Shape {
  const reward = normalizeAddress(rewardAddress)
  const norm = memo(normalizeAddress)
  return (tx) => {
    const from = norm(tx.from)
    const to = norm(tx.to)
    if (to === reward && from !== reward) return from === COINBASE ? EARNED : OTHER_IN
    if (from !== reward) return OTHER_IN
    if (to === STAKING && tx.toType === 3 && RESTAKE_DATA.test(tx.recipientData)) {
      const staker = stakerOf(tx.recipientData.slice(2))
      const known = oracle(staker, 'restake')
      if (known === false) return OTHER_OUT
      return { kind: 'RESTAKE_PAYOUT', staker, unverified: known === undefined }
    }
    if (tx.toType === 0 && to !== reward) {
      const known = oracle(tx.to, 'direct')
      if (known === false) return OTHER_OUT
      return { kind: 'DIRECT_PAYOUT', staker: canonicalAddress(tx.to), unverified: known === undefined }
    }
    return OTHER_OUT
  }
}

function memo<T>(f: (k: string) => T): (k: string) => T {
  const m = new Map<string, T>()
  return (k) => {
    let v = m.get(k)
    if (v === undefined && !m.has(k)) {
      v = f(k)
      m.set(k, v)
    }
    return v as T
  }
}

export interface HourAgg {
  hour: number
  earned: bigint
  paidRestake: bigint
  paidDirect: bigint
  paidUnverified: bigint
  otherOut: bigint
  payoutBatches: number
  firstPayoutTs: number | null
  lastPayoutTs: number | null
}

export interface StakerDayAgg {
  staker: string
  day: number
  received: bigint
  payouts: number
}

export interface Aggregate {
  hours: HourAgg[]
  stakerDays: StakerDayAgg[]
  lastPayoutBlock: number | null
  txs: number
}

const failed = (tx: NimTx) => (tx as { executionResult?: boolean }).executionResult === false

/**
 * Folds one contiguous slice of a pool's reward-address history into hour buckets and
 * per-staker-day totals. `prevPayoutBlock` is the newest payout already folded in by an earlier
 * slice, so a batch that straddles two slices is counted once.
 */
export function aggregate(
  txs: readonly NimTx[],
  pool: { rewardAddress: string },
  oracle: Oracle,
  prevPayoutBlock: number | null = null,
): Aggregate {
  const seen = new Set<string>()
  const list: NimTx[] = []
  for (const tx of txs) {
    if (seen.has(tx.hash) || failed(tx)) continue
    seen.add(tx.hash)
    list.push(tx)
  }
  list.sort((a, b) => a.blockNumber - b.blockNumber)

  const hours = new Map<number, HourAgg>()
  const stakerDays = new Map<string, StakerDayAgg>()
  let lastPayout = prevPayoutBlock

  // Apart from `value`, the classification is a pure function of these four fields (and the
  // oracle), and a tick sees the same few hundred stakers over and over, so each distinct shape is
  // classified once.
  const classify = shapeClassifier(pool.rewardAddress, oracle)
  const shapes = new Map<string, Shape>()
  for (const tx of list) {
    const shapeKey = `${tx.from}|${tx.to}|${tx.toType}|${tx.recipientData}`
    let c = shapes.get(shapeKey)
    if (!c) {
      c = classify(tx)
      shapes.set(shapeKey, c)
    }
    if (c.kind === 'OTHER_IN') continue
    const value = BigInt(tx.value)
    const hour = hourOf(tx.timestamp)
    let h = hours.get(hour)
    if (!h) {
      h = { hour, earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, payoutBatches: 0, firstPayoutTs: null, lastPayoutTs: null }
      hours.set(hour, h)
    }
    if (c.kind === 'EARNED') {
      h.earned += value
      continue
    }
    if (c.kind === 'OTHER_OUT') {
      h.otherOut += value
      continue
    }
    if (c.kind === 'RESTAKE_PAYOUT') h.paidRestake += value
    else h.paidDirect += value
    if (c.unverified) h.paidUnverified += value
    if (lastPayout === null || tx.blockNumber - lastPayout >= RUN_GAP_BLOCKS) h.payoutBatches++
    lastPayout = tx.blockNumber
    h.firstPayoutTs = Math.min(h.firstPayoutTs ?? tx.timestamp, tx.timestamp)
    h.lastPayoutTs = Math.max(h.lastPayoutTs ?? 0, tx.timestamp)

    const staker = c.staker!
    const day = dayOf(tx.timestamp)
    const key = `${staker}|${day}`
    const s = stakerDays.get(key)
    if (s) {
      s.received += value
      s.payouts++
    } else stakerDays.set(key, { staker, day, received: value, payouts: 1 })
  }

  return {
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour),
    stakerDays: [...stakerDays.values()],
    lastPayoutBlock: lastPayout,
    txs: list.length,
  }
}

type HourRow = Pick<HourAgg, 'hour' | 'earned' | 'paidRestake' | 'paidDirect' | 'paidUnverified' | 'otherOut' | 'firstPayoutTs' | 'lastPayoutTs'>
type StakerDayRow = Pick<StakerDayAgg, 'staker' | 'day' | 'payouts' | 'received'>

/** pool_hour as D1 returns it (luna as numbers). */
export interface PoolHourDb {
  hour: number
  earned: number
  paid_restake: number
  paid_direct: number
  paid_unverified: number
  other_out: number
  payout_batches: number
  first_payout_ts: number | null
  last_payout_ts: number | null
}

export const hourFromDb = (r: PoolHourDb): HourAgg => ({
  hour: r.hour,
  earned: BigInt(r.earned ?? 0),
  paidRestake: BigInt(r.paid_restake ?? 0),
  paidDirect: BigInt(r.paid_direct ?? 0),
  paidUnverified: BigInt(r.paid_unverified ?? 0),
  otherOut: BigInt(r.other_out ?? 0),
  payoutBatches: r.payout_batches ?? 0,
  firstPayoutTs: r.first_payout_ts ?? null,
  lastPayoutTs: r.last_payout_ts ?? null,
})

// RUN_GAP_BLOCKS in time (one block per second)
export const RUN_GAP_MS = RUN_GAP_BLOCKS * 1000
// A stream is a pool paying (about) every batch: a run of at least STREAM_MIN_HOURS consecutive full
// payout hours whose typical paid/earned is anchored to earnings (STREAM_RATIO), every hour within
// STREAM_TRACK of it, the running difference never above one hour's payouts. Anchoring is what rules
// out a slow distribution of a long cycle: it pays a steady multiple of the hour's earnings too, but
// a separate run spans at most 3/4 of its cycle (the run gap is a quarter cycle), so it pays at least
// 4/3 of the payout rate per hour, above 1.1 for any honest rate over 83 %. Live streams sit at
// 0.97-1.03 (one minus the fee, paid within minutes).
const STREAM_MIN_HOURS = 3
const STREAM_TRACK = 0.1
const STREAM_RATIO = { min: 0.5, max: 1.1 }

export interface WindowRange {
  fromTs: number
  /** how far the data reaches (cursor `reach_ts`), not the wall clock */
  toTs: number
  /** open descent: no data between these (cursor `hole_from_ts`/`hole_to_ts`; fromTs 0 = backfill) */
  hole?: { fromTs: number; toTs: number } | null
  /** published payout interval, if any: confirmation windows reach at least this far back */
  scheduleMs?: number | null
}

export interface PoolWindows {
  window: PoolWindow
  /** same start, earlier ends: what a SHORT must also hold for (pass to poolVerdict as `earlier`) */
  earlier: PoolWindow[]
  /** the pool's value-weighted payout cycle measured from staker_day, ms */
  cycleMs: number | null
}

/**
 * Value-weighted payout cycle from staker_day rows of whole days inside the range, counted from the
 * first day with any payout (the data may start later than the range).
 */
function cycleFromDays(stakerDays: readonly StakerDayRow[], range: { fromTs: number; toTs: number }): number | null {
  const last = dayOf(range.toTs) - 1
  const inRange = stakerDays.filter((d) => d.day > dayOf(range.fromTs) && d.day <= last && d.payouts > 0)
  if (!inRange.length) return null
  // the first day with data may be partial too
  const first = Math.min(...inRange.map((d) => d.day)) + 1
  const full = inRange.filter((d) => d.day >= first)
  if (!full.length || last < first) return null
  return payoutCycleMs(
    full.map((d) => ({ staker: d.staker, value: d.received, count: d.payouts })),
    (last - first + 1) * DAY_MS,
  )
}

/**
 * Payout windows from stored aggregates, the counterpart of shared `buildPoolWindows`.
 *
 * Payout hours merge into runs while one hour's last payout and the next hour's first payout are less
 * than the run gap apart; the gap is a quarter of the pool's own payout cycle (at least RUN_GAP), so a
 * long cycle paid slowly stays one run. Window ends are: the end of every complete run (the next run
 * started, or the data reaches a run gap past it), and inside a stream the last payout of an inner
 * hour, but never within the last cycle (at least an hour) before the data's reach, where a payout may
 * still be going out. The first run only settles accrual from before the data and is dropped, as in
 * `buildPoolWindow`; the window opens at the first end and closes at the last one. `earlier` holds the
 * same window closed at every earlier end within one cycle (published schedule, measured cycle or an
 * hour, whichever is longest) and at the latest end at least that far back.
 *
 * Edge-hour earnings are pro-rated by time, since coinbase rewards arrive evenly once per batch. Only
 * hours starting at or after `fromTs` count, so pass a `fromTs` the data fully covers. With a hole,
 * only the longer side of it is used. cycles = median payouts per staker over the whole days after the
 * opening day: day rows cannot be split, so this undercounts by up to a day, never overcounts.
 */
export function poolWindowsFromAggregates(
  hours: readonly HourRow[],
  stakerDays: readonly StakerDayRow[],
  range: WindowRange,
): PoolWindows {
  // the newest payout we know, for schedule checks, whichever part of the data the window uses
  let lastPayoutTs: number | null = null
  for (const h of hours) {
    if (h.lastPayoutTs !== null && h.hour * HOUR_MS < range.toTs) lastPayoutTs = Math.max(lastPayoutTs ?? 0, h.lastPayoutTs)
  }
  if (range.hole) {
    const below = { fromTs: range.fromTs, toTs: Math.min(range.toTs, range.hole.fromTs) }
    const above = { fromTs: Math.max(range.fromTs, range.hole.toTs), toTs: range.toTs }
    const side = above.toTs - above.fromTs >= below.toTs - below.fromTs ? above : below
    const r = poolWindowsFromAggregates(hours, stakerDays, { ...side, scheduleMs: range.scheduleMs })
    return { ...r, window: { ...r.window, lastPayoutTs }, earlier: r.earlier.map((w) => ({ ...w, lastPayoutTs })) }
  }
  const rows = hours
    .filter((h) => h.hour * HOUR_MS >= range.fromTs && h.hour * HOUR_MS < range.toTs)
    .sort((a, b) => a.hour - b.hour)
  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs, windowStartTs: range.fromTs, windowEndTs: range.toTs,
  }
  const cycleMs = cycleFromDays(stakerDays, range)
  const gapMs = runGapBlocks(cycleMs) * 1000
  const settleMs = Math.max(cycleMs ?? HOUR_MS, HOUR_MS)
  const runs = payoutRuns(rows, gapMs)

  const ends: { ts: number; hour: number }[] = []
  runs.forEach((run, i) => {
    const complete = i < runs.length - 1 || range.toTs - run.endTs >= gapMs
    if (complete) ends.push({ ts: run.endTs, hour: run.hours[run.hours.length - 1]!.hour })
    for (const h of streamHours(run.hours)) {
      if (h.lastPayoutTs! <= range.toTs - settleMs) ends.push({ ts: h.lastPayoutTs!, hour: h.hour })
    }
  })
  ends.sort((a, b) => a.ts - b.ts)
  if (ends.length < 2) return { window: empty, earlier: [], cycleMs }

  const start = ends[0]!
  const main = ends[ends.length - 1]!
  const between = (end: { ts: number; hour: number }) => windowBetween(rows, stakerDays, empty, start, end, range.toTs)
  const window = between(main)
  const confirmMs = Math.max(cycleMs ?? 0, range.scheduleMs ?? 0, HOUR_MS)
  const earlier: PoolWindow[] = []
  let older: { ts: number; hour: number } | null = null
  for (const e of ends.slice(1, -1)) {
    if (e.ts >= main.ts - confirmMs) earlier.push(between(e))
    else older = e
  }
  if (older) earlier.push(between(older))
  return { window, earlier, cycleMs }
}

/** The single window, for callers that do not issue verdicts. */
export function poolWindowFromAggregates(
  hours: readonly HourRow[],
  stakerDays: readonly StakerDayRow[],
  range: WindowRange,
): PoolWindow {
  return poolWindowsFromAggregates(hours, stakerDays, range).window
}

interface Run {
  hours: HourRow[]
  startTs: number
  endTs: number
}

// Payout hours merge into one run while an hour's last payout and the next hour's first payout are
// less than `gapMs` apart.
function payoutRuns(rows: readonly HourRow[], gapMs: number): Run[] {
  const runs: Run[] = []
  for (const h of rows) {
    if (h.lastPayoutTs === null) continue
    const first = h.firstPayoutTs ?? h.lastPayoutTs
    const run = runs[runs.length - 1]
    if (run && first - run.endTs < gapMs) {
      run.hours.push(h)
      run.endTs = h.lastPayoutTs
    } else runs.push({ hours: [h], startTs: first, endTs: h.lastPayoutTs })
  }
  return runs
}

export interface StakerWindow {
  /** first and last midnight: the staker's payouts are summed over the whole UTC days in between */
  fromTs: number
  toTs: number
  /** where the pool had paid out its earnings before each midnight (a complete run end, or in a stream the hour's last payout) */
  startTs: number
  endTs: number
  /** the pool's earnings and payouts between the two settle points */
  earned: bigint
  paid: bigint
  /** the staker's payouts from fromTs (inclusive) to toTs (exclusive), and how many */
  received: bigint
  payouts: number
}

/**
 * One staker's payout window, on whole UTC days because staker_day holds day totals.
 *
 * A midnight can bound the window only where the pool's payouts settle cleanly: no run crosses it
 * and the run before it is complete (the next one started, or the data reaches a run gap past it),
 * or it falls inside a stream (see `poolWindowsFromAggregates`) at least one cycle before the data's
 * reach. Then every payout before the midnight paid earnings up to that settle point, and every
 * payout after it pays later ones, so the staker's payouts over the whole days between the first and
 * the last usable midnight answer exactly the pool's earnings between their settle points. A
 * midnight inside an ordinary run is skipped; when fewer than two usable ones remain, there is no
 * window (null). Runs use the pool's cycle (`cycleMs`, from the pool-wide staker_day rows) for the
 * run gap; with a hole, the longer side is used, as for the pool.
 */
export function userWindowFromAggregates(
  hours: readonly HourRow[],
  userDays: readonly { day: number; received: bigint; payouts: number }[],
  range: WindowRange & { cycleMs: number | null },
): StakerWindow | null {
  if (range.hole) {
    const below = { fromTs: range.fromTs, toTs: Math.min(range.toTs, range.hole.fromTs) }
    const above = { fromTs: Math.max(range.fromTs, range.hole.toTs), toTs: range.toTs }
    const side = above.toTs - above.fromTs >= below.toTs - below.fromTs ? above : below
    return userWindowFromAggregates(hours, userDays, { ...side, cycleMs: range.cycleMs })
  }
  const rows = hours
    .filter((h) => h.hour * HOUR_MS >= range.fromTs && h.hour * HOUR_MS < range.toTs)
    .sort((a, b) => a.hour - b.hour)
  const gapMs = runGapBlocks(range.cycleMs) * 1000
  const settleMs = Math.max(range.cycleMs ?? HOUR_MS, HOUR_MS)
  const runs = payoutRuns(rows, gapMs)
  const streams = new Set<number>()
  for (const run of runs) for (const h of streamHours(run.hours)) streams.add(h.hour)
  const byHour = new Map(rows.map((h) => [h.hour, h]))

  const bounds: { midnight: number; ts: number; hour: number }[] = []
  for (let d = Math.ceil(range.fromTs / DAY_MS); d * DAY_MS <= range.toTs; d++) {
    const midnight = d * DAY_MS
    let i = 0
    while (i < runs.length && runs[i]!.startTs < midnight) i++
    const prev = runs[i - 1]
    if (!prev) continue
    if (prev.endTs < midnight) {
      if (i < runs.length || range.toTs - prev.endTs >= gapMs) bounds.push({ midnight, ts: prev.endTs, hour: prev.hours[prev.hours.length - 1]!.hour })
      continue
    }
    const before = byHour.get(midnight / HOUR_MS - 1)
    if (before?.lastPayoutTs != null && streams.has(before.hour) && midnight <= range.toTs - settleMs) {
      bounds.push({ midnight, ts: before.lastPayoutTs, hour: before.hour })
    }
  }
  if (bounds.length < 2) return null
  const a = bounds[0]!
  const b = bounds[bounds.length - 1]!
  if (b.ts <= a.ts) return null

  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs: null, windowStartTs: a.ts, windowEndTs: b.ts,
  }
  const w = windowBetween(rows, [], empty, a, b, range.toTs)
  let received = 0n
  let payouts = 0
  for (const u of userDays) {
    if (u.day < a.midnight / DAY_MS || u.day >= b.midnight / DAY_MS) continue
    received += u.received
    payouts += u.payouts
  }
  return { fromTs: a.midnight, toTs: b.midnight, startTs: a.ts, endTs: b.ts, earned: w.earned, paid: w.paidRestake + w.paidDirect, received, payouts }
}

// Inner hours of a run that is a stream (see STREAM_MIN_HOURS), or none.
function streamHours(hs: readonly HourRow[]): HourRow[] {
  const inner = hs.slice(1, -1)
  if (inner.length < STREAM_MIN_HOURS) return []
  // a run that skips hours (the gap allows it) pays in bursts, not every batch
  for (let k = 1; k < hs.length; k++) if (hs[k]!.hour !== hs[k - 1]!.hour + 1) return []
  const ratios: number[] = []
  for (const h of inner) {
    if (h.earned <= 0n) return []
    ratios.push(Number(h.paidRestake + h.paidDirect) / Number(h.earned))
  }
  const typical = [...ratios].sort((a, b) => a - b)[ratios.length >> 1]!
  if (!(typical >= STREAM_RATIO.min && typical <= STREAM_RATIO.max)) return []
  if (ratios.some((r) => Math.abs(r - typical) > STREAM_TRACK * typical)) return []
  // the running difference may never exceed one average hour's payouts
  let carry = 0
  let earned = 0
  for (let k = 0; k < inner.length; k++) {
    const h = inner[k]!
    carry += Number(h.paidRestake + h.paidDirect) - typical * Number(h.earned)
    earned += Number(h.earned)
    if (Math.abs(carry) > (typical * earned) / (k + 1)) return []
  }
  return inner
}

function windowBetween(
  rows: readonly HourRow[],
  stakerDays: readonly StakerDayRow[],
  empty: PoolWindow,
  start: { ts: number; hour: number },
  end: { ts: number; hour: number },
  toTs: number,
): PoolWindow {
  const part = (v: bigint, ms: number, covered = HOUR_MS) =>
    (v * BigInt(Math.max(0, Math.min(covered, ms)))) / BigInt(Math.max(1, covered))
  const endCovered = Math.min(HOUR_MS, toTs - end.hour * HOUR_MS)
  const startRow = rows.find((h) => h.hour === start.hour)!

  const w: PoolWindow = { ...empty, windowStartTs: start.ts, windowEndTs: end.ts }
  w.earned += part(startRow.earned, (start.hour + 1) * HOUR_MS - start.ts)
  for (const h of rows) {
    if (h.hour <= start.hour || h.hour > end.hour) continue
    w.earned += h.hour === end.hour ? part(h.earned, end.ts - h.hour * HOUR_MS, endCovered) : h.earned
    w.paidRestake += h.paidRestake
    w.paidDirect += h.paidDirect
    w.paidUnverified += h.paidUnverified
    w.otherOut += h.otherOut
  }

  const fromDay = dayOf(start.ts)
  const toDay = dayOf(end.ts)
  const perStaker = new Map<string, number>()
  for (const s of stakerDays) {
    if (s.day <= fromDay || s.day > toDay) continue
    perStaker.set(s.staker, (perStaker.get(s.staker) ?? 0) + s.payouts)
  }
  const counts = [...perStaker.values()].sort((a, b) => a - b)
  if (counts.length) {
    const m = counts.length >> 1
    w.cycles = counts.length % 2 ? counts[m]! : Math.floor((counts[m - 1]! + counts[m]!) / 2)
  }
  return w
}
