import {
  createPublicClient,
  encodeFunctionResult,
  fallback,
  http,
  multicall3Abi,
  recoverTypedDataAddress,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { buildPermit } from '@accrue/shared'
import { judgeState, readOwnerState, routerCalldata, simulate } from './chain'
import { validateStatic } from './validate'

// Runs at script startup, which has its own CPU allowance, so the first relay through a fresh Worker isolate or a
// freshly woken Durable Object does not pay for secp256k1's base-point table (~50 ms) or for V8 compiling the
// recovery, signing, ABI and RPC paths on first use (~10-20 ms). The client below has the production transport
// stack (fallback over http) but answers from memory, so nothing here does I/O; timeout 0 arms no timer.
// Fixed clock: Date.now() reads 0 during workerd startup.
const WARM_NOW = 1_800_000_000_000
const key = privateKeyToAccount(`0x${'0'.repeat(63)}1`)
const permit = buildPermit({
  token: 'asset',
  asset: 'USDT0',
  owner: key.address,
  spender: key.address,
  value: 5_000_000n,
  nonce: 0n,
  deadline: 1n,
})
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const owner = encodeFunctionResult({
  abi: multicall3Abi,
  functionName: 'aggregate3',
  result: [
    { success: true, returnData: word(0n) },
    { success: true, returnData: word(10_000_000n) },
  ],
})
const answer = (method: string) =>
  method === 'eth_call'
    ? owner
    : method === 'eth_estimateGas'
      ? '0x4c2c0'
      : method === 'eth_getTransactionCount' || method === 'eth_getBalance'
        ? '0x1'
        : null
// A plain object, not a Response: reading a Response body is I/O, which workerd forbids at startup.
const headers = new Headers({ 'content-type': 'application/json' })
const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
  const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string }
  const text = JSON.stringify({ jsonrpc: '2.0', id, result: answer(method) })
  return { ok: true, status: 200, headers, body: null, text: async () => text }
}
const offline = createPublicClient({
  chain: polygon,
  transport: fallback([http('https://warm.invalid', { fetchFn: fetchFn as unknown as typeof fetch, timeout: 0, retryCount: 0 })], {
    retryCount: 0,
  }),
})

export const warmed: Promise<unknown> = (async () => {
  const signature = await key.signTypedData(permit)
  const v = validateStatic(
    {
      kind: 'supply',
      asset: 'USDT0',
      owner: key.address,
      amount: '5000000',
      deadline: String(WARM_NOW / 1000 + 600),
      nonce: '0',
      signature,
    },
    WARM_NOW,
  )
  // A few rounds, so V8 has optimised the curve arithmetic before the first real recovery.
  for (let i = 0; i < 3; i++) await recoverTypedDataAddress({ ...permit, signature })
  if (!v.ok) return
  const data = routerCalldata(v.parsed)
  await judgeState(offline, key.address, v.parsed, await readOwnerState(offline, v.parsed))
  await simulate(offline, key.address, key.address, data)
  await offline.estimateGas({ account: key.address, to: key.address, data })
  await offline.getTransactionCount({ address: key.address, blockTag: 'pending' })
  await offline.getBalance({ address: key.address })
  await key.signTransaction({
    type: 'eip1559',
    chainId: polygon.id,
    to: key.address,
    data,
    gas: 400_000n,
    nonce: 0,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
})().catch(() => undefined)
