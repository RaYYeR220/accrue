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

  it('txStatus is null until mined, then success for a tx the wallet sent', async () => {
    installMock('?mock=happy&delay=0&chain=0x89', window)
    const e = createEvm()
    const from = await e.connect()
    expect(await e.txStatus(HASH)).toBeNull()
    const hash = await e.sendTx({ from, to: from, data: '0x' })
    expect(await e.txStatus(hash)).toBe('success')
  })

  it('txStatus reports a reverted receipt', async () => {
    rpcAnswering(m => (m === 'eth_getTransactionReceipt' ? { status: '0x0', transactionHash: HASH } : null))
    expect(await createEvm({ rpcs: ['https://rpc.test'] }).txStatus(HASH)).toBe('reverted')
  })

  it('an unreachable RPC is RPC_UNAVAILABLE, not "not mined"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(createEvm({ rpcs: ['https://rpc.test'] }).txStatus(HASH)).rejects.toBeInstanceOf(RpcUnavailableError)
  })
})
