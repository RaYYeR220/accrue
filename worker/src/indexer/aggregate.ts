import { RUN_GAP_BLOCKS, addressFromBytesHex, classifyTx, normalizeAddress, type NimTx, type PayoutTxKind, type PoolWindow } from '@accrue/shared'

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
type StakerDayRow = Pick<StakerDayAgg, 'staker' | 'day' | 'payouts'>

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
// A run spanning at least this many payout hours whose payouts track the hour's earnings is a
// stream (a pool paying every batch): any of its inner hours is a safe place to cut.
const STREAM_MIN_HOURS = 3

export interface WindowRange {
  fromTs: number
  /** how far the data reaches (cursor `reach_ts`), not the wall clock */
  toTs: number
  /** open descent: no data between these (cursor `hole_from_ts`/`hole_to_ts`; fromTs 0 = backfill) */
  hole?: { fromTs: number; toTs: number } | null
}

/**
 * Rebuilds the payout window of shared `buildPoolWindow` from stored aggregates.
 *
 * The window runs between two run boundaries, the first and the last one in range (the first run
 * only settles accrual from before the data, so it is dropped, as in `buildPoolWindow`). Payout
 * hours merge into runs when one hour's last payout and the next hour's first payout are less than
 * RUN_GAP apart. A boundary is the end of a complete run (the next run started, or the data reaches
 * RUN_GAP past it), or, inside a stream, the last payout of an inner hour. A run still in progress
 * at the end of the data never closes a window: payouts still to come would be missing while the
 * earnings they settle are already counted, which reads an honest pool as short.
 *
 * Edge-hour earnings are pro-rated by time, since coinbase rewards arrive evenly once per batch.
 * Only hours starting at or after `fromTs` count, so pass a `fromTs` the data fully covers. With a
 * hole, only the longer side of it is used, so a window never spans missing data.
 * cycles = median payouts per staker over the whole days after the opening day: day rows cannot be
 * split, so this undercounts by up to a day rather than ever overcounting.
 */
export function poolWindowFromAggregates(
  hours: readonly HourRow[],
  stakerDays: readonly StakerDayRow[],
  range: WindowRange,
): PoolWindow {
  if (range.hole) {
    const below = { fromTs: range.fromTs, toTs: Math.min(range.toTs, range.hole.fromTs) }
    const above = { fromTs: Math.max(range.fromTs, range.hole.toTs), toTs: range.toTs }
    const side = above.toTs - above.fromTs >= below.toTs - below.fromTs ? above : below
    return poolWindowFromAggregates(hours, stakerDays, side)
  }
  const rows = hours
    .filter((h) => h.hour * HOUR_MS >= range.fromTs && h.hour * HOUR_MS < range.toTs)
    .sort((a, b) => a.hour - b.hour)
  const payoutHours = rows.filter((h) => h.lastPayoutTs !== null)
  const lastPayoutTs = payoutHours.length ? payoutHours[payoutHours.length - 1]!.lastPayoutTs : null
  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs, windowStartTs: range.fromTs, windowEndTs: range.toTs,
  }

  const runs: { hours: HourRow[]; endTs: number }[] = []
  for (const h of payoutHours) {
    const first = h.firstPayoutTs ?? h.lastPayoutTs!
    const run = runs[runs.length - 1]
    if (run && first - run.endTs < RUN_GAP_MS) {
      run.hours.push(h)
      run.endTs = h.lastPayoutTs!
    } else runs.push({ hours: [h], endTs: h.lastPayoutTs! })
  }
  const bounds: { ts: number; hour: number }[] = []
  runs.forEach((run, i) => {
    const hs = run.hours
    if (hs.length >= STREAM_MIN_HOURS) {
      for (const h of hs.slice(1, -1)) {
        const paid = h.paidRestake + h.paidDirect
        if (h.earned > 0n && paid * 2n >= h.earned && paid * 2n <= h.earned * 3n) bounds.push({ ts: h.lastPayoutTs!, hour: h.hour })
      }
    }
    const complete = i < runs.length - 1 || range.toTs - run.endTs >= RUN_GAP_MS
    if (complete) bounds.push({ ts: run.endTs, hour: hs[hs.length - 1]!.hour })
  })
  bounds.sort((a, b) => a.ts - b.ts)
  if (bounds.length < 2) return empty

  const start = bounds[0]!
  const end = bounds[bounds.length - 1]!
  const part = (v: bigint, ms: number, covered = HOUR_MS) =>
    (v * BigInt(Math.max(0, Math.min(covered, ms)))) / BigInt(Math.max(1, covered))
  const endCovered = Math.min(HOUR_MS, range.toTs - end.hour * HOUR_MS)
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
