// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { RAY } from '../src/features/dollars/accrual'
import { baselineFrom, loadVisit, nextVisit, saveVisit, sinceView, VISIT_GAP_MS, VISIT_KEY, type Snapshot } from '../src/model/visit'

const H = 3_600_000
const T0 = 1_762_500_000_000

const snap = (at: number, over: Partial<Snapshot> = {}): Snapshot => ({
  at,
  dollars: { USDT0: { scaled: '100000000', index: (RAY + RAY / 100n).toString() } },
  nimStakedLuna: '100000000',
  ...over,
})

afterEach(() => localStorage.clear())

describe('which snapshot "since your last visit" compares against', () => {
  it('nothing stored: no visit to compare with', () => {
    expect(baselineFrom(null, T0)).toBeNull()
  })

  it('the last snapshot, once the visit is over (more than the gap ago)', () => {
    const last = snap(T0 - 2 * H)
    expect(baselineFrom({ last, base: null }, T0)).toBe(last)
  })

  it('a quick reopen keeps comparing with the visit before it, not with a few seconds ago', () => {
    const before = snap(T0 - 26 * H)
    const last = snap(T0 - 60_000)
    expect(baselineFrom({ last, base: before }, T0)).toBe(before)
    expect(baselineFrom({ last, base: null }, T0)).toBeNull()
    expect(VISIT_GAP_MS).toBe(30 * 60_000)
  })

  it('the stored record carries this visit forward with its baseline', () => {
    const base = snap(T0 - 26 * H)
    const current = snap(T0)
    expect(nextVisit(base, current)).toEqual({ last: current, base })
  })

  it('survives a reload through localStorage and ignores junk', () => {
    const v = { last: snap(T0), base: null }
    saveVisit(v)
    expect(loadVisit()).toEqual(v)
    localStorage.setItem(VISIT_KEY, '{"last":42}')
    expect(loadVisit()).toBeNull()
    localStorage.setItem(VISIT_KEY, 'not json')
    expect(loadVisit()).toBeNull()
  })
})

describe('sinceView', () => {
  const day = { dollarsUsd: 0.01, nimLuna: 150_000n }

  it('with a baseline: interest from the Aave index delta on the balance held then, NIM stake change', () => {
    const base = snap(T0 - 24 * H)
    // index grew 0.01% since: 100 USDT scaled earned 0.0101 USDT
    const indexNow = ((RAY + RAY / 100n) * 10_001n) / 10_000n
    const v = sinceView({
      base,
      now: T0,
      dollars: { USDT0: { scaled: 100_000_000n, index: indexNow } },
      nimStakedLuna: 100_150_000n,
      day,
    })
    expect(v.mode).toBe('visit')
    if (v.mode !== 'visit') return
    expect(v.since).toBe(T0 - 24 * H)
    expect(v.dollarsUsd).toBeCloseTo(0.0101, 6)
    expect(v.nimLuna).toBe(150_000n)
  })

  it('a deposit since the last visit is not counted as interest', () => {
    const base = snap(T0 - 24 * H)
    const indexNow = ((RAY + RAY / 100n) * 10_001n) / 10_000n
    const v = sinceView({ base, now: T0, dollars: { USDT0: { scaled: 900_000_000n, index: indexNow } }, nimStakedLuna: null, day })
    expect(v.mode === 'visit' && v.dollarsUsd).toBeCloseTo(0.0101, 6)
  })

  it('a withdrawal only counts interest on what stayed', () => {
    const base = snap(T0 - 24 * H)
    const indexNow = ((RAY + RAY / 100n) * 10_001n) / 10_000n
    const v = sinceView({ base, now: T0, dollars: { USDT0: { scaled: 50_000_000n, index: indexNow } }, nimStakedLuna: null, day })
    expect(v.mode === 'visit' && v.dollarsUsd).toBeCloseTo(0.00505, 6)
  })

  it('a side that was unknown then or now shows no number rather than a guess', () => {
    const base = snap(T0 - 24 * H, { dollars: null, nimStakedLuna: null })
    const v = sinceView({ base, now: T0, dollars: { USDT0: { scaled: 1n, index: RAY } }, nimStakedLuna: 5n, day })
    expect(v).toEqual({ mode: 'visit', since: T0 - 24 * H, dollarsUsd: null, nimLuna: null })
  })

  it('no baseline: the last 24 h from chain data, labelled as such', () => {
    expect(sinceView({ base: null, now: T0, dollars: null, nimStakedLuna: null, day })).toEqual({ mode: 'day', dollarsUsd: 0.01, nimLuna: 150_000n })
  })
})
