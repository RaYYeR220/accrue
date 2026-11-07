import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAave, parseAave } from '../src/features/dollars/useAave'
import { fetchPosition, parsePosition } from '../src/features/dollars/usePosition'
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

const pos = (o: Partial<Record<string, string>> = {}) => ({
  aTokenBalance: '100000123',
  scaledFromAccrue: '89000000',
  principal: '100000000',
  earned: '123',
  ...o,
})
const position = { assets: { USDT0: pos(), USDC: pos({ aTokenBalance: '0', scaledFromAccrue: '0', principal: '0', earned: '0' }) } }

afterEach(() => vi.unstubAllGlobals())

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
})
