// @vitest-environment jsdom
import { nimToLuna, type Staker } from '@accrue/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCheck,
  fetchPools,
  parseCheck,
  parsePolicy,
  parsePools,
  poolApr,
  TESTNET_VALIDATORS_URL,
  waitForNimTx,
} from '../src/features/nim/api'
import { NIM_ERROR_CODES, NimPlanError, NimTxFailedError, toNimUiError } from '../src/features/nim/errors'
import { restakeSuggestion } from '../src/features/nim/restake'
import { guardRemove, stakeFundsOf, stakePlan } from '../src/features/nim/staking'
import { STEP_KEYS } from '../src/features/nim/unstake'
import { useNim, type NimApi } from '../src/features/nim/useNim'
import { dicts } from '../src/i18n'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { createNimiq, type NimAccounts, type NimBalances, type Nimiq } from '../src/providers/nimiq'

const nim = (s: string) => nimToLuna(s)
const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
const GARUDA = 'NQ62 GARU DA00 0000 0000 0000 0000 0000 0000'

const staker = (over: Partial<Staker> = {}): Staker => ({
  address: 'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90',
  delegation: 'NQ35 YFBF ES7X R9PS 36R4 11FG 3HQF YL9Q NL2S',
  activeLuna: 0n,
  inactiveLuna: 0n,
  inactiveFrom: null,
  retiredLuna: 0n,
  ...over,
})

const WALLET = 'NQ68 L6GS 38D1 L6GS 38D1 L6GS 38D1 L6GS 38D1'
const HTLC = 'NQ03 NARB 5CMJ NARB 5CMJ NARB 5CMJ NARB 5CMJ'
const bal = (wallet: string, htlc: string) => ({ wallet: nim(wallet), htlc: nim(htlc), total: nim(wallet) + nim(htlc) })

describe('stake funding', () => {
  it('stakes from the HTLC when the wallet address holds nothing', () => {
    const spendable = stakeFundsOf({ wallet: WALLET, htlc: HTLC }, bal('0', '500'))
    expect(spendable).toBe(nim('500'))
    expect(stakePlan({ staker: null, spendable, total: nim('500'), amount: nim('200') })).toEqual({ kind: 'new', delegationRequired: true })
  })

  it('one transaction is funded from one account: the HTLC when there is one, else the wallet', () => {
    expect(stakeFundsOf({ wallet: WALLET, htlc: HTLC }, bal('100', '150'))).toBe(nim('150'))
    expect(stakeFundsOf({ wallet: WALLET }, bal('300', '0'))).toBe(nim('300'))
  })

  it('an HTLC account holding nothing does not hide the wallet: the wallet funds the stake', () => {
    // a funded fresh wallet on a real device: the HTLC account appears, empty, while the wallet holds the NIM
    const b = bal('300', '0')
    const spendable = stakeFundsOf({ wallet: WALLET, htlc: HTLC }, b)
    expect(spendable).toBe(nim('300'))
    expect(stakePlan({ staker: null, spendable, total: b.total, amount: nim('200') })).toEqual({ kind: 'new', delegationRequired: true })
  })

  it('never says "Only 0 NIM can be staked": with nothing to draw on it is too little NIM', () => {
    expect(stakePlan({ staker: null, spendable: 0n, total: nim('300'), amount: nim('200') })).toEqual({ error: 'INSUFFICIENT_BALANCE' })
    expect(stakePlan({ staker: null, spendable: 0n, total: 0n, amount: nim('200') })).toEqual({ error: 'INSUFFICIENT_BALANCE' })
  })

  it('wallet 100 + HTLC 150 cannot fund a 200 NIM stake, and says how much can', () => {
    const b = bal('100', '150')
    const spendable = stakeFundsOf({ wallet: WALLET, htlc: HTLC }, b)
    expect(stakePlan({ staker: null, spendable, total: b.total, amount: nim('200') })).toEqual({ error: 'FUNDS_SPLIT', available: nim('150') })
    expect(stakePlan({ staker: null, spendable, total: b.total, amount: nim('300') })).toEqual({ error: 'INSUFFICIENT_BALANCE' })
  })
})

describe('stakePlan', () => {

  it('a new staker below 100 NIM is refused before anything is sent', () => {
    expect(stakePlan({ staker: null, spendable: nim('500'), amount: nim('50') })).toEqual({ error: 'BELOW_MINIMUM' })
  })

  it('exactly 100 NIM is enough for a new staker', () => {
    expect(stakePlan({ staker: null, spendable: nim('100'), amount: nim('100') })).toEqual({ kind: 'new', delegationRequired: true })
  })

  it('an existing staker adds to the pool it already has', () => {
    expect(stakePlan({ staker: staker({ activeLuna: nim('150') }), spendable: nim('500'), amount: nim('200') })).toEqual({
      kind: 'add',
      delegationRequired: false,
    })
  })

  it('adding less than 100 NIM to a staker that already has 100 is fine (testnet C8)', () => {
    expect(stakePlan({ staker: staker({ activeLuna: nim('100') }), spendable: nim('500'), amount: nim('10') })).toEqual({
      kind: 'add',
      delegationRequired: false,
    })
  })

  it('a staker holding only retired NIM still needs 100 NIM to stake again', () => {
    expect(stakePlan({ staker: staker({ retiredLuna: nim('500') }), spendable: nim('500'), amount: nim('50') })).toEqual({
      error: 'BELOW_MINIMUM',
    })
  })

  it('more than the spendable balance is INSUFFICIENT_BALANCE', () => {
    expect(stakePlan({ staker: null, spendable: nim('150'), amount: nim('200') })).toEqual({ error: 'INSUFFICIENT_BALANCE' })
  })

  it('zero or negative amounts are refused', () => {
    expect(stakePlan({ staker: null, spendable: nim('500'), amount: 0n })).toEqual({ error: 'BELOW_MINIMUM' })
    expect(stakePlan({ staker: null, spendable: nim('500'), amount: -1n })).toEqual({ error: 'BELOW_MINIMUM' })
  })
})

describe('guardRemove', () => {
  it('refuses to leave between 0 and 100 NIM staked', () => {
    expect(guardRemove({ activeAfter: nim('50'), removing: nim('150') })).toBe('LEAVES_DUST')
    expect(guardRemove({ activeAfter: nim('99.99999'), removing: nim('1') })).toBe('LEAVES_DUST')
  })

  it('allows taking everything out, or leaving at least 100 NIM', () => {
    expect(guardRemove({ activeAfter: 0n, removing: nim('200') })).toBe('ok')
    expect(guardRemove({ activeAfter: nim('100'), removing: nim('150') })).toBe('ok')
  })
})

describe('restakeSuggestion', () => {
  it('suggests nothing for pools that already restake', () => {
    expect(restakeSuggestion({ walletIdle: nim('500'), payoutType: 'restake', reserve: nim('10'), apr: 0.1 })).toBeNull()
  })

  it('suggests nothing for pools that pay nothing', () => {
    expect(restakeSuggestion({ walletIdle: nim('500'), payoutType: 'none', reserve: nim('10'), apr: 0.1 })).toBeNull()
  })

  it('direct payouts: restake what sits idle above the reserve', () => {
    expect(restakeSuggestion({ walletIdle: nim('120'), payoutType: 'direct', reserve: nim('20'), apr: 0.1 })).toEqual({
      amount: nim('100'),
      extraPerYearLuna: nim('10'),
    })
  })

  it('nothing to suggest when the idle balance is within the reserve', () => {
    expect(restakeSuggestion({ walletIdle: nim('20'), payoutType: 'direct', reserve: nim('20'), apr: 0.1 })).toBeNull()
  })

  it('no suggestion without a usable APR, since the extra would have no source', () => {
    expect(restakeSuggestion({ walletIdle: nim('500'), payoutType: 'direct', reserve: 0n, apr: Number.NaN })).toBeNull()
    expect(restakeSuggestion({ walletIdle: nim('500'), payoutType: 'direct', reserve: 0n, apr: 0 })).toBeNull()
  })
})

const poolRow = (over: Record<string, unknown> = {}) => ({
  address: SIAM,
  name: 'Siam Pool',
  fee: 0.03,
  payoutType: 'restake',
  schedule: 'Every 3 hours',
  balanceLuna: '1838608583104',
  stakers: 30,
  accent: '#1f3047',
  logo: null,
  verdict: 'PAID_AS_PROMISED',
  ratio: 0.9725,
  expectedRatio: 0.97,
  lastPayoutTs: 1_794_088_873_586,
  reasons: [],
  ...over,
})

describe('/api/pools and /api/check', () => {
  it('parses pool rows, luna as bigint', () => {
    const r = parsePools({ asOf: 1, windowDays: 7, pools: [poolRow()] })
    expect(r.windowDays).toBe(7)
    expect(r.pools[0]).toMatchObject({ address: SIAM, payoutType: 'restake', balanceLuna: 1_838_608_583_104n, verdict: 'PAID_AS_PROMISED' })
  })

  it('drops malformed rows and never invents a verdict', () => {
    const r = parsePools({
      asOf: 1,
      windowDays: 7,
      pools: [poolRow({ address: 42 }), poolRow({ payoutType: 'sometimes' }), poolRow({ verdict: 'GREAT' })],
    })
    expect(r.pools).toHaveLength(1)
    expect(r.pools[0]!.verdict).toBeNull()
  })

  it('a pool that lists no fee is kept, with no fee and no promised share made up', () => {
    // Private Whalidator on mainnet: fee null, no payouts, no expected ratio
    const whale = poolRow({ address: GARUDA, name: 'Private Whalidator', fee: null, payoutType: 'none', schedule: '', verdict: 'NO_PAYOUTS_BY_DESIGN', ratio: null, expectedRatio: null })
    const r = parsePools({ asOf: 1, windowDays: 7, pools: [poolRow(), whale] })
    expect(r.pools.map(p => p.name)).toEqual(['Siam Pool', 'Private Whalidator'])
    expect(r.pools[1]).toMatchObject({ fee: null, expectedRatio: null, verdict: 'NO_PAYOUTS_BY_DESIGN' })
    // a fee that is there but not a number is still a broken row
    expect(parsePools({ asOf: 1, windowDays: 7, pools: [poolRow({ fee: '5%' }), poolRow({ fee: undefined })] }).pools).toEqual([])
  })

  it("a staker of a pool without a listed fee gets that pool back, not 'unlisted'", () => {
    const whale = poolRow({ address: GARUDA, name: 'Private Whalidator', fee: null, payoutType: 'none', verdict: 'NO_PAYOUTS_BY_DESIGN', expectedRatio: null })
    const r = parseCheck(
      { staker: { activeLuna: '20000000', inactiveLuna: 0, inactiveFrom: null, retiredLuna: '0', delegation: GARUDA }, pool: whale, verdict: 'NO_PAYOUTS_BY_DESIGN', pct: null, windowDays: 7 },
      'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90',
    )
    expect(r.pool).toMatchObject({ name: 'Private Whalidator', fee: null })
  })

  it('a check keeps the window length the API measured, fractional or not', () => {
    const body = {
      staker: { activeLuna: '20000000', inactiveLuna: 0, inactiveFrom: null, retiredLuna: '0', delegation: SIAM },
      pool: poolRow(),
      expectedLuna: '38356',
      receivedLuna: '38000',
      verdict: 'PAID_AS_PROMISED',
      pct: 0.99,
      windowDays: 5.8,
      fromTs: 1_794_009_600_000,
      toTs: 1_794_510_720_000,
    }
    expect(parseCheck(body, 'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90').windowDays).toBe(5.8)
  })

  it('a row without a verdict keeps it empty instead of filling one in', () => {
    const { verdict: _, ...noVerdict } = poolRow()
    const r = parsePools({ asOf: 1, windowDays: 7, pools: [noVerdict, poolRow({ payoutType: 'none', verdict: undefined })] })
    expect(r.pools.map(p => p.verdict)).toEqual([null, null])
  })

  it('rejects a body that is not the pools contract', () => {
    expect(() => parsePools({ pools: 'x' })).toThrow()
  })

  it('parses a check with a staker, string or number luna', () => {
    const r = parseCheck(
      {
        staker: { activeLuna: '20000000', inactiveLuna: 0, inactiveFrom: null, retiredLuna: '0', delegation: SIAM },
        pool: poolRow(),
        expectedLuna: '38356',
        receivedLuna: '38000',
        verdict: 'PAID_AS_PROMISED',
        pct: 0.99,
        windowDays: 7,
      },
      'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90',
    )
    expect(r.staker).toEqual(staker({ activeLuna: 20_000_000n, delegation: SIAM }))
    expect(r.expectedLuna).toBe(38_356n)
    expect(r.pool?.name).toBe('Siam Pool')
  })

  it('a non-staker check has no numbers', () => {
    const r = parseCheck({ staker: null, windowDays: 7 }, 'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90')
    expect(r).toEqual({ staker: null, pool: null, expectedLuna: null, receivedLuna: null, verdict: null, pct: null, windowDays: 7 })
  })

  it('pool APR comes from the check: expected over the window, per active NIM, per year', () => {
    const r = parseCheck(
      { staker: { activeLuna: '100000000', inactiveLuna: 0, inactiveFrom: null, retiredLuna: 0, delegation: SIAM }, expectedLuna: '153425', windowDays: 7 },
      'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90',
    )
    expect(poolApr(r)).toBeCloseTo(0.08, 3)
    expect(poolApr({ ...r, expectedLuna: null })).toBeNull()
    expect(poolApr({ ...r, staker: staker() })).toBeNull()
  })

  it('pool APR divides by the window the amounts cover: 6 days of expected earnings is not a week', () => {
    // 8 % a year on 1,000 NIM over 6 days: 131,507 luna
    const six = parseCheck(
      { staker: { activeLuna: '100000000', inactiveLuna: 0, inactiveFrom: null, retiredLuna: 0, delegation: SIAM }, expectedLuna: '131507', windowDays: 6, fromTs: 0, toTs: 6 * 86_400_000 },
      'NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90',
    )
    expect(poolApr(six)).toBeCloseTo(0.08, 3)
    // 5.8 days: 127,123 luna
    expect(poolApr({ ...six, expectedLuna: 127_123n, windowDays: 5.8 })).toBeCloseTo(0.08, 3)
  })

  it('mainnet pools come from /api/pools; testnet pools from the testnet validators API', async () => {
    const f = vi.fn(async (url: string) => {
      if (url === '/api/pools') return Response.json({ asOf: 5, windowDays: 7, pools: [poolRow()] })
      if (url === TESTNET_VALIDATORS_URL)
        return Response.json([
          { name: 'Puddle', address: 'NQ82 BHPS UR9K 07X1 X6QH 3DY3 J325 UCSP UHV3', fee: 0.095, payoutType: 'direct', payoutSchedule: '', accentColor: '#3aa6a6', logo: 'data:x', balance: 15_664_461_627_656, stakers: 12 },
          { name: 'Unknown validator', address: 'NQ30 59XY X0DY SVHB 9L27 XQTN M68R HR26 RTSL', fee: null, payoutType: 'none', payoutSchedule: '', balance: 1, stakers: 0 },
          { name: 'Mint Pool', address: 'NQ57 M1NT JRQA FGD2 HX1P FN2G 611P JNAE K7HN', fee: 0.1, payoutType: 'none', payoutSchedule: '', isListed: true, balance: 5, stakers: 1 },
          { name: 'Hidden', address: 'NQ42 FN9R 22NA GDDJ 1B2H DJ8X QR7L L6U0 VGKV', fee: 0.1, payoutType: 'restake', isListed: false, balance: 5, stakers: 1 },
        ])
      return new Response('nope', { status: 404 })
    })
    const main = await fetchPools('mainnet', f as unknown as typeof fetch)
    expect(main.pools[0]!.name).toBe('Siam Pool')
    const test = await fetchPools('testnet', f as unknown as typeof fetch)
    // only isListed false hides a validator; one that lists no fee stays, as on mainnet
    expect(test.pools.map(p => p.name)).toEqual(['Puddle', 'Unknown validator', 'Mint Pool'])
    // testnet has no Payout Check behind it: no verdicts at all, a pool without payouts included
    expect(test.pools[0]).toMatchObject({ payoutType: 'direct', fee: 0.095, schedule: null, balanceLuna: 15_664_461_627_656n, verdict: null, ratio: null })
    expect(test.pools[1]).toMatchObject({ fee: null, expectedRatio: null, payoutType: 'none', verdict: null })
    expect(test.pools[2]).toMatchObject({ payoutType: 'none', verdict: null })
  })

  it('a failing API is an HttpError the UI can map', async () => {
    const f = vi.fn(async () => Response.json({ error: 'RPC_UNAVAILABLE' }, { status: 503 }))
    await expect(fetchCheck('NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90', f as unknown as typeof fetch)).rejects.toMatchObject({ status: 503 })
    expect(toNimUiError(await fetchPools('mainnet', f as unknown as typeof fetch).catch(e => e))).toMatchObject({ code: 'RPC_UNAVAILABLE', retry: 'same' })
  })

  it('check URLs carry the address without spaces', async () => {
    const f = vi.fn(async (_url: string) => Response.json({ staker: null, windowDays: 7 }))
    await fetchCheck('NQ09 NMEX 1FAS 6BKD JDG1 GC0F XGM3 Q49B VL90', f as unknown as typeof fetch)
    expect(f.mock.calls[0]![0]).toBe('/api/check/NQ09NMEX1FAS6BKDJDG1GC0FXGM3Q49BVL90')
  })
})

describe('parsePolicy', () => {
  it('reads getPolicyConstants, including the genesis block', () => {
    expect(
      parsePolicy({ blocksPerEpoch: 43_200, blocksPerBatch: 60, blockSeparationTime: 1000, minimumStake: 10_000_000, jailEpochs: 8, genesisBlockNumber: 3_032_010 }),
    ).toEqual({ blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000, genesisBlockNumber: 3_032_010, jailEpochs: 8 })
  })

  it('falls back to the documented constants for fields a host leaves out', () => {
    expect(parsePolicy({ blocksPerEpoch: 43_200 })).toEqual({ blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000, genesisBlockNumber: 0, jailEpochs: 8 })
    expect(() => parsePolicy({ blocksPerEpoch: 0 })).toThrow()
  })
})

describe('waitForNimTx', () => {
  const sleep = async () => {}

  it('a failed staking transaction is included with executionResult false (testnet A2)', async () => {
    const rpc = vi.fn(async () => ({ hash: 'h', blockNumber: 16_172_345, executionResult: false }))
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('failed')
  })

  it('keeps polling while the node has not seen it, then confirms', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('Transaction not found: h'))
      .mockResolvedValueOnce({ hash: 'h', blockNumber: 16_172_341, executionResult: true })
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('confirmed')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('a transaction the network drops never shows up: pending, not success (testnet C0, C5)', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('Transaction not found: h')
    })
    await expect(waitForNimTx(rpc, 'h', { sleep, timeoutMs: 10_000, intervalMs: 2_000 })).resolves.toBe('pending')
    expect(rpc.mock.calls.length).toBeGreaterThan(1)
  })

  it('a host that cannot look transactions up gives pending right away', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('Method not found: getTransactionByHash')
    })
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('pending')
    expect(rpc).toHaveBeenCalledTimes(1)
    const byCode = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: -32601 })
    })
    await expect(waitForNimTx(byCode, 'h', { sleep })).resolves.toBe('pending')
    expect(byCode).toHaveBeenCalledTimes(1)
  })

  // The shape testnet returned for C0 and C5: the hint is in `data`, not in `message`.
  const notMinedYet = () => Object.assign(new Error('Internal error'), { code: -32603, data: 'Transaction not found: h' })

  it('the real "not mined yet" error keeps polling, and a failure is still caught', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(notMinedYet())
      .mockRejectedValueOnce(notMinedYet())
      .mockResolvedValueOnce({ hash: 'h', blockNumber: 16_172_345, executionResult: false })
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('failed')
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('a plain JSON-RPC error object with data works too', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce({ code: -32603, message: 'Internal error', data: 'Transaction not found: h' })
      .mockResolvedValueOnce({ hash: 'h', blockNumber: 1, executionResult: true })
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('confirmed')
  })

  it('a transient RPC error does not end the wait', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { code: 503 }))
      .mockResolvedValueOnce({ hash: 'h', blockNumber: 1, executionResult: true })
    await expect(waitForNimTx(rpc, 'h', { sleep })).resolves.toBe('confirmed')
  })

  it('fail-closed: without an explicit executionResult it is not confirmed', async () => {
    const rpc = vi.fn(async () => ({ hash: 'h', blockNumber: 1 }))
    await expect(waitForNimTx(rpc, 'h', { sleep, timeoutMs: 6_000, intervalMs: 2_000 })).resolves.toBe('pending')
    expect(rpc.mock.calls.length).toBeGreaterThan(1)
    const odd = vi.fn(async () => ({ hash: 'h', blockNumber: 1, executionResult: 'yes' }))
    await expect(waitForNimTx(odd, 'h', { sleep, timeoutMs: 2_000, intervalMs: 2_000 })).resolves.toBe('pending')
  })
})

describe('NIM error messages', () => {
  it('every NIM error code and step has an English string', () => {
    for (const code of NIM_ERROR_CODES) expect(dicts.en[`nim.error.${code}`], code).toBeTypeOf('string')
    for (const key of Object.values(STEP_KEYS)) expect(dicts.en[key], key).toBeTypeOf('string')
    for (const key of ['nim.switch.deactivateFirst', 'nim.switch.direct', 'nim.wait.resetsTimer', 'nim.wait.noRewards', 'nim.restake.suggestion', 'nim.tx.pending', 'nim.tx.confirming'])
      expect(dicts.en[key], key).toBeTypeOf('string')
    expect(dicts.en['nim.error.FUNDS_SPLIT']).toContain('{amount}')
  })

  it('plan errors and failed transactions map to their own messages; others go through toUiError', () => {
    expect(toNimUiError(new NimPlanError('LEAVES_DUST'))).toEqual({ code: 'LEAVES_DUST', retry: 'none', messageKey: 'nim.error.LEAVES_DUST' })
    expect(toNimUiError(new NimPlanError('FUNDS_SPLIT', { amount: '150' }))).toEqual({
      code: 'FUNDS_SPLIT',
      retry: 'none',
      messageKey: 'nim.error.FUNDS_SPLIT',
      detail: { amount: '150' },
    })
    expect(toNimUiError(new NimTxFailedError('abc'))).toEqual({ code: 'TX_FAILED', retry: 'none', messageKey: 'nim.error.TX_FAILED', detail: { hash: 'abc' } })
    expect(toNimUiError({ type: 'PERMISSION_DENIED', code: 4001 })).toMatchObject({ code: 'USER_REJECTED' })
  })
})

// The hook against the dev mock (and a scripted client where the mock has no knob): reads only
// after a tap, guards before any wallet dialog, one dialog at a time.
describe('useNim', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
    uninstallMock(window)
    // the mock keeps chain state for a reload; every test starts from its scenario
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  function stubApi(pools = [poolRow(), poolRow({ address: GARUDA, name: 'Garuda', payoutType: 'direct' })]) {
    const base = window.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/pools')) return Response.json({ asOf: 1, windowDays: 7, pools })
      if (url.includes('/api/check/')) return Response.json({ staker: null, windowDays: 7 })
      return base(input, init)
    })
  }

  async function mount(client: Nimiq) {
    const ref: { current: NimApi | null } = { current: null }
    function Probe() {
      ref.current = useNim({ client })
      return null
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const root = createRoot(document.createElement('div'))
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)))
    cleanup = () => root.unmount()
    await vi.waitFor(() => expect(ref.current).not.toBeNull())
    return () => ref.current!
  }

  async function render(scenario: string) {
    const m = installMock(`?mock=${scenario}&delay=0`, window)
    // after the mock, so these pools answer instead of the mock's own
    stubApi()
    const api = await mount(createNimiq())
    return { m, api }
  }

  // A connected client with fixed state; records what it would have sent.
  function scripted(o: { accounts: NimAccounts; balances: NimBalances; staker: Staker | null; lookup?: () => Promise<unknown> }) {
    stubApi()
    const sent: Array<[string, unknown]> = []
    const tx = (name: string) => async (arg: unknown) => {
      sent.push([name, arg])
      return `hash-${sent.length}`
    }
    const client = {
      connect: async () => o.accounts,
      accounts: () => o.accounts,
      balances: async () => o.balances,
      staker: async () => o.staker,
      rpc: async (method: string) => {
        if (method === 'getBlockNumber') return 16_172_400
        if (method === 'getPolicyConstants') return { blocksPerEpoch: 43_200, blockSeparationTime: 1_000, genesisBlockNumber: 3_032_010, jailEpochs: 8 }
        if (method === 'getValidatorByAddress') return { jailedFrom: null }
        if (method === 'getTransactionByHash') return o.lookup ? o.lookup() : { blockNumber: 16_172_401, executionResult: true }
        throw new Error(`unexpected ${method}`)
      },
      newStaker: (delegation: string, luna: bigint) => tx('newStaker')({ delegation, luna }),
      addStake: tx('addStake'),
      setActive: tx('setActive'),
      updateDelegation: tx('updateDelegation'),
      retire: tx('retire'),
      remove: tx('remove'),
      onAccountsChanged: () => () => {},
    } as unknown as Nimiq
    return { client, sent }
  }

  const sends = (m: ReturnType<typeof installMock>) => m.calls.filter(c => c.method.startsWith('send')).map(c => c.method)
  const pooled = staker({ address: WALLET, delegation: SIAM, activeLuna: nim('200') })

  it('mounting asks the wallet nothing', async () => {
    const { m, api } = await render('htlc-only-balance')
    await vi.waitFor(() => expect(api().pools?.pools.length).toBe(2))
    expect(m.calls).toEqual([])
    expect(api().connected).toBe(false)
  })

  it('HTLC-only balance: 1250 NIM stakeable and 200 NIM is a new stake, not "insufficient"', async () => {
    const { m, api } = await render('htlc-only-balance')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    expect(api().balances).toEqual({ wallet: 0n, htlc: nim('1250'), total: nim('1250') })
    expect(api().stakeable).toBe(nim('1250'))
    // the mock answers a non-staker the way the RPC does ("Internal error", hint in data)
    expect(api().staker).toBeNull()
    expect(api().planStake(nim('200'))).toEqual({ kind: 'new', delegationRequired: true })
    const out = await api().stake(nim('200'), SIAM)
    expect(out).toMatchObject({ status: 'confirmed' })
    const sent = m.calls.find(c => c.method === 'sendNewStakerTransaction')
    expect(sent?.params[0]).toEqual({ delegation: SIAM, value: 20_000_000 })
  })

  it('wallet 100 + HTLC 150: a 200 NIM stake is refused with how much can be staked, before any dialog', async () => {
    const { client, sent } = scripted({ accounts: { wallet: WALLET, htlc: HTLC }, balances: bal('100', '150'), staker: null })
    const api = await mount(client)
    await vi.waitFor(() => expect(api().ready).toBe(true))
    expect(api().balances?.total).toBe(nim('250'))
    expect(api().stakeable).toBe(nim('150'))
    expect(api().planStake(nim('200'))).toEqual({ error: 'FUNDS_SPLIT', available: nim('150') })
    const e = await api().stake(nim('200'), SIAM).catch(err => err)
    expect(toNimUiError(e)).toEqual({ code: 'FUNDS_SPLIT', retry: 'none', messageKey: 'nim.error.FUNDS_SPLIT', detail: { amount: '150' } })
    expect(sent).toEqual([])
    await api().stake(nim('150'), SIAM)
    expect(sent).toEqual([['newStaker', { delegation: SIAM, luna: nim('150') }]])
  })

  it('a new stake without a chosen pool, or below 100 NIM, never opens a dialog', async () => {
    const { m, api } = await render('htlc-only-balance')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    await expect(api().stake(nim('200'))).rejects.toMatchObject({ code: 'NO_POOL' })
    await expect(api().stake(nim('50'), SIAM)).rejects.toMatchObject({ code: 'BELOW_MINIMUM' })
    expect(sends(m)).toEqual([])
  })

  it('a staker with active stake: unstaking plans 4 steps, a dusty amount is refused, the switch needs deactivation first', async () => {
    const { m, api } = await render('happy')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    expect(api().myPool?.name).toBe('Siam Pool')
    const plan = api().planUnstake(nim('1000'))
    expect(plan?.check).toBe('ok')
    expect(plan?.steps.map(s => s.step)).toEqual(['deactivate', 'wait', 'retire', 'remove'])
    expect(api().planUnstake(nim('950'))?.check).toBe('LEAVES_DUST')
    await expect(api().deactivate(nim('950'))).rejects.toMatchObject({ code: 'LEAVES_DUST' })
    expect(api().planSwitch()).toMatchObject({ kind: 'deactivate-first' })
    await expect(api().switchPool(GARUDA)).rejects.toMatchObject({ code: 'NOT_READY' })
    await expect(api().retire(nim('1000'))).rejects.toMatchObject({ code: 'NOT_READY' })
    expect(sends(m)).toEqual([])
    await api().deactivate(nim('1000'))
    expect(m.calls.filter(c => c.method === 'sendSetActiveStakeTransaction').map(c => c.params[0])).toEqual([{ newActiveBalance: 0 }])
  })

  it('a double tap sends one transaction', async () => {
    const { m, api } = await render('happy')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    await Promise.all([api().stake(nim('10')), api().stake(nim('10'))])
    expect(sends(m)).toEqual(['sendStakeTransaction'])
  })

  it('different requests never share a result: the second is BUSY, not silently joined', async () => {
    const { m, api } = await render('happy')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    const [a, b] = await Promise.allSettled([api().stake(nim('10')), api().stake(nim('20'))])
    expect(a.status).toBe('fulfilled')
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } })
    // the mock staker now holds the 1000 NIM it started with plus the 10 just added
    const [c, d] = await Promise.allSettled([api().deactivate(nim('1010')), api().deactivateAll()])
    expect(c.status).toBe('fulfilled')
    expect(d).toMatchObject({ status: 'rejected', reason: { code: 'BUSY' } })
    expect(m.calls.filter(x => x.method.startsWith('send')).map(x => [x.method, x.params[0]])).toEqual([
      ['sendStakeTransaction', { value: 1_000_000 }],
      ['sendSetActiveStakeTransaction', { newActiveBalance: 0 }],
    ])
  })

  it('the dialog lock ends when the wallet returns; confirming on chain does not block other taps', async () => {
    let finish: ((v: unknown) => void) | undefined
    const lookup = () => new Promise(r => (finish = r))
    const { client, sent } = scripted({ accounts: { wallet: WALLET, htlc: HTLC }, balances: bal('0', '500'), staker: pooled, lookup })
    const api = await mount(client)
    await vi.waitFor(() => expect(api().ready).toBe(true))
    const first = api().stake(nim('10'))
    await vi.waitFor(() => expect(finish).toBeDefined())
    await vi.waitFor(() => expect(api().confirming).toBe(true))
    expect(api().busy).toBe(false)
    // another action is judged on its own (nothing retired yet), not refused as BUSY
    await expect(api().remove()).rejects.toMatchObject({ code: 'NOT_READY' })
    // the same request while it confirms joins it instead of sending again
    const again = api().stake(nim('10'))
    finish!({ blockNumber: 16_172_401, executionResult: true })
    await expect(first).resolves.toMatchObject({ status: 'confirmed', hash: 'hash-1' })
    await expect(again).resolves.toMatchObject({ status: 'confirmed', hash: 'hash-1' })
    expect(sent).toHaveLength(1)
    await vi.waitFor(() => expect(api().confirming).toBe(false))
  })

  it('a transaction the network includes as failed surfaces as TX_FAILED', async () => {
    const lookup = async () => ({ blockNumber: 16_172_401, executionResult: false })
    const { client } = scripted({ accounts: { wallet: WALLET, htlc: HTLC }, balances: bal('0', '500'), staker: pooled, lookup })
    const api = await mount(client)
    await vi.waitFor(() => expect(api().ready).toBe(true))
    const e = await api().stake(nim('10')).catch(err => err)
    expect(e).toBeInstanceOf(NimTxFailedError)
    expect(toNimUiError(e)).toMatchObject({ code: 'TX_FAILED', detail: { hash: 'hash-1' } })
  })

  it('a staker without a pool plans an unstake with no wait', async () => {
    const noPool = staker({ address: WALLET, delegation: '', inactiveLuna: nim('250'), inactiveFrom: 16_208_010 })
    const { client } = scripted({ accounts: { wallet: WALLET, htlc: HTLC }, balances: bal('0', '500'), staker: noPool })
    const api = await mount(client)
    await vi.waitFor(() => expect(api().ready).toBe(true))
    expect(api().myPool).toBeUndefined()
    expect(api().planUnstake(nim('250'))?.steps[1]).toEqual({ step: 'wait', etaMs: 0, done: true })
    expect(api().planSwitch()).toEqual({ kind: 'direct' })
  })

  it('a rejected dialog maps to USER_REJECTED', async () => {
    const { api } = await render('reject-sign')
    await api().connect()
    await vi.waitFor(() => expect(api().ready).toBe(true))
    const e = await api().stake(nim('10')).catch(err => err)
    expect(toNimUiError(e)).toMatchObject({ code: 'USER_REJECTED', retry: 'none' })
  })
})
