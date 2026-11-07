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
      h = { hour, earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, payoutBatches: 0, lastPayoutTs: null }
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

type HourRow = Pick<HourAgg, 'hour' | 'earned' | 'paidRestake' | 'paidDirect' | 'paidUnverified' | 'otherOut' | 'lastPayoutTs'>
type StakerDayRow = Pick<StakerDayAgg, 'staker' | 'day' | 'payouts'>

/**
 * Rebuilds the payout window of shared `buildPoolWindow` from stored aggregates.
 * The window opens at the newest payout of the first hour that has payouts (that hour settles
 * accrual from before the data) and closes at the newest payout of the last such hour. Edge-hour
 * earnings are pro-rated by time, since coinbase rewards arrive evenly once per batch; `toTs` is
 * how far the data reaches, so a partly indexed last hour is pro-rated over what it covers.
 * Only hours starting at or after `fromTs` count, so pass a `fromTs` the data fully covers.
 * cycles = median payouts per staker over the whole days after the opening day: day rows cannot be
 * split, so this undercounts by up to a day rather than ever overcounting.
 */
export function poolWindowFromAggregates(
  hours: readonly HourRow[],
  stakerDays: readonly StakerDayRow[],
  range: { fromTs: number; toTs: number },
): PoolWindow {
  const rows = hours
    .filter((h) => h.hour * HOUR_MS >= range.fromTs && h.hour * HOUR_MS < range.toTs)
    .sort((a, b) => a.hour - b.hour)
  const payoutHours = rows.filter((h) => h.lastPayoutTs !== null)
  const lastPayoutTs = payoutHours.length ? payoutHours[payoutHours.length - 1]!.lastPayoutTs : null
  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs, windowStartTs: range.fromTs, windowEndTs: range.toTs,
  }
  if (payoutHours.length < 2) return empty

  const first = payoutHours[0]!
  const last = payoutHours[payoutHours.length - 1]!
  const startTs = first.lastPayoutTs!
  const endTs = last.lastPayoutTs!
  const part = (v: bigint, ms: number, covered = HOUR_MS) =>
    (v * BigInt(Math.max(0, Math.min(covered, ms)))) / BigInt(Math.max(1, covered))
  const lastCovered = Math.min(HOUR_MS, range.toTs - last.hour * HOUR_MS)

  const w: PoolWindow = { ...empty, windowStartTs: startTs, windowEndTs: endTs }
  w.earned += part(first.earned, (first.hour + 1) * HOUR_MS - startTs)
  for (const h of rows) {
    if (h.hour <= first.hour || h.hour > last.hour) continue
    w.earned += h.hour === last.hour ? part(h.earned, endTs - h.hour * HOUR_MS, lastCovered) : h.earned
    w.paidRestake += h.paidRestake
    w.paidDirect += h.paidDirect
    w.paidUnverified += h.paidUnverified
    w.otherOut += h.otherOut
  }

  const fromDay = dayOf(startTs)
  const toDay = dayOf(endTs)
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
