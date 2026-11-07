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
    return { kind: 'RESTAKE_PAYOUT', staker: addressFromBytesHex(tx.recipientData.slice(2)), value }
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
  otherOut: bigint
  cycles: number
  lastPayoutTs: number | null
  windowStartTs: number
  windowEndTs: number
}

export const CYCLE_GAP_BLOCKS = 120

// Payout txs at most CYCLE_GAP_BLOCKS apart form one cycle (a payout batch). The first cycle only
// settles accrual from before the data starts, so the window opens after it and closes at the last
// payout: anything earned later is pending, not short.
export function buildPoolWindow(
  txs: NimTx[],
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
): PoolWindow {
  const sorted = [...txs].sort((a, b) => a.blockNumber - b.blockNumber)
  const items = sorted.map((tx) => ({ tx, c: classifyTx(tx, pool, isStakerOfPool) }))
  const isPayout = (k: PayoutTxKind) => k === 'RESTAKE_PAYOUT' || k === 'DIRECT_PAYOUT'

  const clusters: typeof items[] = []
  for (const it of items) {
    if (!isPayout(it.c.kind)) continue
    const last = clusters[clusters.length - 1]
    if (last && it.tx.blockNumber - last[last.length - 1]!.tx.blockNumber <= CYCLE_GAP_BLOCKS) last.push(it)
    else clusters.push([it])
  }

  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs: null, windowStartTs: sorted[0]?.timestamp ?? 0, windowEndTs: sorted[sorted.length - 1]?.timestamp ?? 0,
  }
  if (clusters.length < 2) return empty

  const used = clusters.slice(1)
  const startBlock = clusters[0]![clusters[0]!.length - 1]!.tx.blockNumber
  const lastCluster = used[used.length - 1]!
  const endItem = lastCluster[lastCluster.length - 1]!
  const endBlock = endItem.tx.blockNumber

  const w: PoolWindow = {
    ...empty,
    cycles: used.length,
    lastPayoutTs: endItem.tx.timestamp,
    windowStartTs: clusters[0]![clusters[0]!.length - 1]!.tx.timestamp,
    windowEndTs: endItem.tx.timestamp,
  }
  for (const { tx, c } of items) {
    if (tx.blockNumber <= startBlock || tx.blockNumber > endBlock) continue
    if (c.kind === 'EARNED') w.earned += c.value
    else if (c.kind === 'RESTAKE_PAYOUT') w.paidRestake += c.value
    else if (c.kind === 'DIRECT_PAYOUT') w.paidDirect += c.value
    else if (c.kind === 'OTHER_OUT') w.otherOut += c.value
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
  if (w.cycles < MIN_CYCLES || w.earned === 0n) {
    return out('NOT_ENOUGH_DATA', null, [`Only ${w.cycles} complete payout cycle(s) with ${w.earned} luna earned in the window; need at least ${MIN_CYCLES}.`])
  }

  const ppm = (a: bigint) => Number((a * 1_000_000n) / w.earned) / 1_000_000
  const ratio = ppm(w.paidRestake + w.paidDirect)
  const otherShare = ppm(w.otherOut)

  if (otherShare >= 0.3) {
    return out('CANT_VERIFY_ROUTED', ratio, [`${(otherShare * 100).toFixed(1)}% of earnings leave the reward address to non-staker destinations.`])
  }
  if (pool.scheduleMs !== null && w.lastPayoutTs !== null && nowTs - w.lastPayoutTs > 2 * pool.scheduleMs + HOUR_MS) {
    return out('BEHIND_SCHEDULE', ratio, ['The last payout is more than twice the advertised interval ago.'])
  }
  if (ratio >= expectedRatio - TOLERANCE) {
    return out('PAID_AS_PROMISED', ratio, [`Paid ${(ratio * 100).toFixed(1)}% of earnings against ${(expectedRatio * 100).toFixed(1)}% promised.`])
  }
  if (ratio < expectedRatio - SHORT_MARGIN && otherShare < 0.05) {
    return out('SHORT', ratio, [`Paid ${(ratio * 100).toFixed(1)}% of earnings against ${(expectedRatio * 100).toFixed(1)}% promised over ${w.cycles} cycles.`])
  }
  return out('NOT_ENOUGH_DATA', ratio, ['Payout ratio is below the promise but inside the margin where a shortfall cannot be called with confidence.'])
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
