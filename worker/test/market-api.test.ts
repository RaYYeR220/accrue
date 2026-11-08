import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { ASSETS, POLYGON } from '@accrue/shared'
import { app } from '../src/app'
import { clearMemoryCache } from '../src/api/cache'
import { aavePoolAbi } from '../src/api/aave'
import { scanRouterLogs } from '../src/indexer/router'
import { routerAbi } from '../src/relayer/chain'
import { runScheduled } from '../src/scheduled'
import { FakeD1 } from './d1'
import { FakeChain, RpcError } from './helpers'

const RAY = 10n ** 27n
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,tether&vs_currencies=usd'
const ER_API = 'https://open.er-api.com/v6/latest/USD'

const env = (DB: unknown, over: Record<string, unknown> = {}) =>
  ({ DB, NIM_RPCS: 'https://nim.test', POLYGON_RPCS: 'https://polygon.test', RELAYER_ADDRESS: '', RELAYER: null, ...over }) as never

async function getJson(path: string, e: never) {
  const res = await app.request(path, {}, e)
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> }
}

beforeEach(() => clearMemoryCache())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GET /api/rates', () => {
  const T0 = Date.UTC(2026, 10, 8, 12)
  let coingecko: () => Response
  let erApi: () => Response
  const calls: string[] = []
  const edge = new Map<string, Response>()

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    calls.length = 0
    edge.clear()
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0.00027882 }, tether: { usd: 1.0002 } })
    erApi = () => Response.json({ result: 'success', time_last_update_unix: 1794096001, rates: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5, JPY: 150 } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push(url)
        // CoinGecko answers 403 to a request without a descriptive User-Agent (Workers send none)
        const ua = new Headers(init?.headers).get('user-agent') ?? ''
        if (url === COINGECKO && !/accrue/i.test(ua)) return Response.json({ status: { error_code: 403 } }, { status: 403 })
        if (url === COINGECKO) return coingecko()
        if (url === ER_API) return erApi()
        throw new Error(`unexpected ${url}`)
      }),
    )
    // the data center's Cache API, as workerd offers it
    vi.stubGlobal('caches', {
      default: {
        match: async (r: Request) => edge.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => void edge.set(r.url, res.clone()),
      },
    })
  })

  it('answers the NIM price and USD-based rates with their sources, then serves its copy for 5 minutes', async () => {
    const r = await getJson('/api/rates', env(null))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      asOf: T0, nimUsd: 0.00027882, usdtUsd: 1.0002, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: ['CoinGecko', 'open.er-api.com'],
    })
    vi.setSystemTime(T0 + 4 * 60_000)
    expect((await getJson('/api/rates', env(null))).body.asOf).toBe(T0)
    // a new isolate finds the data center's copy
    clearMemoryCache()
    expect((await getJson('/api/rates', env(null))).body.asOf).toBe(T0)
    expect(calls).toHaveLength(2)
  })

  it('falls back to the cached copy when CoinGecko answers 500, for up to an hour', async () => {
    await getJson('/api/rates', env(null))
    coingecko = () => new Response('oops', { status: 500 })
    vi.setSystemTime(T0 + 6 * 60_000)
    const stale = await getJson('/api/rates', env(null))
    expect(stale.status).toBe(200)
    expect(stale.body.nimUsd).toBe(0.00027882)
    expect(stale.body.asOf).toBe(T0)
    vi.setSystemTime(T0 + 61 * 60_000)
    const gone = await getJson('/api/rates', env(null))
    expect(gone.status).toBe(503)
    expect(gone.body).toMatchObject({ error: 'RPC_UNAVAILABLE' })
  })

  it('never invents a rate: a currency the FX source lacks is left out, a failed FX source leaves USD only', async () => {
    erApi = () => Response.json({ result: 'success', rates: { USD: 1, EUR: 0.86, CRC: 'n/a' } })
    expect((await getJson('/api/rates', env(null))).body.fx).toEqual({ USD: 1, EUR: 0.86 })
    clearMemoryCache()
    edge.clear()
    erApi = () => new Response('', { status: 502 })
    const r = await getJson('/api/rates', env(null))
    expect(r.body.fx).toEqual({ USD: 1 })
    expect(r.body.source).toEqual(['CoinGecko'])
    clearMemoryCache()
    edge.clear()
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0 } })
    expect((await getJson('/api/rates', env(null))).status).toBe(503)
  })
})

/** Polygon behind a stubbed fetch: Multicall3 sub-calls answered per target and function. */
function polygon(state: {
  reserves?: Partial<Record<'USDT0' | 'USDC', { index: bigint; rate: bigint; updated: number; supply: bigint; virtual?: bigint; cash: bigint }>>
  balances?: Partial<Record<'USDT0' | 'USDC', { balance: bigint; scaled: bigint; income: bigint }>>
  head?: number
  logs?: { block: number; index: number; event: 'Supplied' | 'Withdrawn'; owner: Address; asset: Address; amount: bigint; liquidityIndex: bigint }[]
  router?: Address
}) {
  const chain = new FakeChain()
  const tokenAbi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function scaledBalanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
  ])
  const key = (a: string) => (Object.keys(ASSETS) as ('USDT0' | 'USDC')[]).find((k) => ASSETS[k].address.toLowerCase() === a.toLowerCase() || ASSETS[k].aToken.toLowerCase() === a.toLowerCase())!
  const answer = (target: string, data: Hex): { success: boolean; returnData: Hex } => {
    if (target.toLowerCase() === POLYGON.pool.toLowerCase()) {
      const call = decodeFunctionData({ abi: aavePoolAbi, data })
      const k = key(call.args![0] as string)
      if (call.functionName === 'getReserveNormalizedIncome') {
        return { success: true, returnData: encodeFunctionResult({ abi: aavePoolAbi, functionName: 'getReserveNormalizedIncome', result: state.balances![k]!.income }) }
      }
      const r = state.reserves![k]!
      if (call.functionName === 'getVirtualUnderlyingBalance') {
        return r.virtual === undefined ? { success: false, returnData: '0x' } : { success: true, returnData: encodeFunctionResult({ abi: aavePoolAbi, functionName: 'getVirtualUnderlyingBalance', result: r.virtual }) }
      }
      const z = '0x0000000000000000000000000000000000000000' as const
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: aavePoolAbi,
          functionName: 'getReserveData',
          result: {
            configuration: { data: 1n }, liquidityIndex: r.index, currentLiquidityRate: r.rate, variableBorrowIndex: RAY, currentVariableBorrowRate: 0n,
            currentStableBorrowRate: 0n, lastUpdateTimestamp: r.updated, id: 5, aTokenAddress: ASSETS[k].aToken, stableDebtTokenAddress: z,
            variableDebtTokenAddress: z, interestRateStrategyAddress: z, accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n,
          },
        }),
      }
    }
    const call = decodeFunctionData({ abi: tokenAbi, data })
    const k = key(target)
    const isAToken = ASSETS[k].aToken.toLowerCase() === target.toLowerCase()
    let v: bigint
    if (call.functionName === 'totalSupply') v = state.reserves![k]!.supply
    else if (call.functionName === 'scaledBalanceOf') v = state.balances![k]!.scaled
    else v = isAToken ? state.balances![k]!.balance : state.reserves![k]!.cash
    return { success: true, returnData: encodeFunctionResult({ abi: tokenAbi, functionName: call.functionName, result: v } as never) }
  }
  chain.onCall = (params) => {
    const { to, data } = params[0] as { to: string; data: Hex }
    if (to.toLowerCase() !== MULTICALL3) throw new Error(`direct eth_call to ${to}`)
    const { args } = decodeFunctionData({ abi: multicall3Abi, data })
    const calls = args[0] as readonly { target: string; callData: Hex }[]
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map((c) => answer(c.target, c.callData)) })
  }
  chain.extra.eth_blockNumber = () => `0x${(state.head ?? 10_000).toString(16)}`
  chain.extra.eth_getLogs = (params) => {
    const f = params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[] | null)[] }
    const from = Number(f.fromBlock)
    const to = Number(f.toBlock)
    if (to - from + 1 > 1800) return new RpcError('block range too large', -32005)
    const ownerTopic = f.topics[1] as Hex | null | undefined
    return (state.logs ?? [])
      .filter((l) => l.block >= from && l.block <= to && f.address.toLowerCase() === state.router?.toLowerCase())
      .map((l) => {
        const topics = encodeEventTopics({ abi: routerAbi, eventName: l.event, args: { owner: l.owner, asset: l.asset } })
        return { ...l, topics }
      })
      .filter((l) => !ownerTopic || l.topics[1] === ownerTopic)
      .map((l) => ({
        address: state.router, blockNumber: `0x${l.block.toString(16)}`, logIndex: `0x${l.index.toString(16)}`, transactionIndex: '0x0',
        transactionHash: `0x${l.block.toString(16).padStart(64, '0')}`, blockHash: `0x${'b'.repeat(64)}`, removed: false,
        topics: l.topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [l.amount, l.liquidityIndex]),
      }))
  }
  vi.stubGlobal('fetch', chain.fetch)
  return chain
}

describe('GET /api/aave', () => {
  const reserves = {
    USDT0: { index: 1_233_364_243_528_847_484_446_194_210n, rate: 36_016_853_229_477_980_886_801_488n, updated: 1794108342, supply: 60_000_000_000_000n, virtual: 6_000_000_000_000n, cash: 1n },
    USDC: { index: 1_100_000_000_000_000_000_000_000_000n, rate: 40_000_000_000_000_000_000_000_000n, updated: 1794108000, supply: 10_000_000_000n, cash: 2_500_000_000n },
  }

  it('reads both reserves with one Multicall3 eth_call and states APY, index, rate and liquidity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 8, 12))
    const chain = polygon({ reserves })
    const r = await getJson('/api/aave', env(null))
    expect(r.status).toBe(200)
    expect(chain.calls.map((c) => c.method)).toEqual(['eth_call'])
    expect(r.body.asOf).toBe(Date.UTC(2026, 10, 8, 12))
    expect(r.body.reserves.USDT0).toEqual({
      supplyApy: expect.closeTo(Math.expm1(31_536_000 * Math.log1p(0.036016853229477980886801488 / 31_536_000)), 9),
      liquidityRateRay: '36016853229477980886801488',
      liquidityIndexRay: '1233364243528847484446194210',
      lastUpdate: 1794108342,
      availableLiquidity: '6000000000000',
      utilization: 0.9,
    })
    expect(r.body.reserves.USDT0.supplyApy).toBeCloseTo(0.03667, 4)
    // a pool without virtual accounting pays out of the aToken's underlying balance
    expect(r.body.reserves.USDC).toMatchObject({ availableLiquidity: '2500000000', utilization: 0.75, lastUpdate: 1794108000 })
    expect(r.headers.get('cache-control')).toMatch(/max-age=60/)
    // cached for 60 s
    await getJson('/api/aave', env(null))
    expect(chain.calls).toHaveLength(1)
  })

  it('answers 503 RPC_UNAVAILABLE when no Polygon RPC answers and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    const r = await getJson('/api/aave', env(null))
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ error: 'RPC_UNAVAILABLE' })
  })
})

describe('GET /api/position/:evm and the router log scan', () => {
  const ROUTER = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as Address
  const OWNER = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')
  const OTHER = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc')
  const USDT0 = ASSETS.USDT0.address
  const income = 1_200_000_000_000_000_000_000_000_000n
  // two supplies and one withdraw: 100 at index 1.0, 50 at 1.1, 55 out at 1.1; one supply by someone else
  const logs = [
    { block: 1000, index: 0, event: 'Supplied' as const, owner: OWNER, asset: USDT0, amount: 100_000_000n, liquidityIndex: RAY },
    { block: 1500, index: 3, event: 'Supplied' as const, owner: OTHER, asset: USDT0, amount: 7_000_000n, liquidityIndex: RAY },
    { block: 2000, index: 1, event: 'Supplied' as const, owner: OWNER, asset: USDT0, amount: 50_000_000n, liquidityIndex: 1_100_000_000_000_000_000_000_000_000n },
    { block: 3000, index: 2, event: 'Withdrawn' as const, owner: OWNER, asset: USDT0, amount: 55_000_000n, liquidityIndex: 1_100_000_000_000_000_000_000_000_000n },
  ]
  const scaled = 100_000_000n + (50_000_000n * RAY) / 1_100_000_000_000_000_000_000_000_000n - (55_000_000n * RAY) / 1_100_000_000_000_000_000_000_000_000n
  const balances = {
    USDT0: { balance: (scaled * income) / RAY + 3_000_000n, scaled: scaled + 2_500_000n, income },
    USDC: { balance: 0n, scaled: 0n, income: RAY },
  }
  const world = (head = 3_500) => polygon({ balances, head, logs, router: ROUTER })
  const routed = (DB: unknown) => env(DB, { ROUTER_ADDRESS: ROUTER, ROUTER_DEPLOY_BLOCK: '900' })

  it('earned = scaled from Accrue x index now - principal, over two supplies and one withdraw', async () => {
    const chain = world()
    const db = new FakeD1()
    // the cron folds what is settled (64 blocks behind the head) ...
    const scan = await scanRouterLogs(routed(db), { maxChunks: 3 })
    expect(scan).toMatchObject({ from: 900, to: 3_500 - 64, events: 4 })
    // ... the request adds the rest for its owner only
    chain.calls.length = 0
    const r = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(r.status).toBe(200)
    const tail = chain.calls.filter((c) => c.method === 'eth_getLogs')
    expect(tail).toHaveLength(1)
    expect((tail[0]!.params[0] as { fromBlock: Hex }).fromBlock).toBe(`0x${(3_500 - 64 + 1).toString(16)}`)

    // independent bookkeeping: principal shrinks with the share of scaled balance withdrawn
    const s1 = 100_000_000n
    const s2 = (50_000_000n * RAY) / 1_100_000_000_000_000_000_000_000_000n
    const burned = (55_000_000n * RAY) / 1_100_000_000_000_000_000_000_000_000n
    const principal = 150_000_000n - (150_000_000n * burned) / (s1 + s2)
    const a = r.body.assets.USDT0
    expect(BigInt(a.scaledFromAccrue) - scaled).toBeGreaterThanOrEqual(-2n)
    expect(BigInt(a.scaledFromAccrue) - scaled).toBeLessThanOrEqual(2n)
    expect(BigInt(a.principal) - principal).toBeGreaterThanOrEqual(-2n)
    expect(BigInt(a.principal) - principal).toBeLessThanOrEqual(2n)
    expect(BigInt(a.earned)).toBe((BigInt(a.scaledFromAccrue) * income) / RAY - BigInt(a.principal))
    expect(Number(a.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
    expect(a.aTokenBalance).toBe(String(balances.USDT0.balance))
    expect(r.body.assets.USDC).toEqual({ aTokenBalance: '0', scaledFromAccrue: '0', principal: '0', earned: '0' })
  })

  it('accepts EIP-55 and lowercase addresses alike, refuses anything else', async () => {
    world()
    const db = new FakeD1()
    await scanRouterLogs(routed(db), { maxChunks: 3 })
    const a = await getJson(`/api/position/${OWNER}`, routed(db))
    clearMemoryCache()
    const b = await getJson(`/api/position/${OWNER.toLowerCase()}`, routed(db))
    expect(b.body).toEqual(a.body)
    for (const bad of ['0x1234', 'nope', `${OWNER}00`]) expect((await getJson(`/api/position/${bad}`, routed(db))).status).toBe(400)
  })

  it('without a scan yet, a request reads from the deploy block in chunks of at most 1,800 blocks', async () => {
    const chain = world()
    const r = await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))
    expect(r.status).toBe(200)
    const ranges = chain.calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.params[0] as { fromBlock: Hex; toBlock: Hex })
    expect(ranges.length).toBe(2)
    for (const g of ranges) expect(Number(g.toBlock) - Number(g.fromBlock) + 1).toBeLessThanOrEqual(1800)
    expect(Number(r.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
  })

  it('answers 503 rather than a partial position when the unscanned range is longer than a request may read', async () => {
    world(900 + 20_000)
    const r = await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ error: 'RPC_UNAVAILABLE', detail: { reason: 'catching_up' } })
  })

  it('before the router is deployed: the live aToken balance and zeros for what Accrue tracks, no log query', async () => {
    const chain = world()
    const r = await getJson(`/api/position/${OWNER}`, env(new FakeD1(), { ROUTER_ADDRESS: '' }))
    expect(POLYGON.router).toBeNull()
    expect(r.status).toBe(200)
    expect(r.body.assets.USDT0).toEqual({ aTokenBalance: String(balances.USDT0.balance), scaledFromAccrue: '0', principal: '0', earned: '0' })
    expect(chain.calls.map((c) => c.method)).toEqual(['eth_call'])
    expect(await scanRouterLogs(env(new FakeD1(), { ROUTER_ADDRESS: '' }), { maxChunks: 3 })).toMatchObject({ skipped: true })
  })

  it('the cron scans the router after its indexer tick', async () => {
    world()
    const db = new FakeD1()
    const r = await runScheduled(routed(db))
    expect(r.router).toMatchObject({ from: 900, to: 3_436, events: 4 })
    expect(db.query<{ value: string }>("SELECT value FROM meta WHERE key = ?", `router_scan:${ROUTER.toLowerCase()}`)[0]!.value).toBe('3436')
  })

  it('the scan resumes where it stopped and never folds an event twice', async () => {
    world(3_500)
    const db = new FakeD1()
    expect(await scanRouterLogs(routed(db), { maxChunks: 1 })).toMatchObject({ from: 900, to: 2_699, events: 3 })
    expect(await scanRouterLogs(routed(db), { maxChunks: 1 })).toMatchObject({ from: 2_700, to: 3_436, events: 1 })
    expect(await scanRouterLogs(routed(db), { maxChunks: 1 })).toMatchObject({ events: 0 })
    const r = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(Number(r.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
    const other = await getJson(`/api/position/${OTHER}`, routed(db))
    expect(other.body.assets.USDT0.principal).toBe('7000000')
  })
})
