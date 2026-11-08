import { describe, expect, it } from 'vitest'
import { encodeErrorResult, encodeFunctionData, type Hex } from 'viem'
import { judgeState, routerAbi, routerCalldata, type OwnerState } from '../src/relayer/chain'
import { decodeRevert } from '../src/relayer/errors'
import type { ParsedRelay } from '../src/relayer/validate'

const ROUTER = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f'
const OWNER = '0xbc801B8b9EC304FcFCE1A4377CEC729C0BD1F02f'
const R = `0x${'11'.repeat(32)}` as Hex
const S = `0x${'22'.repeat(32)}` as Hex

const supply: ParsedRelay = {
  kind: 'supply',
  asset: 'USDT0',
  owner: OWNER,
  amount: 5_000_000n,
  permitValue: 5_000_000n,
  deadline: 1_800_000_600n,
  nonce: 0n,
  signature: '0x',
  v: 27,
  r: R,
  s: S,
}
const withdraw: ParsedRelay = { ...supply, kind: 'withdraw', amount: 2n ** 256n - 1n, permitValue: 5_100_000n }

const LANDED = `0x${'aa'.repeat(32)}` as Hex

/** Just the three calls findLanded makes. `logs` throwing for a span simulates a provider's range cap. */
function client(opts: { input?: Hex; logs?: (span: bigint) => { amount: bigint }[] } = {}) {
  const latest = 10_000n
  return {
    getBlockNumber: async () => latest,
    getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
      (opts.logs?.(latest - fromBlock) ?? []).map(a => ({ args: a, transactionHash: LANDED })),
    getTransaction: async () => ({ input: opts.input ?? routerCalldata(supply) }),
  } as never
}

const state = (s: Partial<OwnerState>): OwnerState => ({ nonce: 0n, balance: 10_000_000n, ...s })
const code = async (p: Promise<unknown>) => {
  const v = (await p) as { error?: { code: string; detail?: Record<string, unknown> }; landed?: Hex } | null
  return v === null ? 'ok' : v.landed ? `landed:${v.landed}` : `${v.error?.code}${v.error?.detail ? ` ${JSON.stringify(v.error.detail)}` : ''}`
}

describe('judgeState', () => {
  it('passes a healthy supply', async () => {
    expect(await code(judgeState(client(), ROUTER, supply, state({})))).toBe('ok')
  })

  it('refuses USDC from an owner with code (EIP-7702)', async () => {
    const usdc = { ...supply, asset: 'USDC' as const }
    expect(await code(judgeState(client(), ROUTER, usdc, state({ hasCode: true })))).toBe(
      'BAD_SIGNATURE {"reason":"owner_has_code"}',
    )
  })

  it('reports a used nonce as confirmed when this exact signature already landed', async () => {
    const c = client({ logs: () => [{ amount: 5_000_000n }] })
    expect(await code(judgeState(c, ROUTER, supply, state({ nonce: 1n })))).toBe(`landed:${LANDED}`)
  })

  it('calls a used nonce stale when the landed tx carried a different signature', async () => {
    const other = encodeFunctionData({
      abi: routerAbi,
      functionName: 'supplyWithPermit',
      args: [supply.owner, supply.owner, 5_000_000n, 1n, 27, R, `0x${'33'.repeat(32)}`],
    })
    const c = client({ logs: () => [{ amount: 5_000_000n }], input: other })
    expect(await code(judgeState(c, ROUTER, supply, state({ nonce: 1n })))).toBe('PERMIT_NONCE_STALE {"expected":"1"}')
  })

  it('ignores Supplied logs for other amounts', async () => {
    const c = client({ logs: () => [{ amount: 7_000_000n }] })
    expect(await code(judgeState(c, ROUTER, supply, state({ nonce: 1n })))).toBe('PERMIT_NONCE_STALE {"expected":"1"}')
  })

  it('falls back to the last 50 blocks when the RPC caps log ranges', async () => {
    const c = client({
      logs: span => {
        if (span > 50n) throw new Error('ranges over 10000 blocks are not supported on free plan')
        return [{ amount: 5_000_000n }]
      },
    })
    expect(await code(judgeState(c, ROUTER, supply, state({ nonce: 1n })))).toBe(`landed:${LANDED}`)
  })

  it('stays PERMIT_NONCE_STALE, not INTERNAL, when no RPC serves the log query', async () => {
    const c = client({
      logs: () => {
        throw new Error('eth_getLogs is limited to 0 - 50 blocks range')
      },
    })
    expect(await code(judgeState(c, ROUTER, supply, state({ nonce: 1n })))).toBe(
      'PERMIT_NONCE_STALE {"expected":"1","landedCheck":"unavailable"}',
    )
  })

  it('calls a future nonce stale', async () => {
    expect(await code(judgeState(client(), ROUTER, { ...supply, nonce: 3n }, state({ nonce: 1n })))).toBe(
      'PERMIT_NONCE_STALE {"expected":"1"}',
    )
  })

  it('reports the balance when it is short', async () => {
    expect(await code(judgeState(client(), ROUTER, supply, state({ balance: 4_999_999n })))).toBe(
      'INSUFFICIENT_BALANCE {"balance":"4999999"}',
    )
  })

  it('withdraw: nothing deposited -> INSUFFICIENT_BALANCE before any nonce question', async () => {
    expect(await code(judgeState(client(), ROUTER, withdraw, state({ balance: 0n, nonce: 9n })))).toBe(
      'INSUFFICIENT_BALANCE {"balance":"0"}',
    )
  })

  it('withdraw: reserve cannot pay the pull -> AAVE_LIQUIDITY with what is available', async () => {
    const s = state({ balance: 5_000_000n, available: 4_000_000n })
    expect(await code(judgeState(client(), ROUTER, withdraw, s))).toBe('AAVE_LIQUIDITY {"available":"4000000"}')
    expect(await code(judgeState(client(), ROUTER, withdraw, { ...s, available: 5_000_000n }))).toBe('ok')
  })
})

describe('decodeRevert', () => {
  it('names router errors and Error(string) reasons', () => {
    const data = encodeErrorResult({ abi: routerAbi, errorName: 'InsufficientAllowance' })
    expect(decodeRevert({ cause: { data } }, routerAbi)).toEqual({ reason: 'InsufficientAllowance', name: 'InsufficientAllowance' })
    const reason = `0x08c379a0${'0'.repeat(62)}20${'0'.repeat(62)}02${'3531'.padEnd(64, '0')}` as Hex
    expect(decodeRevert({ data: reason }, routerAbi)).toEqual({ reason: '51', name: 'Error' })
  })

  it('falls back to the selector for unknown errors', () => {
    expect(decodeRevert({ data: '0xdeadbeef' }, routerAbi)).toEqual({ reason: '0xdeadbeef' })
  })
})
