// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { RpcUnavailableError } from '../src/providers/errors'
import { createEvm } from '../src/providers/evm'

const HASH = `0x${'cd'.repeat(32)}` as const

afterEach(() => {
  uninstallMock(window)
  vi.unstubAllGlobals()
})

function rpcAnswering(result: (method: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: result(req.method) }), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

describe('evm reads for the self-gas path', () => {
  it('gasPrice comes from the public RPC, with no wallet call', async () => {
    const m = installMock('?mock=happy&delay=0', window)
    expect(await createEvm().gasPrice()).toBeGreaterThan(0n)
    expect(m.calls).toHaveLength(0)
  })

  it('txReceipt is null until mined, then success with its block for a tx the wallet sent', async () => {
    installMock('?mock=happy&delay=0&chain=0x89', window)
    const e = createEvm()
    const from = await e.connect()
    expect(await e.txReceipt(HASH)).toBeNull()
    const hash = await e.sendTx({ from, to: from, data: '0x' })
    expect(await e.txReceipt(hash)).toEqual({ status: 'success', blockNumber: 80_000_001n })
  })

  it('txReceipt reports a reverted receipt and the block it was mined in', async () => {
    rpcAnswering(m => (m === 'eth_getTransactionReceipt' ? { status: '0x0', transactionHash: HASH, blockNumber: '0x1f4' } : null))
    expect(await createEvm({ rpcs: ['https://rpc.test'] }).txReceipt(HASH)).toEqual({ status: 'reverted', blockNumber: 500n })
  })

  it('an unreachable RPC is RPC_UNAVAILABLE, not "not mined"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(createEvm({ rpcs: ['https://rpc.test'] }).txReceipt(HASH)).rejects.toBeInstanceOf(RpcUnavailableError)
  })

  it('permitNonce can be read at a given block, so a lagging node cannot answer with older state', async () => {
    const seen: unknown[][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
        seen.push(req.params)
        const result = `0x${(7).toString(16).padStart(64, '0')}`
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'content-type': 'application/json' } })
      }),
    )
    const e = createEvm({ rpcs: ['https://rpc.test'] })
    const owner = '0x1111111111111111111111111111111111111111'
    expect(await e.permitNonce('0x2222222222222222222222222222222222222222', owner, 500n)).toBe(7n)
    expect(seen.at(-1)?.[1]).toBe('0x1f4')
    await e.permitNonce('0x2222222222222222222222222222222222222222', owner)
    expect(seen.at(-1)?.[1]).toBe('latest')
  })
})
