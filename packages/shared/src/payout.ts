import type { Verdict } from './errors'
import { COINBASE_ADDRESS, STAKING_CONTRACT, addressFromBytesHex, normalizeAddress, type NimTx } from './nim'

export type PayoutTxKind = 'EARNED' | 'RESTAKE_PAYOUT' | 'DIRECT_PAYOUT' | 'OTHER_OUT' | 'OTHER_IN'

export interface Classified {
  kind: PayoutTxKind
  staker?: string
  value: bigint
  // direct payout accepted without a staker-set check
  unverified?: boolean
}

const COINBASE = normalizeAddress(COINBASE_ADDRESS)
const STAKING = normalizeAddress(STAKING_CONTRACT)

export function classifyTx(
  tx: NimTx,
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
): Classified {
  const value = BigInt(tx.value)
  const reward = normalizeAddress(pool.rewardAddress)
  const from = normalizeAddress(tx.from)
  const to = normalizeAddress(tx.to)

  if (to === reward && from !== reward) {
    return { kind: from === COINBASE ? 'EARNED' : 'OTHER_IN', value }
  }
  if (from !== reward) return { kind: 'OTHER_IN', value }

  if (to === STAKING && tx.toType === 3 && /^06[0-9a-fA-F]{40}$/.test(tx.recipientData)) {
    const staker = addressFromBytesHex(tx.recipientData.slice(2))
    const known = isStakerOfPool(staker)
    if (known === false) return { kind: 'OTHER_OUT', value }
    return known === undefined
      ? { kind: 'RESTAKE_PAYOUT', staker, value, unverified: true }
      : { kind: 'RESTAKE_PAYOUT', staker, value }
  }
  if (tx.toType === 0 && to !== reward) {
    const staker = isStakerOfPool(tx.to)
    if (staker === false) return { kind: 'OTHER_OUT', value }
    return staker === undefined
      ? { kind: 'DIRECT_PAYOUT', staker: tx.to, value, unverified: true }
      : { kind: 'DIRECT_PAYOUT', staker: tx.to, value }
  }
  return { kind: 'OTHER_OUT', value }
}

export interface PoolWindow {
  earned: bigint
  paidRestake: bigint
  paidDirect: bigint
  // part of paidRestake/paidDirect sent to recipients that were not checked against the staker set
  paidUnverified: bigint
  otherOut: bigint
  cycles: number
  lastPayoutTs: number | null
  windowStartTs: number
  windowEndTs: number
}

// Payouts fewer than this many blocks apart belong to one run (one scheduled distribution; a pool
// may send its restake and direct legs a couple of minutes apart).
export const RUN_GAP_BLOCKS = 300

// The first run only settles accrual from before the data starts, so the whole run is dropped and
// the window opens after it; it closes at the end of the last run, since later earnings are pending,
// not short. cycles = median number of payouts a staker received inside the window.
export function buildPoolWindow(
  txs: NimTx[],
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
): PoolWindow {
  const sorted = [...txs].sort((a, b) => a.blockNumber - b.blockNumber)
  const items = sorted.map((tx) => ({ tx, c: classifyTx(tx, pool, isStakerOfPool) }))
  const isPayout = (k: PayoutTxKind) => k === 'RESTAKE_PAYOUT' || k === 'DIRECT_PAYOUT'

  const runs: (typeof items)[] = []
  for (const it of items) {
    if (!isPayout(it.c.kind)) continue
    const last = runs[runs.length - 1]
    if (last && it.tx.blockNumber - last[last.length - 1]!.tx.blockNumber < RUN_GAP_BLOCKS) last.push(it)
    else runs.push([it])
  }

  const newest = runs.length ? runs[runs.length - 1]![runs[runs.length - 1]!.length - 1]!.tx : null
  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs: newest?.timestamp ?? null,
    windowStartTs: sorted[0]?.timestamp ?? 0,
    windowEndTs: sorted[sorted.length - 1]?.timestamp ?? 0,
  }
  if (runs.length < 2) return empty

  const startTx = runs[0]![runs[0]!.length - 1]!.tx
  const endTx = newest!
  const w: PoolWindow = { ...empty, windowStartTs: startTx.timestamp, windowEndTs: endTx.timestamp }

  const perStaker = new Map<string, number>()
  for (const { tx, c } of items) {
    if (tx.blockNumber <= startTx.blockNumber || tx.blockNumber > endTx.blockNumber) continue
    if (c.kind === 'EARNED') w.earned += c.value
    else if (c.kind === 'OTHER_OUT') w.otherOut += c.value
    else if (isPayout(c.kind)) {
      if (c.kind === 'RESTAKE_PAYOUT') w.paidRestake += c.value
      else w.paidDirect += c.value
      if (c.unverified) w.paidUnverified += c.value
      const key = normalizeAddress(c.staker ?? tx.to)
      perStaker.set(key, (perStaker.get(key) ?? 0) + 1)
    }
  }
  const counts = [...perStaker.values()].sort((x, y) => x - y)
  if (counts.length) {
    const m = counts.length >> 1
    w.cycles = counts.length % 2 ? counts[m]! : Math.floor((counts[m - 1]! + counts[m]!) / 2)
  }
  return w
}

export const TOLERANCE = 0.02
export const SHORT_MARGIN = 0.05
export const MIN_CYCLES = 3
const HOUR_MS = 3_600_000

export function poolVerdict(
  w: PoolWindow,
  pool: { fee: number; payoutType: 'restake' | 'direct' | 'none'; scheduleMs: number | null },
  nowTs: number,
): { verdict: Verdict; ratio: number | null; expectedRatio: number; reasons: string[] } {
  const expectedRatio = 1 - pool.fee
  const out = (verdict: Verdict, ratio: number | null, reasons: string[]) => ({ verdict, ratio, expectedRatio, reasons })

  if (pool.payoutType === 'none') return out('NO_PAYOUTS_BY_DESIGN', null, ['Pool does not pay out; rewards are not distributed to stakers.'])
  if (pool.scheduleMs !== null && w.lastPayoutTs !== null && nowTs - w.lastPayoutTs > 2 * pool.scheduleMs + HOUR_MS) {
    return out('BEHIND_SCHEDULE', null, ['The last payout is more than twice the advertised interval ago.'])
  }
  if (w.cycles < MIN_CYCLES || w.earned === 0n) {
    return out('NOT_ENOUGH_DATA', null, [`Only ${w.cycles} complete payout cycle(s) with ${w.earned} luna earned in the window; need at least ${MIN_CYCLES}.`])
  }

  const ppm = (a: bigint) => Number((a * 1_000_000n) / w.earned) / 1_000_000
  const ratio = ppm(w.paidRestake + w.paidDirect)
  const otherShare = ppm(w.otherOut)
  const pct = (x: number) => (x * 100).toFixed(1)
  const note = w.paidUnverified > 0n ? [`${pct(ppm(w.paidUnverified))}% of earnings was paid to recipients not checked against the staker set.`] : []

  if (otherShare >= 0.3) {
    return out('CANT_VERIFY_ROUTED', ratio, [`${pct(otherShare)}% of earnings leave the reward address to non-staker destinations.`, ...note])
  }
  if (ratio >= expectedRatio - TOLERANCE) {
    return out('PAID_AS_PROMISED', ratio, [`Paid ${pct(ratio)}% of earnings against ${pct(expectedRatio)}% promised.`, ...note])
  }
  if (ratio < expectedRatio - SHORT_MARGIN) {
    if (otherShare < 0.05) {
      return out('SHORT', ratio, [`Paid ${pct(ratio)}% of earnings against ${pct(expectedRatio)}% promised over ${w.cycles} cycles.`, ...note])
    }
    return out('NOT_ENOUGH_DATA', ratio, ['Other outflows too large to conclude.', ...note])
  }
  return out('NOT_ENOUGH_DATA', ratio, ['Paid ratio within the uncertainty band; not conclusive.', ...note])
}

export function userExpected(args: { userActiveStake: bigint; poolStake: bigint; poolEarned: bigint; fee: number }): bigint {
  if (args.poolStake <= 0n || args.userActiveStake <= 0n) return 0n
  const net = BigInt(Math.round((1 - args.fee) * 1_000_000))
  return (args.poolEarned * args.userActiveStake * net) / (args.poolStake * 1_000_000n)
}

export function userVerdict(args: { expected: bigint; received: bigint; cycles: number }): { verdict: Verdict; pct: number | null } {
  if (args.cycles < MIN_CYCLES || args.expected <= 0n) return { verdict: 'NOT_ENOUGH_DATA', pct: null }
  const pct = Number((args.received * 1_000_000n) / args.expected) / 1_000_000
  if (pct >= 1 - TOLERANCE) return { verdict: 'PAID_AS_PROMISED', pct }
  if (pct < 1 - SHORT_MARGIN) return { verdict: 'SHORT', pct }
  return { verdict: 'NOT_ENOUGH_DATA', pct }
}
