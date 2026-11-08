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

// Payouts fewer than this many blocks apart always belong to one run (one scheduled distribution; a
// pool may send its restake and direct legs a couple of minutes apart).
export const RUN_GAP_BLOCKS = 300
const MAX_RUN_GAP_BLOCKS = 6 * 3600

/**
 * How often a pool's payouts reach its stakers, weighted by value: the time between two payouts of
 * the stake-weighted typical staker over `spanMs` of data. null without payouts.
 */
export function payoutCycleMs(payouts: Iterable<{ staker: string; value: bigint; count?: number }>, spanMs: number): number | null {
  const per = new Map<string, { value: number; count: number }>()
  for (const p of payouts) {
    const e = per.get(p.staker) ?? { value: 0, count: 0 }
    e.value += Number(p.value)
    e.count += p.count ?? 1
    per.set(p.staker, e)
  }
  let weight = 0
  let weighted = 0
  for (const e of per.values()) {
    weight += e.value
    weighted += e.value * e.count
  }
  if (weight <= 0 || spanMs <= 0) return null
  return spanMs / (weighted / weight)
}

/**
 * Gap that separates two payout runs: a quarter of the pool's own payout cycle, at least
 * RUN_GAP_BLOCKS. A pool that pays a 12 h cycle one staker every few minutes is one run, not dozens.
 */
export function runGapBlocks(cycleMs: number | null): number {
  if (cycleMs === null || !Number.isFinite(cycleMs)) return RUN_GAP_BLOCKS
  return Math.min(MAX_RUN_GAP_BLOCKS, Math.max(RUN_GAP_BLOCKS, Math.round(cycleMs / 4 / 1000)))
}

type Item = { tx: NimTx; c: Classified }
const isPayout = (k: PayoutTxKind) => k === 'RESTAKE_PAYOUT' || k === 'DIRECT_PAYOUT'

function poolRuns(
  txs: NimTx[],
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
  reachBlock: number | undefined,
) {
  const sorted = [...txs].sort((a, b) => a.blockNumber - b.blockNumber)
  const items: Item[] = sorted.map((tx) => ({ tx, c: classifyTx(tx, pool, isStakerOfPool) }))
  const span = sorted.length ? sorted[sorted.length - 1]!.timestamp - sorted[0]!.timestamp : 0
  const cycleMs = payoutCycleMs(
    items.filter((it) => isPayout(it.c.kind)).map((it) => ({ staker: normalizeAddress(it.c.staker ?? it.tx.to), value: it.c.value })),
    span,
  )
  const gap = runGapBlocks(cycleMs)
  const runs: Item[][] = []
  for (const it of items) {
    if (!isPayout(it.c.kind)) continue
    const last = runs[runs.length - 1]
    if (last && it.tx.blockNumber - last[last.length - 1]!.tx.blockNumber < gap) last.push(it)
    else runs.push([it])
  }
  const newest = runs.length ? runs[runs.length - 1]![runs[runs.length - 1]!.length - 1]!.tx : null
  const reach = reachBlock ?? sorted[sorted.length - 1]?.blockNumber ?? 0
  if (newest && reach - newest.blockNumber < gap) runs.pop()
  const empty: PoolWindow = {
    earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0,
    lastPayoutTs: newest?.timestamp ?? null,
    windowStartTs: sorted[0]?.timestamp ?? 0,
    windowEndTs: sorted[sorted.length - 1]?.timestamp ?? 0,
  }
  return { items, runs, empty, cycleMs }
}

const runEnd = (run: Item[]) => run[run.length - 1]!.tx

function windowToRun(items: Item[], runs: Item[][], empty: PoolWindow, endRun: number): PoolWindow {
  const startTx = runEnd(runs[0]!)
  const endTx = runEnd(runs[endRun]!)
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

// The first run only settles accrual from before the data starts, so the whole run is dropped and
// the window opens after it; it closes at the end of the last complete run, since later earnings are
// pending, not short. Runs are split by a gap scaled to the pool's own payout cycle (runGapBlocks),
// and a run is complete once the data reaches that gap past its last payout (`reachBlock`,
// default: the newest tx given); data ending inside a run would count the run's earnings without all
// of its payouts. cycles = median number of payouts a staker received inside the window.
export function buildPoolWindow(
  txs: NimTx[],
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
  opts: { reachBlock?: number } = {},
): PoolWindow {
  const { items, runs, empty } = poolRuns(txs, pool, isStakerOfPool, opts.reachBlock)
  return runs.length < 2 ? empty : windowToRun(items, runs, empty, runs.length - 1)
}

/**
 * The window of `buildPoolWindow` plus the windows a SHORT verdict must also hold for (pass them to
 * `poolVerdict` as `earlier`): same start, ending at every earlier complete run within one cycle of
 * the main end, and at the latest run end at least one cycle before it. One cycle = the longest of
 * the published schedule, the pool's measured payout cycle and an hour. A payout still in progress
 * at one end cannot be in progress at all of them.
 */
export function buildPoolWindows(
  txs: NimTx[],
  pool: { rewardAddress: string },
  isStakerOfPool: (addr: string) => boolean | undefined,
  opts: { reachBlock?: number; scheduleMs?: number | null } = {},
): { window: PoolWindow; earlier: PoolWindow[] } {
  const { items, runs, empty, cycleMs } = poolRuns(txs, pool, isStakerOfPool, opts.reachBlock)
  if (runs.length < 2) return { window: empty, earlier: [] }
  const last = runs.length - 1
  const window = windowToRun(items, runs, empty, last)
  const cycle = Math.max(cycleMs ?? 0, opts.scheduleMs ?? 0, 3_600_000)
  const earlier: PoolWindow[] = []
  let older = -1
  for (let j = 1; j < last; j++) {
    const end = runEnd(runs[j]!).timestamp
    if (end >= window.windowEndTs - cycle) earlier.push(windowToRun(items, runs, empty, j))
    else older = j
  }
  if (older >= 1) earlier.push(windowToRun(items, runs, empty, older))
  return { window, earlier }
}

export const TOLERANCE = 0.02
export const SHORT_MARGIN = 0.05
export const MIN_CYCLES = 3
const HOUR_MS = 3_600_000

// A confirmation window only has to show the shortfall at another end; the main window already
// carries the MIN_CYCLES requirement.
function isShort(w: PoolWindow, expectedRatio: number): boolean {
  if (w.cycles < 1 || w.earned <= 0n) return false
  const ppm = (a: bigint) => Number((a * 1_000_000n) / w.earned) / 1_000_000
  return ppm(w.paidRestake + w.paidDirect) < expectedRatio - SHORT_MARGIN && ppm(w.otherOut) < 0.05
}

/**
 * `earlier`: windows with the same start ending earlier (see `buildPoolWindows`); SHORT is only
 * issued when every one of them is short too.
 */
export function poolVerdict(
  w: PoolWindow,
  pool: { fee: number; payoutType: 'restake' | 'direct' | 'none'; scheduleMs: number | null },
  nowTs: number,
  opts: { earlier?: PoolWindow[] } = {},
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
      // the shortfall must hold at more than one window end: data that stops while a payout is still
      // going out reads short at that end only
      const confirmed = !!opts.earlier?.length && opts.earlier.every((e) => isShort(e, expectedRatio))
      if (confirmed) {
        return out('SHORT', ratio, [`Paid ${pct(ratio)}% of earnings against ${pct(expectedRatio)}% promised over ${w.cycles} cycles.`, ...note])
      }
      return out('NOT_ENOUGH_DATA', ratio, ['A payout may still be in progress: an earlier window end does not confirm the shortfall.', ...note])
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
