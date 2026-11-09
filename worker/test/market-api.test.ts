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
import { lastGoodStatement, warmRates } from '../src/api/rates'
import { bind } from '../src/indexer/store'
import { aavePoolAbi } from '../src/api/aave'
import { deployBlock, routerConfig, scanRouterLogs } from '../src/indexer/router'
import { health } from '../src/api/health'
import { routerAbi } from '../src/relayer/chain'
import { runScheduled } from '../src/scheduled'
import { FakeD1 } from './d1'
import { FakeChain, HANG, RpcError } from './helpers'

const RAY = 10n ** 27n
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,tether&vs_currencies=usd&include_last_updated_at=true'
const ER_API = 'https://open.er-api.com/v6/latest/USD'
const PAPRIKA_NIM = 'https://api.coinpaprika.com/v1/tickers/nim-nimiq?quotes=USD'
const PAPRIKA_USDT = 'https://api.coinpaprika.com/v1/tickers/usdt-tether?quotes=USD'
const GATE = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT'
const KRAKEN = 'https://api.kraken.com/0/public/Ticker?pair=USDTZUSD'

const env = (DB: unknown, over: Record<string, unknown> = {}) =>
  ({ DB, NIM_RPCS: 'https://nim.test', POLYGON_RPCS: 'https://polygon.test', RELAYER_ADDRESS: '', RELAYER: null, ...over }) as never

// A build whose deployments.json names no router yet; the shared constants are read at call time.
async function withoutDeployment(fn: () => Promise<void>) {
  const saved = { router: POLYGON.router, deployBlock: POLYGON.deployBlock }
  Object.assign(POLYGON, { router: null, deployBlock: null })
  try {
    await fn()
  } finally {
    Object.assign(POLYGON, saved)
  }
}

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
  const DAY = 86_400_000
  const PAPRIKA_AT = Date.parse('2026-11-08T11:58:15Z')
  let coingecko: () => Response
  let paprika: () => Response
  let paprikaUsdt: () => Response
  let gate: () => Response
  let kraken: () => Response
  let erApi: () => Response
  const calls: string[] = []
  const edge = new Map<string, Response>()

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    calls.length = 0
    edge.clear()
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0.00027882 }, tether: { usd: 1.0002 } })
    paprika = () => Response.json({ id: 'nim-nimiq', symbol: 'NIM', last_updated: '2026-11-08T11:58:15Z', quotes: { USD: { price: 0.0002626 } } })
    paprikaUsdt = () => Response.json({ id: 'usdt-tether', symbol: 'USDT', last_updated: '2026-11-08T11:59:13Z', quotes: { USD: { price: 0.9988 } } })
    // the third source is down unless a test says otherwise
    gate = () => new Response('', { status: 503 })
    kraken = () => new Response('', { status: 503 })
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
        if (url === PAPRIKA_NIM) return paprika()
        if (url === PAPRIKA_USDT) return paprikaUsdt()
        if (url === GATE) return gate()
        if (url === KRAKEN) return kraken()
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
      asOf: T0, priceAsOf: T0, fxAsOf: T0, nimUsd: 0.00027882, usdtUsd: 1.0002, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: ['CoinGecko', 'open.er-api.com'],
    })
    vi.setSystemTime(T0 + 4 * 60_000)
    expect((await getJson('/api/rates', env(null))).body.asOf).toBe(T0)
    // a new isolate finds the data center's copy
    clearMemoryCache()
    expect((await getJson('/api/rates', env(null))).body.asOf).toBe(T0)
    expect(calls).toHaveLength(2)
  })

  it('falls back to the cached copy when every price source fails, for up to a day, marked stale', async () => {
    await getJson('/api/rates', env(null))
    coingecko = () => new Response('oops', { status: 500 })
    paprika = () => new Response('oops', { status: 500 })
    vi.setSystemTime(T0 + 6 * 60_000)
    const recent = await getJson('/api/rates', env(null))
    expect(recent.status).toBe(200)
    expect(recent.body.nimUsd).toBe(0.00027882)
    expect(recent.body.asOf).toBe(T0)
    vi.setSystemTime(T0 + 61 * 60_000)
    const stale = await getJson('/api/rates', env(null))
    expect(stale.status).toBe(200)
    expect(stale.body).toMatchObject({ asOf: T0, nimUsd: 0.00027882, stale: true })
    vi.setSystemTime(T0 + DAY + 60_000)
    const gone = await getJson('/api/rates', env(null))
    expect(gone.status).toBe(503)
    expect(gone.body).toEqual({ error: 'RPC_UNAVAILABLE', detail: { reason: 'price_unavailable' } })
  })

  it('asks CoinPaprika when CoinGecko refuses, NIM and USDT both from it', async () => {
    coingecko = () => Response.json({ status: { error_code: 403 } }, { status: 403 })
    const r = await getJson('/api/rates', env(null))
    expect(r.status).toBe(200)
    // the price is as old as CoinPaprika says, not as old as the fetch
    expect(r.body).toEqual({
      asOf: PAPRIKA_AT, priceAsOf: PAPRIKA_AT, fxAsOf: T0, nimUsd: 0.0002626, usdtUsd: 0.9988, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: ['CoinPaprika', 'open.er-api.com'],
    })
    expect(calls.filter((u) => u.startsWith('https://api.coinpaprika.com/')).sort()).toEqual([PAPRIKA_NIM, PAPRIKA_USDT])
  })

  it('never invents a USDT price: a source without one leaves it out', async () => {
    coingecko = () => new Response('', { status: 429 })
    paprikaUsdt = () => new Response('', { status: 500 })
    const r = await getJson('/api/rates', env(null))
    expect(r.body.nimUsd).toBe(0.0002626)
    expect(r.body).not.toHaveProperty('usdtUsd')
    clearMemoryCache()
    edge.clear()
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0.00027882 } })
    const g = await getJson('/api/rates', env(new FakeD1()))
    expect(g.body.source).toEqual(['CoinGecko', 'open.er-api.com'])
    expect(g.body).not.toHaveProperty('usdtUsd')
  })

  it('the cron keeps the last good rates in D1 and requests read them there, not upstream', async () => {
    const db = new FakeD1()
    expect(await warmRates(env(db))).toEqual({ price: 'CoinGecko', fx: 'open.er-api.com' })
    const stored = db.query<{ key: string; value: string; updated_at: number }>("SELECT key, value, updated_at FROM meta WHERE key LIKE 'rates_last_good%' ORDER BY key")
    expect(stored.map((r) => [r.key, JSON.parse(r.value), r.updated_at])).toEqual([
      ['rates_last_good:fx', { asOf: T0, fx: { EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: 'open.er-api.com' }, T0],
      ['rates_last_good:price', { asOf: T0, nimUsd: 0.00027882, usdtUsd: 1.0002, source: 'CoinGecko' }, T0],
    ])
    calls.length = 0
    vi.setSystemTime(T0 + 4 * 60_000)
    const r = await getJson('/api/rates', env(db))
    expect(r.body).toEqual({
      asOf: T0, priceAsOf: T0, fxAsOf: T0, nimUsd: 0.00027882, usdtUsd: 1.0002, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: ['CoinGecko', 'open.er-api.com'],
    })
    expect(calls).toEqual([])
    // a copy refreshed less than four minutes ago is left alone
    vi.setSystemTime(T0 + 3 * 60_000)
    expect(await warmRates(env(db))).toEqual({ price: 'kept', fx: 'kept' })
    expect(calls).toEqual([])
  })

  it('with every source down, a fresh isolate serves the last good copy from D1 for 24 h with its own asOf, then 503', async () => {
    const db = new FakeD1()
    await warmRates(env(db))
    coingecko = () => new Response('', { status: 403 })
    paprika = () => new Response('', { status: 503 })
    erApi = () => new Response('', { status: 429 })
    vi.setSystemTime(T0 + 30 * 60_000)
    expect(await warmRates(env(db))).toEqual({ price: 'failed', fx: 'failed' })
    clearMemoryCache()
    edge.clear()
    const stale = await getJson('/api/rates', env(db))
    expect(stale.status).toBe(200)
    expect(stale.body).toEqual({
      asOf: T0, priceAsOf: T0, fxAsOf: T0, nimUsd: 0.00027882, usdtUsd: 1.0002, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, source: ['CoinGecko', 'open.er-api.com'],
      stale: true, priceStale: true, fxStale: true,
    })
    vi.setSystemTime(T0 + DAY - 60_000)
    clearMemoryCache()
    expect((await getJson('/api/rates', env(db))).body).toMatchObject({ asOf: T0, stale: true })
    vi.setSystemTime(T0 + DAY + 60_000)
    clearMemoryCache()
    const gone = await getJson('/api/rates', env(db))
    expect(gone.status).toBe(503)
    expect(gone.headers.get('cache-control')).toBe('no-store')
    expect(gone.body).toEqual({ error: 'RPC_UNAVAILABLE', detail: { reason: 'price_unavailable' } })
  })

  it('FX gets the same treatment: the last good FX up to 24 h old, marked stale, then USD only', async () => {
    const db = new FakeD1()
    await warmRates(env(db))
    erApi = () => new Response('', { status: 502 })
    vi.setSystemTime(T0 + 2 * 3_600_000)
    clearMemoryCache()
    const r = await getJson('/api/rates', env(db))
    // a fresh price beside a stale FX copy: each part says how old it is
    expect(r.body).toMatchObject({ asOf: T0, priceAsOf: T0 + 2 * 3_600_000, fxAsOf: T0, nimUsd: 0.00027882, fx: { USD: 1, EUR: 0.8613, CRC: 502.27, GMD: 72.5 }, stale: true, fxStale: true })
    expect(r.body).not.toHaveProperty('priceStale')
    vi.setSystemTime(T0 + DAY + 60_000)
    clearMemoryCache()
    const later = await getJson('/api/rates', env(db))
    expect(later.body).toEqual({ asOf: T0 + DAY + 60_000, priceAsOf: T0 + DAY + 60_000, nimUsd: 0.00027882, usdtUsd: 1.0002, fx: { USD: 1 }, source: ['CoinGecko'] })
  })

  it('a request that had to fetch keeps what it got as the last good copy, and an older copy never replaces it', async () => {
    const db = new FakeD1()
    coingecko = () => new Response('', { status: 403 })
    await getJson('/api/rates', env(db))
    const price = () => JSON.parse(db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'rates_last_good:price'")[0]!.value)
    expect(price()).toEqual({ asOf: PAPRIKA_AT, nimUsd: 0.0002626, usdtUsd: 0.9988, source: 'CoinPaprika' })
    // a slower writer that fetched earlier lands second
    await db.batch(bind(db as never, [lastGoodStatement('price', { asOf: PAPRIKA_AT - 60_000, nimUsd: 0.0001, source: 'CoinGecko' })]) as never)
    expect(price().asOf).toBe(PAPRIKA_AT)
  })

  it('while the sources are down, an isolate asks them again at most once a minute', async () => {
    const db = new FakeD1()
    await warmRates(env(db))
    coingecko = () => new Response('', { status: 403 })
    paprika = () => new Response('', { status: 503 })
    vi.setSystemTime(T0 + 20 * 60_000)
    calls.length = 0
    for (let i = 0; i < 5; i++) expect((await getJson('/api/rates', env(db))).body.stale).toBe(true)
    expect(calls.filter((u) => u === COINGECKO)).toHaveLength(1)
    vi.setSystemTime(T0 + 21 * 60_000 + 1)
    await getJson('/api/rates', env(db))
    expect(calls.filter((u) => u === COINGECKO)).toHaveLength(2)
  })

  it('with CoinGecko and CoinPaprika both refusing, NIM/USDT from Gate.io times USDT/USD from Kraken', async () => {
    coingecko = () => new Response('Throttled', { status: 429 })
    paprika = () => new Response('', { status: 402 })
    gate = () => Response.json([{ currency_pair: 'NIM_USDT', last: '0.000262', lowest_ask: '0.0002672', highest_bid: '0.0002622' }])
    kraken = () => Response.json({ error: [], result: { USDTZUSD: { a: ['0.99856000'], b: ['0.99855000'], c: ['0.99856000', '18.3'] } } })
    const r = await getJson('/api/rates', env(new FakeD1()))
    expect(r.status).toBe(200)
    // the middle of bid and ask on both books, not a last trade that may sit outside them
    expect(r.body.nimUsd).toBe(Number((((0.0002672 + 0.0002622) / 2) * ((0.99856 + 0.99855) / 2)).toPrecision(6)))
    expect(r.body.usdtUsd).toBe(0.998555)
    expect(r.body.source).toEqual(['Gate.io+Kraken', 'open.er-api.com'])
  })

  it('a NIM/USDT price alone is not a USD price: without USDT/USD there is no third source', async () => {
    coingecko = () => new Response('', { status: 429 })
    paprika = () => new Response('', { status: 402 })
    gate = () => Response.json([{ currency_pair: 'NIM_USDT', last: '0.000262' }])
    kraken = () => Response.json({ error: ['EGeneral:Too many requests'] })
    const r = await getJson('/api/rates', env(new FakeD1()))
    expect(r.status).toBe(503)
  })

  it('keeps the order CoinGecko, CoinPaprika, Gate.io+Kraken, and skips a source for 15 minutes after it refuses', async () => {
    coingecko = () => new Response('', { status: 429 })
    const db = new FakeD1()
    expect((await warmRates(env(db))).price).toBe('CoinPaprika')
    calls.length = 0
    vi.setSystemTime(T0 + 5 * 60_000)
    expect((await warmRates(env(db))).price).toBe('CoinPaprika')
    expect(calls).not.toContain(COINGECKO)
    // a request in another isolate skips it too: the refusal is kept in D1
    clearMemoryCache()
    vi.setSystemTime(T0 + 14 * 60_000)
    calls.length = 0
    expect((await getJson('/api/rates', env(db))).body.source[0]).toBe('CoinPaprika')
    expect(calls).not.toContain(COINGECKO)
    // fifteen minutes on, CoinGecko is asked first again, and wins when it answers
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0.00027882 }, tether: { usd: 1.0002 } })
    vi.setSystemTime(T0 + 16 * 60_000)
    expect((await warmRates(env(db))).price).toBe('CoinGecko')
  })

  it('a pair with no trade in a day is no price, and a price is rounded to six significant digits', async () => {
    coingecko = () => new Response('', { status: 429 })
    paprika = () => new Response('', { status: 402 })
    gate = () => Response.json([{ currency_pair: 'NIM_USDT', last: '0.000262', lowest_ask: '0.0002672', highest_bid: '0.0002622', base_volume: '0' }])
    kraken = () => Response.json({ error: [], result: { USDTZUSD: { a: ['1.0001'], b: ['0.9999'], c: ['1'] } } })
    expect((await getJson('/api/rates', env(new FakeD1()))).status).toBe(503)
    clearMemoryCache()
    edge.clear()
    coingecko = () => Response.json({ 'nimiq-2': { usd: 0.000278823456, last_updated_at: 1794139080 }, tether: { usd: 1.000234567 } })
    const r = await getJson('/api/rates', env(new FakeD1()))
    expect(r.body).toMatchObject({ nimUsd: 0.000278823, usdtUsd: 1.00023, priceAsOf: 1794139080_000 })
  })

  it('the cron reports what it did with the rates', async () => {
    const db = new FakeD1()
    // the pool sync and the prune are done, the rates are due
    db.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('pools_synced_at', '21', ?), ('pruned_day', ?, ?)").run(T0, String(Math.floor(T0 / DAY)), T0)
    coingecko = () => new Response('', { status: 403 })
    const r = await runScheduled(env(db, { NIM_RPCS: '' }))
    expect(r.job).toBe('rates')
    expect(r.rates).toEqual({ price: 'CoinPaprika', fx: 'open.er-api.com' })
    expect(db.query<{ updated_at: number }>("SELECT updated_at FROM meta WHERE key = 'rates_tried_at'")[0]!.updated_at).toBe(T0)
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
    paprika = () => Response.json({ quotes: { USD: { price: 0 } } })
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
  // enough 100-block chunks to fold the whole test history (deploy block 900, head 3,500) in one scan
  const ALL = { maxChunks: 30 }

  it('earned = scaled from Accrue x index now - principal, over two supplies and one withdraw', async () => {
    const chain = world()
    const db = new FakeD1()
    // the cron folds what is settled (64 blocks behind the head) ...
    const scan = await scanRouterLogs(routed(db), ALL)
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
    await scanRouterLogs(routed(db), ALL)
    const a = await getJson(`/api/position/${OWNER}`, routed(db))
    clearMemoryCache()
    const b = await getJson(`/api/position/${OWNER.toLowerCase()}`, routed(db))
    expect(b.body).toEqual(a.body)
    for (const bad of ['0x1234', 'nope', `${OWNER}00`]) expect((await getJson(`/api/position/${bad}`, routed(db))).status).toBe(400)
  })

  it('router logs go in chunks a capped free node serves on its own (drpc: about 100 blocks), so a stalling node is never needed', async () => {
    const chain = world()
    const served = chain.extra.eth_getLogs!
    // what Cloudflare's egress sees: drpc refuses more than ~100 blocks at once, publicnode stalls 3 s and refuses
    chain.extra.eth_getLogs = (params, url) => {
      const f = params[0] as { fromBlock: Hex; toBlock: Hex }
      if (url.startsWith('https://capped.test') && Number(f.toBlock) - Number(f.fromBlock) + 1 > 101) return new RpcError('ranges over 10000 blocks are not supported on free plan', 35)
      if (url.startsWith('https://stalls.test')) return HANG
      return served(params, url)
    }
    const db = new FakeD1()
    const e = env(db, { ROUTER_ADDRESS: ROUTER, ROUTER_DEPLOY_BLOCK: '900', POLYGON_RPCS: 'https://polygon.test', POLYGON_LOG_RPCS: 'https://capped.test,https://stalls.test' })
    // the cron folds the whole history through the capped node alone, a few chunks per run
    for (let i = 0; i < 20 && cursorOf(db) !== '3436'; i++) expect((await scanRouterLogs(e)).error).toBeUndefined()
    expect(cursorOf(db)).toBe('3436')
    const t0 = Date.now()
    const r = await getJson(`/api/position/${OWNER}`, e)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r.body.partial).toBeUndefined()
    expect(Number(r.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
    const logReads = chain.calls.filter((c) => c.method === 'eth_getLogs')
    expect(logReads.every((c) => c.url.startsWith('https://capped.test'))).toBe(true)
  }, 10_000)

  it('without a scan yet, a request reads up to 1,000 blocks from the deploy block in chunks of at most 100 blocks', async () => {
    // deploy block 900, head 1,899: the owner's first supply (block 1000) is in the range
    const chain = world(1_899)
    const r = await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))
    expect(r.status).toBe(200)
    expect(r.body.partial).toBeUndefined()
    const ranges = chain.calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.params[0] as { fromBlock: Hex; toBlock: Hex })
    expect(ranges.length).toBe(10)
    for (const g of ranges) expect(Number(g.toBlock) - Number(g.fromBlock) + 1).toBeLessThanOrEqual(100)
    const a = r.body.assets.USDT0
    expect(BigInt(a.principal)).toBeGreaterThan(0n)
    expect(BigInt(a.earned)).toBe((BigInt(a.scaledFromAccrue) * income) / RAY - BigInt(a.principal))
    // one block more than a request may read: partial, the cron has to catch up first
    world(1_900)
    clearMemoryCache()
    expect((await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))).body).toMatchObject({ partial: true, reason: 'catching_up' })
  })

  // what a withdrawal needs (the aToken balance) is always there; only what Accrue tracks is missing
  const partialBody = (reason: string) => ({
    partial: true,
    reason,
    assets: {
      USDT0: { aTokenBalance: String(balances.USDT0.balance), scaledFromAccrue: null, principal: null, earned: null },
      USDC: { aTokenBalance: '0', scaledFromAccrue: null, principal: null, earned: null },
    },
  })

  it('when the unscanned range is longer than a request may read: the live balances, partial, catching_up', async () => {
    world(900 + 20_000)
    const r = await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))
    expect(r.status).toBe(200)
    expect(r.body).toEqual(partialBody('catching_up'))
  })

  it('when no RPC serves the router logs: the live balances, partial, router_logs, and nothing cached', async () => {
    const chain = world()
    const db = new FakeD1()
    await scanRouterLogs(routed(db), ALL)
    chain.extra.eth_getLogs = () => new RpcError('eth_getLogs is limited to 0 - 50 blocks range', -32602)
    const r = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(r.status).toBe(200)
    expect(r.body).toEqual(partialBody('router_logs'))
    // the next request tries the logs again rather than serving the partial answer
    world()
    const again = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(again.body.partial).toBeUndefined()
    expect(Number(again.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
  })

  it('a log RPC that hangs does not hold the answer: partial within about three seconds', async () => {
    const chain = world()
    const db = new FakeD1()
    await scanRouterLogs(routed(db), ALL)
    chain.extra.eth_getLogs = () => HANG
    const t0 = Date.now()
    const r = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(Date.now() - t0).toBeLessThan(3_600)
    expect(r.body).toEqual(partialBody('router_logs'))
  }, 10_000)

  it('a balance read gives up on a hanging RPC after 2.5 s and asks the next one', async () => {
    const chain = world()
    const db = new FakeD1()
    await scanRouterLogs(routed(db), ALL)
    const onCall = chain.onCall
    chain.onCall = (params, url) => (url.startsWith('https://slow.test') ? HANG : onCall(params, url))
    const t0 = Date.now()
    const r = await getJson(`/api/position/${OWNER}`, env(db, { ROUTER_ADDRESS: ROUTER, ROUTER_DEPLOY_BLOCK: '900', POLYGON_RPCS: 'https://slow.test,https://polygon.test' }))
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(2_400)
    expect(took).toBeLessThan(3_600)
    expect(r.status).toBe(200)
    expect(r.body.assets.USDT0.aTokenBalance).toBe(String(balances.USDT0.balance))
  }, 10_000)

  it('reads router logs from POLYGON_LOG_RPCS (the getLogs-capable nodes) when set, balances from POLYGON_RPCS', async () => {
    const chain = world()
    const db = new FakeD1()
    const e = env(db, { ROUTER_ADDRESS: ROUTER, ROUTER_DEPLOY_BLOCK: '900', POLYGON_RPCS: 'https://capped.test', POLYGON_LOG_RPCS: 'https://logs.test' })
    expect(await scanRouterLogs(e, ALL)).toMatchObject({ events: 4 })
    const r = await getJson(`/api/position/${OWNER}`, e)
    expect(Number(r.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
    const hosts = (m: string) => new Set(chain.calls.filter((c) => c.method === m).map((c) => new URL(c.url).host))
    expect(hosts('eth_getLogs')).toEqual(new Set(['logs.test']))
    expect(hosts('eth_call')).toEqual(new Set(['capped.test']))
  })

  it('?fresh=1 skips a cached copy older than 3 s, at most one fresh read per owner every 3 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = Date.UTC(2026, 10, 9, 13)
    vi.setSystemTime(t)
    const chain = world()
    const db = new FakeD1()
    await scanRouterLogs(routed(db), ALL)
    await getJson(`/api/position/${OWNER}`, routed(db))
    const reads = () => chain.count('eth_call')
    const before = reads()
    vi.setSystemTime(t + 2_000)
    // within 3 s even a fresh request is answered from the copy
    await getJson(`/api/position/${OWNER}?fresh=1`, routed(db))
    expect(reads()).toBe(before)
    vi.setSystemTime(t + 6_000)
    // a plain request still takes the 15 s copy
    await getJson(`/api/position/${OWNER}`, routed(db))
    expect(reads()).toBe(before)
    const fresh = await getJson(`/api/position/${OWNER}?fresh=1`, routed(db))
    expect(fresh.status).toBe(200)
    expect(reads()).toBe(before + 1)
    // and that read is what everyone gets next
    await getJson(`/api/position/${OWNER}?fresh=1`, routed(db))
    await getJson(`/api/position/${OWNER}`, routed(db))
    expect(reads()).toBe(before + 1)
  })

  it('before the router is deployed: the live aToken balance and zeros for what Accrue tracks, no log query', async () => {
    const chain = world()
    await withoutDeployment(async () => {
      const r = await getJson(`/api/position/${OWNER}`, env(new FakeD1(), { ROUTER_ADDRESS: '' }))
      expect(r.status).toBe(200)
      expect(r.body.assets.USDT0).toEqual({ aTokenBalance: String(balances.USDT0.balance), scaledFromAccrue: '0', principal: '0', earned: '0' })
      expect(chain.calls.map((c) => c.method)).toEqual(['eth_call'])
      expect(await scanRouterLogs(env(new FakeD1(), { ROUTER_ADDRESS: '' }), ALL)).toMatchObject({ skipped: true })
    })
  })

  const cursorOf = (db: FakeD1) => db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', `router_scan:${ROUTER.toLowerCase()}`)[0]?.value

  it('every cron run scans the router, six 100-block chunks at most', async () => {
    world()
    const db = new FakeD1()
    const r = await runScheduled(routed(db))
    expect(r.router).toMatchObject({ from: 900, to: 1_499, events: 1 })
    expect(cursorOf(db)).toBe('1499')
    expect((await runScheduled(routed(db))).router).toMatchObject({ from: 1_500, to: 2_099, events: 2 })
  })

  it('a run whose job never finishes (as when the platform stops it) has already moved the router fold', async () => {
    const chain = world()
    // everything but Polygon hangs: the indexer job, whatever it is, never returns
    vi.stubGlobal('fetch', (input: unknown, init?: { body?: string }) =>
      String(input).startsWith('https://polygon.test') ? chain.fetch(input, init) : new Promise(() => {}),
    )
    const db = new FakeD1()
    void runScheduled(routed(db))
    await vi.waitFor(() => expect(cursorOf(db)).toBe('1499'))
  })

  it('/api/health reports how far the router fold is behind the head, in blocks and in minutes since it moved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = Date.UTC(2026, 10, 9, 13)
    vi.setSystemTime(t)
    world(3_500)
    const db = new FakeD1()
    // nothing folded yet: the whole range since the deploy block
    expect((await health(routed(db))).router).toEqual({ address: ROUTER, deployBlock: 900, lagBlocks: 2_601, lagMinutes: null })
    await scanRouterLogs(routed(db), ALL)
    vi.setSystemTime(t + 3 * 60_000)
    world(3_590)
    expect((await health(routed(db))).router).toEqual({ address: ROUTER, deployBlock: 900, lagBlocks: 154, lagMinutes: 3 })
    // without a head the block lag is unknown, the time lag is not
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    expect((await health(routed(db))).router).toEqual({ address: ROUTER, deployBlock: 900, lagBlocks: null, lagMinutes: 3 })
  })

  it('the scan resumes where it stopped and never folds an event twice', async () => {
    world(3_500)
    const db = new FakeD1()
    expect(await scanRouterLogs(routed(db), { maxChunks: 18 })).toMatchObject({ from: 900, to: 2_699, events: 3 })
    expect(await scanRouterLogs(routed(db), { maxChunks: 18 })).toMatchObject({ from: 2_700, to: 3_436, events: 1 })
    expect(await scanRouterLogs(routed(db), { maxChunks: 18 })).toMatchObject({ events: 0 })
    const r = await getJson(`/api/position/${OWNER}`, routed(db))
    expect(Number(r.body.assets.USDT0.earned) / 1e6).toBeCloseTo(114.545454 - 98.4375, 3)
    const other = await getJson(`/api/position/${OTHER}`, routed(db))
    expect(other.body.assets.USDT0.principal).toBe('7000000')
  })

  it('a router address without its deploy block: the deployed one falls back to deployments.json, any other is reported, not skipped', async () => {
    const deployed = { router: ROUTER, deployBlock: 66_000_000 }
    expect(deployBlock({ ROUTER_ADDRESS: '' }, deployed)).toBe(66_000_000)
    expect(deployBlock({ ROUTER_ADDRESS: ROUTER.toLowerCase() }, deployed)).toBe(66_000_000)
    expect(deployBlock({ ROUTER_ADDRESS: OTHER }, deployed)).toBeNull()
    expect(deployBlock({ ROUTER_ADDRESS: OTHER, ROUTER_DEPLOY_BLOCK: '900' }, deployed)).toBe(900)
    expect(routerConfig({ ROUTER_ADDRESS: ROUTER }, deployed)).toEqual({ router: ROUTER, deployBlock: 66_000_000 })
    expect(routerConfig({ ROUTER_ADDRESS: OTHER }, deployed)).toEqual({ router: OTHER, deployBlock: null, misconfigured: true })
    expect(routerConfig({ ROUTER_ADDRESS: '' }, { router: null, deployBlock: null })).toBeNull()

    // an override that is not deployments.json's router needs its block
    world()
    const bad = env(new FakeD1(), { ROUTER_ADDRESS: ROUTER })
    expect(await scanRouterLogs(bad, ALL)).toMatchObject({ error: expect.stringMatching(/misconfigured/) })
    const r = await getJson(`/api/position/${OWNER}`, bad)
    expect(r).toMatchObject({ status: 503, body: { error: 'RPC_UNAVAILABLE', detail: { reason: 'router_misconfigured' } } })
    const h = await health(bad)
    expect(h).toMatchObject({ ok: false, router: 'misconfigured' })
    expect(await health(routed(new FakeD1()))).toMatchObject({ ok: true, router: { address: ROUTER, deployBlock: 900 } })
    expect(await health(env(new FakeD1(), { ROUTER_ADDRESS: '' }))).toMatchObject({
      ok: true,
      router: { address: POLYGON.router, deployBlock: POLYGON.deployBlock },
    })
    await withoutDeployment(async () => {
      expect(await health(env(new FakeD1(), { ROUTER_ADDRESS: '' }))).toMatchObject({ ok: true, router: null })
    })
  })

  it('folds 250 owners in one scan without binding more than 100 parameters in a statement', async () => {
    const owners = Array.from({ length: 250 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`))
    polygon({
      balances, head: 3_500, router: ROUTER,
      logs: owners.map((owner, i) => ({ block: 1_000 + i, index: 0, event: 'Supplied' as const, owner, asset: USDT0, amount: 1_000_000n + BigInt(i), liquidityIndex: RAY })),
    })
    const db = new FakeD1()
    // D1 refuses a statement with more than 100 bound parameters
    const limited = {
      prepare: (sql: string) =>
        new Proxy(db.prepare(sql), {
          get(target, prop, recv) {
            if (prop !== 'bind') return Reflect.get(target, prop, recv)
            return (...args: unknown[]) => {
              if (args.length > 100) throw new Error('D1_ERROR: too many SQL variables')
              return target.bind(...args)
            }
          },
        }),
      batch: (s: never[]) => db.batch(s),
    }
    expect(await scanRouterLogs(routed(limited), ALL)).toMatchObject({ events: 250 })
    expect(db.query<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'router_pos:%'")[0]!.n).toBe(250)
    const r = await getJson(`/api/position/${owners[199]}`, routed(db))
    expect(r.body.assets.USDT0.principal).toBe('1000199')
  })

  it('a D1 failure while reading Accrue holdings still answers the live balances, partial with db_error', async () => {
    world()
    const DB = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: internal') }, first: async () => { throw new Error('D1_ERROR: internal') } }) }) }
    const r = await getJson(`/api/position/${OWNER}`, routed(DB))
    expect(r.status).toBe(200)
    expect(r.body).toEqual(partialBody('db_error'))
  })

  it('no Polygon RPC answering the balance read is still 503: there is nothing to show', async () => {
    const chain = world()
    chain.onCall = () => new RpcError('upstream down', -32603)
    const r = await getJson(`/api/position/${OWNER}`, routed(new FakeD1()))
    expect(r).toMatchObject({ status: 503, body: { error: 'RPC_UNAVAILABLE', detail: { reason: 'polygon_rpc' } } })
  })
})
