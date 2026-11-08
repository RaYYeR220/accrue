import { afterEach, describe, expect, it, vi } from 'vitest'
import { nimRpc, RpcUnavailable } from '../src/rpc/nimiq'
import { polygonUrls } from '../src/rpc/polygon'

const env = { NIM_RPCS: 'https://a.test, https://b.test' } as never

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => vi.unstubAllGlobals())

describe('nimRpc', () => {
  it('falls through a 503 to the next server and unwraps result.data', async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith('https://a.test') ? json({}, 503) : json({ result: { data: 42 } }),
    )
    vi.stubGlobal('fetch', f)
    expect(await nimRpc<number>(env, 'getBlockNumber', [])).toBe(42)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('rejects with RpcUnavailable when every server fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)))
    await expect(nimRpc(env, 'getBlockNumber', [])).rejects.toBeInstanceOf(RpcUnavailable)
  })

  it('treats a network error and an empty result as failures', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.startsWith('https://a.test')) throw new Error('boom')
      return json({ result: null })
    })
    vi.stubGlobal('fetch', f)
    await expect(nimRpc(env, 'getBlockNumber', [])).rejects.toBeInstanceOf(RpcUnavailable)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('surfaces a JSON-RPC error as failure and moves on', async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith('https://a.test') ? json({ error: { code: -1, message: 'x' } }) : json({ result: { data: 'ok' } }),
    )
    vi.stubGlobal('fetch', f)
    expect(await nimRpc<string>(env, 'getBlockNumber', [])).toBe('ok')
  })
})

describe('nimRpc error detail', () => {
  it('keeps error.data in the cause, so "No staker" can be told from a server fault', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: -32603, message: 'Internal error', data: 'No staker with address: NQ00' } })))
    const e = await nimRpc({ NIM_RPCS: 'https://a.test' } as never, 'getStakerByAddress', ['NQ00']).catch((x) => x)
    expect(e).toBeInstanceOf(RpcUnavailable)
    expect((e as RpcUnavailable).causes[0]).toBe('https://a.test Internal error: No staker with address: NQ00')
  })
})

describe('polygonUrls', () => {
  it('splits and trims the comma list', () => {
    expect(polygonUrls({ POLYGON_RPCS: ' https://x.test ,https://y.test,' } as never)).toEqual([
      'https://x.test',
      'https://y.test',
    ])
  })
})
