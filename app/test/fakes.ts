import type { Address, Hex } from 'viem'
import { vi } from 'vitest'
import { evm } from '../src/providers/evm'

export const OWNER = '0x1111111111111111111111111111111111111111' as Address
export const ROUTER = '0x2222222222222222222222222222222222222222' as Address
export const TX = `0x${'ab'.repeat(32)}` as Hex

// r = n, s = 7, v = 27: well-formed and distinct per n
export const sig = (n: number) => `0x${n.toString(16).padStart(64, '0')}${'7'.padStart(64, '0')}1b` as Hex

export interface Call {
  method: string
  path: string
  body?: Record<string, unknown>
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const relayError = (status: number, error: string, detail?: Record<string, unknown>) =>
  json(status, detail ? { error, detail } : { error })

export function stubFetch(handler: (c: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, 'http://app.test')
      const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname }
      if (typeof init?.body === 'string') call.body = JSON.parse(init.body) as Record<string, unknown>
      calls.push(call)
      return handler(call)
    }),
  )
  return calls
}

export const posts = (calls: Call[]) => calls.filter(c => c.method === 'POST')

export interface EvmStubOpts {
  polWei?: bigint
  balance?: bigint
  aBalance?: bigint
  onPolygon?: boolean
  connected?: boolean
  sigs?: Hex[]
}

// Underlying balances are read by AssetKey, aToken balances by address.
export function stubEvm(o: EvmStubOpts = {}) {
  const sigs = [...(o.sigs ?? [sig(1), sig(2), sig(3)])]
  return {
    address: vi.spyOn(evm, 'address').mockReturnValue(o.connected === false ? null : OWNER),
    isPolygon: vi.spyOn(evm, 'isPolygon').mockResolvedValue(o.onPolygon ?? true),
    permitNonce: vi.spyOn(evm, 'permitNonce').mockResolvedValue(0n),
    tokenBalance: vi
      .spyOn(evm, 'tokenBalance')
      .mockImplementation(async asset => (asset.startsWith('0x') ? (o.aBalance ?? 100_000_000n) : (o.balance ?? 25_000_000n))),
    signPermit: vi.spyOn(evm, 'signPermit').mockImplementation(async () => sigs.shift() ?? sig(99)),
    polBalance: vi.spyOn(evm, 'polBalance').mockResolvedValue(o.polWei ?? 3n * 10n ** 17n),
    gasPrice: vi.spyOn(evm, 'gasPrice').mockResolvedValue(100n * 10n ** 9n),
    sendTx: vi.spyOn(evm, 'sendTx').mockResolvedValue(TX),
    txStatus: vi.spyOn(evm, 'txStatus').mockResolvedValue('success'),
  }
}
