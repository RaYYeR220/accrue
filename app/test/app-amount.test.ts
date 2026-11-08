import { describe, expect, it } from 'vitest'
import { checkDeposit, checkWithdraw, maxDeposit, parseAmount, plainUnits } from '../src/model/amount'

const USD = 1_000_000n

describe('parseAmount: what a person may type', () => {
  it.each([
    ['1', 1_000_000n],
    ['1.5', 1_500_000n],
    ['0.000001', 1n],
    ['10000', 10_000n * USD],
    ['007.10', 7_100_000n],
    ['.5', 500_000n],
    ['5.', 5n * USD],
    ['  12.34  ', 12_340_000n],
  ])('%j → %s units', (raw, units) => {
    expect(parseAmount(raw, 6)).toEqual({ ok: true, units })
  })

  it('nothing typed is not an amount yet', () => {
    expect(parseAmount('', 6)).toEqual({ ok: false, error: 'EMPTY' })
    expect(parseAmount('   ', 6)).toEqual({ ok: false, error: 'EMPTY' })
  })

  it.each(['1e3', '1E3', '2e-1', '0x10', 'Infinity', 'NaN', '-1', '+1', '1-', 'abc', '.', ','])('rejects %j', raw => {
    expect(parseAmount(raw, 6)).toEqual({ ok: false, error: 'FORMAT' })
  })

  it.each(['1,000.50', '1.000,50', '1 000', "1'000", '1_000', '1.2.3', '1,2,3', '1..2', '١٢'])('rejects separators other than one decimal point: %j', raw => {
    expect(parseAmount(raw, 6, { comma: true })).toEqual({ ok: false, error: 'FORMAT' })
  })

  it('more than 6 fraction digits is refused, not rounded', () => {
    expect(parseAmount('1.0000001', 6)).toEqual({ ok: false, error: 'TOO_PRECISE' })
    expect(parseAmount('0.1234567', 6)).toEqual({ ok: false, error: 'TOO_PRECISE' })
    expect(parseAmount('1.000000', 6)).toEqual({ ok: true, units: USD })
  })

  it('each language has exactly one decimal mark, and the other one is refused', () => {
    // decimal-comma languages (de, es, fr, pt): "1.000" is a thousand there, so it is never read as 1
    expect(parseAmount('1,5', 6, { comma: true })).toEqual({ ok: true, units: 1_500_000n })
    expect(parseAmount('1.000', 6, { comma: true })).toEqual({ ok: false, error: 'FORMAT' })
    expect(parseAmount('1.5', 6, { comma: true })).toEqual({ ok: false, error: 'FORMAT' })
    // English: "1,500" is fifteen hundred, so it is refused rather than read as 1.5
    expect(parseAmount('1.5', 6)).toEqual({ ok: true, units: 1_500_000n })
    expect(parseAmount('1,5', 6)).toEqual({ ok: false, error: 'FORMAT' })
    expect(parseAmount('1,500', 6)).toEqual({ ok: false, error: 'FORMAT' })
  })

  it('what Max and All type in parses back to the same units, in both kinds of language', () => {
    for (const comma of [false, true]) {
      for (const units of [0n, 1n, 25_123_456n, 10_000_000_000n, 999_999n]) {
        expect(parseAmount(plainUnits(units, 6, comma), 6, { comma })).toEqual({ ok: true, units })
      }
      expect(parseAmount(plainUnits(123_456_789n, 5, comma), 5, { comma })).toEqual({ ok: true, units: 123_456_789n })
    }
    expect(plainUnits(25_120_000n, 6, true)).toBe('25,12')
    expect(plainUnits(25_000_000n, 6, false)).toBe('25')
  })

  it('NIM amounts have 5 decimals', () => {
    expect(parseAmount('200', 5)).toEqual({ ok: true, units: 20_000_000n })
    expect(parseAmount('0.00001', 5)).toEqual({ ok: true, units: 1n })
    expect(parseAmount('0.000001', 5)).toEqual({ ok: false, error: 'TOO_PRECISE' })
  })

  it('absurdly long input is refused instead of becoming a huge number', () => {
    expect(parseAmount('9'.repeat(40), 6)).toEqual({ ok: false, error: 'FORMAT' })
  })
})

describe('deposit limits: min $1, max $10,000, never more than the balance', () => {
  it('accepts the bounds', () => {
    expect(checkDeposit(USD, 50n * USD)).toEqual({ ok: true })
    expect(checkDeposit(10_000n * USD, 20_000n * USD)).toEqual({ ok: true })
  })

  it('names the limit that was hit', () => {
    expect(checkDeposit(999_999n, 50n * USD)).toEqual({ ok: false, reason: 'MIN', limit: USD })
    expect(checkDeposit(10_000n * USD + 1n, 20_000n * USD)).toEqual({ ok: false, reason: 'MAX', limit: 10_000n * USD })
    expect(checkDeposit(2n * USD, USD / 2n)).toEqual({ ok: false, reason: 'BALANCE', limit: USD / 2n })
  })

  it('an unknown balance only checks the fixed limits', () => {
    expect(checkDeposit(2n * USD, undefined)).toEqual({ ok: true })
  })

  it('max is the balance, capped at $10,000', () => {
    expect(maxDeposit(25n * USD)).toBe(25n * USD)
    expect(maxDeposit(25_000n * USD)).toBe(10_000n * USD)
    expect(maxDeposit(0n)).toBe(0n)
  })
})

describe('withdraw limits', () => {
  it('more than zero and at most the position; no cap, so leaving is never limited', () => {
    expect(checkWithdraw(1n, 100n * USD)).toEqual({ ok: true })
    expect(checkWithdraw(0n, 100n * USD)).toEqual({ ok: false, reason: 'ZERO', limit: 0n })
    expect(checkWithdraw(101n * USD, 100n * USD)).toEqual({ ok: false, reason: 'BALANCE', limit: 100n * USD })
    // a typed amount behaves like "All": the relay has no withdraw cap
    expect(checkWithdraw(15_000n * USD, 20_000n * USD)).toEqual({ ok: true })
  })
})
