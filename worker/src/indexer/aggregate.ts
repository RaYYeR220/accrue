import { RUN_GAP_BLOCKS, addressFromBytesHex, classifyTx, normalizeAddress, payoutCycleMs, runGapBlocks, type NimTx, type PayoutTxKind, type PoolWindow } from '@accrue/shared'

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
  for (const hex of restakeData) out.add(stakerFromHex(hex))
  return out
}

const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

/**
 * Same result as shared `addressFromBytesHex`, with integer bit math instead of bit strings: the
 * cron decodes every restake recipient of a tick and the free plan allows 10 ms of CPU.
 */
export function stakerFromHex(hex: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return addressFromBytesHex(hex)
  let body = ''
  let acc = 0
  let bits = 0
  for (let i = 0; i < 40; i += 2) {
    acc = ((acc << 8) | parseInt(hex.slice(i, i + 2), 16)) & 0xfff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      body += B32[(acc >> bits) & 31]
    }
  }
  let rem = 0
  for (const ch of `${body}NQ00`) {
    const code = ch.charCodeAt(0)
    rem = code >= 65 ? (rem * 100 + code - 55) % 97 : (rem * 10 + code - 48) % 97
  }
  return `NQ${String(98 - rem).padStart(2, '0')} ${body.match(/.{4}/g)!.join(' ')}`
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

  // Apart from `value`, classifyTx is a pure function of these four fields (and the oracle), and a
  // tick sees the same few hundred stakers over and over; decoding the staker address from
  // recipientData is the expensive part, so classify each distinct shape once.
  const shapes = new Map<string, { kind: PayoutTxKind; staker: string | null; unverified: boolean }>()
  for (const tx of list) {
    const shapeKey = `${tx.from}|${tx.to}|${tx.toType}|${tx.recipientData}`
    let shape = shapes.get(shapeKey)
    if (!shape) {
      const leg: PayoutLeg = isRestakeTx(tx) ? 'restake' : 'direct'
      const full = classifyTx(tx, pool, (addr) => oracle(addr, leg))
      const paid = full.kind === 'RESTAKE_PAYOUT' || full.kind === 'DIRECT_PAYOUT'
      shape = { kind: full.kind, staker: paid ? canonicalAddress(full.staker ?? tx.to) : null, unverified: !!full.unverified }
      shapes.set(shapeKey, shape)
    }
    const c = { ...shape, value: BigInt(tx.value) }
    if (c.kind === 'OTHER_IN') continue
    const hour = hourOf(tx.timestamp)
    let h = hours.get(hour)
    if (!h) {
      h = { hour, earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, payoutBatches: 0, firstPayoutTs: null, lastPayoutTs: null }
      hours.set(hour, h)
    }
    if (c.kind === 'EARNED') {
      h.earned += c.value
      continue
    }
    if (c.kind === 'OTHER_OUT') {
      h.otherOut += c.value
      continue
    }
    if (c.kind === 'RESTAKE_PAYOUT') h.paidRestake += c.value
    else h.paidDirect += c.value
    if (c.unverified) h.paidUnverified += c.value
    if (lastPayout === null || tx.blockNumber - lastPayout >= RUN_GAP_BLOCKS) h.payoutBatches++
    lastPayout = tx.blockNumber
    h.firstPayoutTs = Math.min(h.firstPayoutTs ?? tx.timestamp, tx.timestamp)
    h.lastPayoutTs = Math.max(h.lastPayoutTs ?? 0, tx.timestamp)

    const staker = c.staker!
    const day = dayOf(tx.timestamp)
    const key = `${staker}|${day}`
    const s = stakerDays.get(key)
    if (s) {
      s.received += c.value
      s.payouts++
    } else stakerDays.set(key, { staker, day, received: c.value, payouts: 1 })
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
// A stream is a run of at least this many full payout hours that each pay within STREAM_TRACK of the
// run's typical paid/earned, with the running difference never more than one hour's payouts: a pool
// paying (about) every batch. A slow distribution of a long cycle fails one of the two.
const STREAM_MIN_HOURS = 3
const STREAM_TRACK = 0.1

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

  const runs: { hours: HourRow[]; endTs: number }[] = []
  for (const h of rows) {
    if (h.lastPayoutTs === null) continue
    const first = h.firstPayoutTs ?? h.lastPayoutTs
    const run = runs[runs.length - 1]
    if (run && first - run.endTs < gapMs) {
      run.hours.push(h)
      run.endTs = h.lastPayoutTs
    } else runs.push({ hours: [h], endTs: h.lastPayoutTs })
  }

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

// Inner hours of a run that is a stream (see STREAM_MIN_HOURS), or none.
function streamHours(hs: readonly HourRow[]): HourRow[] {
  const inner = hs.slice(1, -1)
  if (inner.length < STREAM_MIN_HOURS) return []
  const ratios: number[] = []
  for (const h of inner) {
    if (h.earned <= 0n) return []
    ratios.push(Number(h.paidRestake + h.paidDirect) / Number(h.earned))
  }
  const typical = [...ratios].sort((a, b) => a - b)[ratios.length >> 1]!
  if (!(typical > 0) || ratios.some((r) => Math.abs(r - typical) > STREAM_TRACK * typical)) return []
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
