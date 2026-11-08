import { afterEach, describe, expect, it, vi } from 'vitest'
import { health } from '../src/api/health'

const RELAYER = '0x1111111111111111111111111111111111111111'
const NOW = 1_800_000_000_000

function db(rows: { key: string; value: string; updated_at: number }[] | Error) {
  return {
    prepare: () => ({
      all: async () => {
        if (rows instanceof Error) throw rows
        return { results: rows }
      },
    }),
  } as never
}

/** Answers eth_getBalance with `wei` (or fails), echoing each JSON-RPC id. */
function polygon(wei: bigint | 'down') {
  return vi.fn(async (_url: string, init: { body: string }) => {
    if (wei === 'down') throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-path')
    const req = JSON.parse(init.body) as { id: number; method: string }
    expect(req.method).toBe('eth_getBalance')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: `0x${wei.toString(16)}` }))
  })
}

const env = (over: object) =>
  ({ POLYGON_RPCS: 'https://rpc.test', RELAYER_ADDRESS: RELAYER, DB: db([]), ...over }) as never

const fresh = [{ key: 'indexer_last_ok', value: '', updated_at: NOW - 5 * 60_000 }]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('health', () => {
  it('reports the relayer balance read from Polygon', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(2n * 10n ** 18n))
    const h = await health(env({ DB: db(fresh) }))
    expect(h.ok).toBe(true)
    expect(h.relayer).toEqual({ address: RELAYER, polBalance: '2000000000000000000', low: false })
    expect(h.indexer.lagMinutes).toBe(5)
  })

  it('warns under 1 POL but stays ok above the 0.2 POL floor', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(5n * 10n ** 17n))
    const h = await health(env({ DB: db(fresh) }))
    expect(h.relayer?.low).toBe(true)
    expect(h.ok).toBe(true)
  })

  it('is not ok below the relayer gas floor', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(2n * 10n ** 17n - 1n))
    expect((await health(env({ DB: db(fresh) }))).ok).toBe(false)
  })

  it('returns a short code, not the raw message, when Polygon is down', async () => {
    vi.stubGlobal('fetch', polygon('down'))
    const h = await health(env({}))
    expect(h.ok).toBe(false)
    expect(h.relayer).toMatchObject({ polBalance: null, error: 'rpc_unavailable' })
    expect(JSON.stringify(h)).not.toContain('ECONNREFUSED')
  })

  it('returns db_error when D1 fails', async () => {
    vi.stubGlobal('fetch', polygon(10n ** 18n))
    const h = await health(env({ DB: db(new Error('D1_ERROR: no such table: meta at offset 14')) }))
    expect(h.ok).toBe(false)
    expect(h.indexer.lastError).toBe('db_error')
    expect(JSON.stringify(h)).not.toContain('no such table')
  })

  it('is not ok when the indexer lags more than 30 min', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(10n ** 18n))
    const h = await health(env({ DB: db([{ key: 'indexer_last_ok', value: '', updated_at: NOW - 31 * 60_000 }]) }))
    expect(h.indexer.lagMinutes).toBe(31)
    expect(h.ok).toBe(false)
  })

  it('passes stored indexer error codes through but hides free-text messages', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(10n ** 18n))
    const coded = await health(
      env({ DB: db([...fresh, { key: 'indexer_last_error', value: 'rpc_unavailable', updated_at: NOW }]) }),
    )
    expect(coded.indexer.lastError).toBe('rpc_unavailable')
    expect(coded.ok).toBe(false)
    const raw = await health(
      env({
        DB: db([...fresh, { key: 'indexer_last_error', value: 'TypeError: x is undefined at y.ts:3', updated_at: NOW }]),
      }),
    )
    expect(raw.indexer.lastError).toBe('indexer_error')
  })

  it('ignores an indexer error older than the last successful run', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', polygon(10n ** 18n))
    const h = await health(
      env({ DB: db([...fresh, { key: 'indexer_last_error', value: 'rpc_unavailable', updated_at: NOW - 60 * 60_000 }]) }),
    )
    expect(h.indexer.lastError).toBeNull()
    expect(h.ok).toBe(true)
  })

  it('skips the relayer block when no address is configured', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const h = await health(env({ RELAYER_ADDRESS: '', DB: db(fresh) }))
    expect(h.relayer).toBeNull()
    expect(h.ok).toBe(true)
    expect(f).not.toHaveBeenCalled()
  })
})
