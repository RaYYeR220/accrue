import type { Verdict } from '@accrue/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolRow } from '../src/features/nim/api'
import { RAY } from '../src/features/dollars/accrual'
import { payoutLine } from '../src/screens/nimParts'
import { loadAppStrings } from '../src/screens/strings'
import { dayEstimate, nextPayout, noVerdictView, poolReasonLines, rankPools, scheduleText } from '../src/model/pools'

const H = 3_600_000
const NOW = 1_762_500_000_000

let n = 0
const pool = (o: Partial<PoolRow> = {}): PoolRow => ({
  address: `NQ00 ${String(++n).padStart(4, '0')}`,
  name: `Pool ${n}`,
  fee: 0.1,
  payoutType: 'restake',
  schedule: 'Every 12 hours',
  balanceLuna: 1_000n,
  stakers: 1,
  accent: null,
  logo: null,
  verdict: 'PAID_AS_PROMISED',
  ratio: null,
  expectedRatio: 0.9,
  lastPayoutTs: null,
  reasons: [],
  ...o,
})

describe('rankPools: payout record first, then fee, then size', () => {
  it('orders by what the record says about getting paid', () => {
    const verdicts: (Verdict | null)[] = ['SHORT', 'NO_PAYOUTS_BY_DESIGN', null, 'BEHIND_SCHEDULE', 'CANT_VERIFY_ROUTED', 'NOT_ENOUGH_DATA', 'PAID_AS_PROMISED']
    const ranked = rankPools(verdicts.map(verdict => pool({ verdict, name: String(verdict) })))
    expect(ranked.map(p => p.name)).toEqual(['PAID_AS_PROMISED', 'NOT_ENOUGH_DATA', 'null', 'BEHIND_SCHEDULE', 'CANT_VERIFY_ROUTED', 'SHORT', 'NO_PAYOUTS_BY_DESIGN'])
  })

  it('a pool that lists no payouts goes last even without a verdict', () => {
    const ranked = rankPools([pool({ name: 'none', payoutType: 'none', verdict: null }), pool({ name: 'short', verdict: 'SHORT' })])
    expect(ranked.map(p => p.name)).toEqual(['short', 'none'])
  })

  it('same record: lower fee first, then the bigger pool', () => {
    const ranked = rankPools([
      pool({ name: 'a', fee: 0.1, balanceLuna: 5n }),
      pool({ name: 'b', fee: 0.05, balanceLuna: 1n }),
      pool({ name: 'c', fee: 0.1, balanceLuna: 9n }),
    ])
    expect(ranked.map(p => p.name)).toEqual(['b', 'c', 'a'])
  })

  it('a pool that lists no fee comes after the ones that do, within the same record', () => {
    const ranked = rankPools([
      pool({ name: 'no fee', fee: null, balanceLuna: 9n }),
      pool({ name: 'b', fee: 0.05, balanceLuna: 1n }),
      pool({ name: 'no fee, smaller', fee: null, balanceLuna: 2n }),
      pool({ name: 'a', fee: 0.1, balanceLuna: 5n }),
    ])
    expect(ranked.map(p => p.name)).toEqual(['b', 'a', 'no fee', 'no fee, smaller'])
  })

  it('does not reorder the input array', () => {
    const input = [pool({ verdict: 'SHORT' }), pool()]
    const copy = [...input]
    rankPools(input)
    expect(input).toEqual(copy)
  })
})

describe('nextPayout: when the pool should pay next, from its published schedule', () => {
  it('last payout + interval', () => {
    expect(nextPayout(pool({ schedule: 'Every 12 hours', lastPayoutTs: NOW - 2 * H }), NOW)).toEqual({ kind: 'at', at: NOW + 10 * H, intervalMs: 12 * H, late: false })
  })

  it('past due says so instead of a time in the past', () => {
    expect(nextPayout(pool({ schedule: 'Every 3 hours', lastPayoutTs: NOW - 4 * H }), NOW)).toEqual({ kind: 'at', at: NOW - H, intervalMs: 3 * H, late: true })
  })

  it('no last payout known: only the interval', () => {
    expect(nextPayout(pool({ schedule: 'Every day', lastPayoutTs: null }), NOW)).toEqual({ kind: 'every', intervalMs: 24 * H })
  })

  it('no payouts listed, or a schedule we cannot read', () => {
    expect(nextPayout(pool({ payoutType: 'none', schedule: null }), NOW)).toEqual({ kind: 'none' })
    expect(nextPayout(pool({ schedule: 'whenever' }), NOW)).toEqual({ kind: 'unknown' })
    expect(nextPayout(pool({ schedule: null }), NOW)).toEqual({ kind: 'unknown' })
  })
})

describe('dayEstimate: the "last 24 h" fallback from chain data', () => {
  it('dollars at the current Aave rate on today\'s balance; NIM as the daily average received over the window', () => {
    // 1000 USDT at 3.65 % APR: 0.1 USDT a day
    const rate = (RAY * 365n) / 10_000n
    const est = dayEstimate({ balances: [{ units: 1_000_000_000n, rateRay: rate }], receivedLuna: 700_000n, windowDays: 7 })
    expect(est.dollarsUsd).toBeCloseTo(0.1, 6)
    expect(est.nimLuna).toBe(100_000n)
  })

  it('NIM divides by the window the check measured, not a week: 6 days, or a fraction of a day more or less', () => {
    expect(dayEstimate({ balances: [], receivedLuna: 600_000n, windowDays: 6 }).nimLuna).toBe(100_000n)
    expect(dayEstimate({ balances: [], receivedLuna: 580_000n, windowDays: 5.8 }).nimLuna).toBe(100_000n)
    expect(dayEstimate({ balances: [], receivedLuna: 1_000_000n, windowDays: 6.25 }).nimLuna).toBe(160_000n)
  })

  it('a window shorter than a day gives no daily figure instead of dividing by zero', () => {
    expect(dayEstimate({ balances: [], receivedLuna: 5n, windowDays: 0.3 })).toEqual({ dollarsUsd: 0, nimLuna: null })
    expect(dayEstimate({ balances: [], receivedLuna: 5n, windowDays: Number.NaN })).toEqual({ dollarsUsd: 0, nimLuna: null })
  })

  it('unknown inputs stay unknown', () => {
    expect(dayEstimate({ balances: null, receivedLuna: null, windowDays: 7 })).toEqual({ dollarsUsd: null, nimLuna: null })
    expect(dayEstimate({ balances: [], receivedLuna: 5n, windowDays: 0 })).toEqual({ dollarsUsd: 0, nimLuna: null })
  })
})

describe('noVerdictView: what to say about a pool by the API state, not by its wording', () => {
  const reason = ["The API's own words."]
  it('unchecked: the app line only, never the API reason beside it', () => {
    expect(noVerdictView({ verdict: null, state: 'unchecked', reasons: reason })).toEqual({ reasons: [], unchecked: true })
  })

  it('no fee and not indexed: the API reason alone, no app line', () => {
    expect(noVerdictView({ verdict: null, state: 'no_fee', reasons: reason })).toEqual({ reasons: reason, unchecked: false })
    expect(noVerdictView({ verdict: null, state: 'not_indexed', reasons: reason })).toEqual({ reasons: reason, unchecked: false })
  })

  it('checked: every reason, including not enough data', () => {
    expect(noVerdictView({ verdict: 'NOT_ENOUGH_DATA', state: 'checked', reasons: reason })).toEqual({ reasons: reason, unchecked: false })
  })

  it('an answer without state reads as before: reasons as given, the neutral line only when there is nothing else', () => {
    expect(noVerdictView({ verdict: null, reasons: reason })).toEqual({ reasons: reason, unchecked: false })
    expect(noVerdictView({ verdict: null, reasons: [] })).toEqual({ reasons: [], unchecked: true })
    expect(noVerdictView({ verdict: 'SHORT', reasons: reason })).toEqual({ reasons: reason, unchecked: false })
  })
})

describe('poolReasonLines: the API reasons plus the app facts, none twice', () => {
  const ratio = { text: 'paid 97.2% of earnings against 97.0% promised', covers: ['97.2%', '97.0%'] }
  const last = { text: 'last payout 12:37 PM' }

  it("does not add the ratio line when a reason already states that ratio (Siam Pool's first two lines)", () => {
    expect(poolReasonLines(['Paid 97.2% of earnings against 97.0% promised.', 'The indexer is catching up.'], [ratio, last])).toEqual([
      'Paid 97.2% of earnings against 97.0% promised.',
      'The indexer is catching up.',
      'last payout 12:37 PM',
    ])
  })
  it('adds the ratio line when no reason states it', () => {
    expect(poolReasonLines(['Paid ratio within the uncertainty band; not conclusive.'], [ratio])).toEqual([
      'Paid ratio within the uncertainty band; not conclusive.',
      'paid 97.2% of earnings against 97.0% promised',
    ])
  })
  it('drops repeats inside the API list itself', () => {
    expect(poolReasonLines(['a.', 'A', 'b'], [])).toEqual(['a.', 'b'])
  })
})

describe('scheduleText: the pool free-text schedule never runs into the payout type', () => {
  const s = (schedule: string | null, payoutType: PoolRow['payoutType'] = 'restake') => scheduleText({ schedule, payoutType })
  it('a readable interval is not free text', () => expect(s('Every 12 hours')).toEqual({ inline: null, block: null }))
  it('a sentence goes on its own, with the stray space before the period closed', () => {
    expect(s('Payouts over 10 NIM are instant when NimiqPocket is elected .')).toEqual({ inline: null, block: 'Payouts over 10 NIM are instant when NimiqPocket is elected.' })
  })
  it('a short phrase stays inline', () => expect(s('Daily  at noon')).toEqual({ inline: 'Daily at noon', block: null }))
  it('no schedule and no payouts give nothing', () => {
    expect(s(null)).toEqual({ inline: null, block: null })
    expect(s('Payouts are instant.', 'none')).toEqual({ inline: null, block: null })
  })
})

beforeAll(async () => {
  await loadAppStrings('en')
})

describe('payoutLine: type and interval only, never the free-text schedule', () => {
  it('states the interval it can read', () => expect(payoutLine(pool({ schedule: 'Every 3 hours' }))).toBe('restakes every 3 hours'))
  it('a free-text schedule is left to scheduleText, not glued on', () => {
    expect(payoutLine(pool({ schedule: 'Payouts over 10 NIM are instant when NimiqPocket is elected .' }))).toBe('restakes')
    expect(payoutLine(pool({ schedule: 'Payouts over 10 NIM are instant.', payoutType: 'direct' }))).toBe('pays to your wallet')
  })
  it('no schedule at all says so', () => expect(payoutLine(pool({ schedule: null }))).toBe('restakes on no published schedule'))
})
