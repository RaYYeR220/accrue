import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAave, parseAave } from '../src/features/dollars/useAave'
import { afterMove, fetchPosition, parsePosition, POSITION_FOLLOW_UP_MS, refreshPositions, type Position } from '../src/features/dollars/usePosition'
import { HttpError } from '../src/providers/errors'

const reserve = {
  supplyApy: 0.0366,
  liquidityRateRay: '36000000000000000000000000',
  liquidityIndexRay: '1123456789000000000000000000',
  lastUpdate: 1_762_500_000,
  availableLiquidity: '12345678901234',
  utilization: 0.87,
}
const aave = { asOf: 1_762_500_060_000, reserves: { USDT0: reserve, USDC: { ...reserve, supplyApy: 0.041 } } }

const pos = (o: Partial<Record<string, string | null>> = {}) => ({
  aTokenBalance: '100000123',
  scaledFromAccrue: '89000000',
  principal: '100000000',
  earned: '123',
  ...o,
})
const position = { assets: { USDT0: pos(), USDC: pos({ aTokenBalance: '0', scaledFromAccrue: '0', principal: '0', earned: '0' }) } }
const unknown = { scaledFromAccrue: null, principal: null, earned: null }
const partial = { partial: true, reason: 'router_logs', assets: { USDT0: pos(unknown), USDC: pos({ aTokenBalance: '0', ...unknown }) } }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GET /api/aave', () => {
  it('parses ray and unit strings to bigints', () => {
    const r = parseAave(aave)
    expect(r.asOf).toBe(aave.asOf)
    expect(r.reserves.USDT0.liquidityIndexRay).toBe(1_123_456_789_000_000_000_000_000_000n)
    expect(r.reserves.USDT0.liquidityRateRay).toBe(36_000_000_000_000_000_000_000_000n)
    expect(r.reserves.USDT0.availableLiquidity).toBe(12_345_678_901_234n)
    expect(r.reserves.USDC.supplyApy).toBe(0.041)
    expect(r.reserves.USDT0.lastUpdate).toBe(1_762_500_000)
  })

  it('rejects a body that would put a wrong number on screen', () => {
    expect(() => parseAave({ ...aave, reserves: { USDT0: reserve } })).toThrow()
    expect(() => parseAave({ ...aave, reserves: { ...aave.reserves, USDT0: { ...reserve, liquidityIndexRay: '1e27' } } })).toThrow()
    expect(() => parseAave({ ...aave, reserves: { ...aave.reserves, USDT0: { ...reserve, supplyApy: 'high' } } })).toThrow()
    expect(() => parseAave(null)).toThrow()
  })

  it('still works in a WebView without AbortSignal.timeout', async () => {
    const timeout = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true })
    try {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(aave), { status: 200 }))
      expect((await fetchAave()).asOf).toBe(aave.asOf)
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(position), { status: 200 }))
      expect((await fetchPosition('0x1111111111111111111111111111111111111111')).assets.USDT0.principal).toBe(100_000_000n)
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: timeout, configurable: true, writable: true })
    }
  })

  it('fetches /api/aave and turns an error answer into HttpError', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(aave), { status: 200 }))
    vi.stubGlobal('fetch', f)
    expect((await fetchAave()).reserves.USDT0.utilization).toBe(0.87)
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('/api/aave')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'RPC_UNAVAILABLE' }), { status: 503 }))
    await expect(fetchAave()).rejects.toBeInstanceOf(HttpError)
  })
})

describe('GET /api/position/:evm', () => {
  it('parses each asset to bigints', () => {
    const p = parsePosition(position)
    expect(p.assets.USDT0).toEqual({ aTokenBalance: 100_000_123n, scaledFromAccrue: 89_000_000n, principal: 100_000_000n, earned: 123n })
    expect(p.assets.USDC.aTokenBalance).toBe(0n)
  })

  it('keeps a slightly negative earned (rounding right after a deposit) instead of failing', () => {
    expect(parsePosition({ assets: { ...position.assets, USDT0: pos({ earned: '-1' }) } }).assets.USDT0.earned).toBe(-1n)
  })

  it('rejects malformed amounts', () => {
    expect(() => parsePosition({ assets: { ...position.assets, USDT0: pos({ principal: '1.5' }) } })).toThrow()
    expect(() => parsePosition({ assets: { USDT0: pos() } })).toThrow()
  })

  it('fetches the position for the owner', async () => {
    const owner = '0x1111111111111111111111111111111111111111'
    const f = vi.fn(async () => new Response(JSON.stringify(position), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await fetchPosition(owner)
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`/api/position/${owner}`)
  })

  it('a complete answer is not partial', () => {
    expect(parsePosition(position).partial).toBe(false)
  })

  it('a partial answer (router logs unreadable) keeps the live balance, what Accrue tracks is unknown', () => {
    const p = parsePosition(partial)
    expect(p.partial).toBe(true)
    expect(p.assets.USDT0).toEqual({ aTokenBalance: 100_000_123n, scaledFromAccrue: null, principal: null, earned: null })
    expect(p.assets.USDC.aTokenBalance).toBe(0n)
  })

  it('a missing figure is only accepted in an answer marked partial', () => {
    expect(() => parsePosition({ assets: { ...position.assets, USDT0: pos({ principal: null }) } })).toThrow()
    expect(() => parsePosition({ ...partial, assets: { ...partial.assets, USDT0: pos({ ...unknown, aTokenBalance: null }) } })).toThrow()
  })
})

describe('reading the position again right after a deposit or withdrawal lands', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const moved = { assets: { ...position.assets, USDT0: pos({ aTokenBalance: '200000123' }) } }
  const seeded = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // what the screen showed a moment ago, still fresh for the query's 30 s staleTime
    qc.setQueryData(['position', owner], parsePosition(position))
    return qc
  }

  it('skips the server copy (?fresh=1) and the query staleTime, and shows the new balance', async () => {
    const qc = seeded()
    const f = vi.fn(async () => new Response(JSON.stringify(moved), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await refreshPositions(qc)
    expect(f.mock.calls.map(c => String((c as unknown[])[0]))).toEqual([`/api/position/${owner}?fresh=1`])
    expect(qc.getQueryData<Position>(['position', owner])!.assets.USDT0.aTokenBalance).toBe(200_000_123n)
  })

  it('reads once more a few seconds later, in case the node that answered first had not seen the block yet', async () => {
    vi.useFakeTimers()
    const qc = seeded()
    const f = vi.fn(async () => new Response(JSON.stringify(moved), { status: 200 }))
    vi.stubGlobal('fetch', f)
    afterMove(qc)
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POSITION_FOLLOW_UP_MS)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls.every(c => String((c as unknown[])[0]).endsWith('?fresh=1'))).toBe(true)
  })

  it('a failed read leaves what was shown', async () => {
    const qc = seeded()
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
    await refreshPositions(qc)
    expect(qc.getQueryData<Position>(['position', owner])!.assets.USDT0.aTokenBalance).toBe(100_000_123n)
  })
})
