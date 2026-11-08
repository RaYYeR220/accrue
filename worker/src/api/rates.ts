import { Hono } from 'hono'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { bind, type Stmt } from '../indexer/store'
import { cacheGet, cachePut } from './cache'

export const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,tether&vs_currencies=usd&include_last_updated_at=true'
export const PAPRIKA_NIM_URL = 'https://api.coinpaprika.com/v1/tickers/nim-nimiq?quotes=USD'
export const PAPRIKA_USDT_URL = 'https://api.coinpaprika.com/v1/tickers/usdt-tether?quotes=USD'
export const GATE_NIM_URL = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT'
export const KRAKEN_USDT_URL = 'https://api.kraken.com/0/public/Ticker?pair=USDTZUSD'
export const FX_URL = 'https://open.er-api.com/v6/latest/USD'
// a copy this young is answered without asking anyone (the cron refreshes D1 every 5 minutes)
const CURRENT_MS = 10 * 60_000
// the cron leaves a copy alone while it is this young
const REWARM_MS = 4 * 60_000
// the last good copy is served this long when no source answers; after that there is no rate
export const LAST_GOOD_MS = 24 * 3_600_000
// after a failed fetch an isolate waits this long before asking the sources again
const RETRY_MS = 60_000
// a price source that refused is left out this long (kept in D1, so the cron and every isolate skip it)
export const REFUSED_SKIP_MS = 15 * 60_000
const FIATS = ['EUR', 'CRC', 'GMD'] as const

// CoinGecko refuses requests without a descriptive User-Agent, and a Worker's fetch sends none
const USER_AGENT = 'accrue/0.1 (+https://github.com/RaYYeR220/accrue)'

type Fx = Partial<Record<(typeof FIATS)[number], number>>
export interface PricePart {
  asOf: number
  nimUsd: number
  usdtUsd?: number
  source: string
}
export interface FxPart {
  asOf: number
  fx: Fx
  source: string
}
type Kind = 'price' | 'fx'
type Parts = { price?: PricePart; fx?: FxPart }
/** What D1 holds: the last good parts, and when each price source last refused. */
type Stored = Parts & { refused: Map<string, number> }

const lastGoodKey = (k: Kind) => `rates_last_good:${k}`
const REFUSED_PREFIX = 'rates_refused:'
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120)
// six significant digits; more would be the noise of a product of two quotes
const sig = (v: number) => Number(v.toPrecision(6))
// when the source says it priced, never later than now; the fetch time when it says nothing
const pricedAt = (ms: number, now: number) => (Number.isFinite(ms) && ms > 0 ? Math.min(ms, now) : now)

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`)
  return res.json()
}

async function fromCoinGecko(now: number): Promise<PricePart> {
  const b = (await getJson(PRICE_URL)) as Record<string, { usd?: unknown; last_updated_at?: unknown } | undefined>
  const nim = b?.['nimiq-2']
  const nimUsd = nim?.usd
  if (!positive(nimUsd)) throw new Error('CoinGecko: no NIM price')
  const usdt = b?.tether?.usd
  const at = typeof nim?.last_updated_at === 'number' ? nim.last_updated_at * 1000 : NaN
  return { asOf: pricedAt(at, now), nimUsd: sig(nimUsd), ...(positive(usdt) ? { usdtUsd: sig(usdt) } : {}), source: 'CoinGecko' }
}

type PaprikaTicker = { last_updated?: unknown; quotes?: { USD?: { price?: unknown } } } | null
const paprikaUsd = (b: unknown) => (b as PaprikaTicker)?.quotes?.USD?.price

async function fromCoinPaprika(now: number): Promise<PricePart> {
  const [nim, usdt] = await Promise.allSettled([getJson(PAPRIKA_NIM_URL), getJson(PAPRIKA_USDT_URL)])
  if (nim.status === 'rejected') throw nim.reason
  const nimUsd = paprikaUsd(nim.value)
  if (!positive(nimUsd)) throw new Error('CoinPaprika: no NIM price')
  const usdtUsd = usdt.status === 'fulfilled' ? paprikaUsd(usdt.value) : null
  const updated = (nim.value as PaprikaTicker)?.last_updated
  const at = typeof updated === 'string' ? Date.parse(updated) : NaN
  return { asOf: pricedAt(at, now), nimUsd: sig(nimUsd), ...(positive(usdtUsd) ? { usdtUsd: sig(usdtUsd) } : {}), source: 'CoinPaprika' }
}

const decimal = (v: unknown) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN)
// the middle of the best bid and ask when the book has both, else the last trade
const mid = (bid: number, ask: number, last: number) => (positive(bid) && positive(ask) ? (bid + ask) / 2 : last)

// NIM trades against USDT, not USD: the USD price is NIM/USDT on Gate.io times USDT/USD on Kraken,
// each the middle of its book (in a thin market the last trade can sit outside it), and without the
// second there is no USD price at all. A pair nobody traded in a day is no price either. Neither
// ticker carries a time, so the price is as of the fetch.
async function fromGateKraken(now: number): Promise<PricePart> {
  const [gate, kraken] = await Promise.all([getJson(GATE_NIM_URL), getJson(KRAKEN_USDT_URL)])
  const g = (gate as { last?: unknown; highest_bid?: unknown; lowest_ask?: unknown; base_volume?: unknown }[] | null)?.[0]
  if (g?.base_volume !== undefined && decimal(g.base_volume) === 0) throw new Error('Gate.io: no NIM_USDT trade in 24 h')
  const k = (kraken as { result?: { USDTZUSD?: { a?: unknown[]; b?: unknown[]; c?: unknown[] } } } | null)?.result?.USDTZUSD
  const nimUsdt = mid(decimal(g?.highest_bid), decimal(g?.lowest_ask), decimal(g?.last))
  const usdtUsd = mid(decimal(k?.b?.[0]), decimal(k?.a?.[0]), decimal(k?.c?.[0]))
  if (!positive(nimUsdt) || !positive(usdtUsd)) throw new Error('Gate.io/Kraken: no NIM/USDT or USDT/USD')
  return { asOf: now, nimUsd: sig(nimUsdt * usdtUsd), usdtUsd: sig(usdtUsd), source: 'Gate.io+Kraken' }
}

// In order of quality: two aggregators, then one exchange pair priced through another. Keyless price
// APIs throttle Cloudflare's shared egress addresses now and then (CoinGecko 429, CoinPaprika 402,
// seen live); a source that refused is left out for REFUSED_SKIP_MS, then asked in its place again.
const PRICE_SOURCES: [string, (now: number) => Promise<PricePart>][] = [
  ['CoinGecko', fromCoinGecko],
  ['CoinPaprika', fromCoinPaprika],
  ['Gate.io+Kraken', fromGateKraken],
]

/**
 * NIM (and USDT) in USD from the first source, in PRICE_SOURCES order, that answers; sources that
 * refused within REFUSED_SKIP_MS are left out (unless all of them did). Each refusal now is added to
 * `refused`.
 */
async function fetchPrice(now: number, stored: Stored, refused: string[]): Promise<PricePart> {
  const failures: string[] = []
  const open = PRICE_SOURCES.filter(([name]) => !(now - (stored.refused.get(name) ?? -Infinity) < REFUSED_SKIP_MS))
  for (const [name, source] of open.length ? open : PRICE_SOURCES) {
    try {
      return await source(now)
    } catch (e) {
      failures.push(msg(e))
      refused.push(name)
    }
  }
  throw new Error(failures.join('; '))
}

async function fetchFx(now: number): Promise<FxPart> {
  const b = (await getJson(FX_URL)) as { result?: unknown; rates?: Record<string, unknown> }
  if (b?.result !== 'success' || !b.rates) throw new Error('open.er-api.com: no rates')
  const fx: Fx = {}
  for (const f of FIATS) if (positive(b.rates[f])) fx[f] = b.rates[f]
  if (!Object.keys(fx).length) throw new Error('open.er-api.com: none of EUR, CRC, GMD')
  return { asOf: now, fx, source: 'open.er-api.com' }
}

const FETCH: Record<Kind, (now: number, stored: Stored, refused: string[]) => Promise<PricePart | FxPart>> = { price: fetchPrice, fx: fetchFx }

function parsePart(k: Kind, raw: string | null | undefined): PricePart | FxPart | undefined {
  if (!raw) return undefined
  try {
    const p = JSON.parse(raw) as Partial<PricePart & FxPart>
    if (!positive(p?.asOf) || typeof p.source !== 'string') return undefined
    if (k === 'price') return positive(p.nimUsd) ? (p as PricePart) : undefined
    return p.fx && typeof p.fx === 'object' ? (p as FxPart) : undefined
  } catch {
    return undefined
  }
}

async function readStored(db: D1Database | null | undefined): Promise<Stored> {
  const out: Stored = { refused: new Map() }
  try {
    const { results } = await db!
      .prepare('SELECT key, value, updated_at FROM meta WHERE key IN (?, ?) OR key LIKE ?')
      .bind(lastGoodKey('price'), lastGoodKey('fx'), `${REFUSED_PREFIX}%`)
      .all<{ key: string; value: string; updated_at: number }>()
    for (const r of results ?? []) {
      if (r.key === lastGoodKey('price')) out.price = parsePart('price', r.value) as PricePart | undefined
      else if (r.key === lastGoodKey('fx')) out.fx = parsePart('fx', r.value) as FxPart | undefined
      else out.refused.set(r.key.slice(REFUSED_PREFIX.length), r.updated_at)
    }
  } catch {
    // without D1 the in-memory copies still serve
  }
  return out
}

/** Upsert of a last good part; a copy older than the stored one (a slower writer) changes nothing. */
export function lastGoodStatement(k: Kind, part: PricePart | FxPart): Stmt {
  return {
    sql:
      'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.updated_at > meta.updated_at',
    params: [lastGoodKey(k), JSON.stringify(part), part.asOf],
  }
}

const refusedStatement = (source: string, now: number): Stmt => ({
  sql: 'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at',
  params: [`${REFUSED_PREFIX}${source}`, '', now],
})

async function keep(db: D1Database | null | undefined, parts: Parts, refused: readonly string[], now: number) {
  const stmts = [
    ...(['price', 'fx'] as const).flatMap((k) => (parts[k] ? [lastGoodStatement(k, parts[k]!)] : [])),
    ...[...new Set(refused)].map((s) => refusedStatement(s, now)),
  ]
  if (!stmts.length || !db) return
  try {
    await db.batch(bind(db, stmts))
  } catch (e) {
    console.warn('rates: keeping the last good copy failed', msg(e))
  }
}

const memoKey = (k: Kind) => `rates:${k}`
const failKey = (k: Kind) => `rates:${k}:failed`

async function cachedPart(k: Kind, maxAgeMs: number, now: number) {
  const e = await cacheGet(memoKey(k), maxAgeMs, now)
  return e ? parsePart(k, e.body) : undefined
}

/**
 * One part of the answer: this isolate's (or the data center's) copy while current, else D1's
 * last good copy while current, else the source. When the source fails, the newest copy no older
 * than LAST_GOOD_MS is served as stale; with none, nothing.
 */
async function resolvePart(
  k: Kind,
  now: number,
  read: () => Promise<Stored>,
  fetched: Parts,
  refused: string[],
): Promise<{ part: PricePart | FxPart; stale: boolean } | null> {
  const hit = await cachedPart(k, CURRENT_MS, now)
  if (hit) return { part: hit, stale: false }
  const stored = await read()
  const have = stored[k]
  if (have && now - have.asOf < CURRENT_MS && now >= have.asOf) {
    // stored under its own time, so it stops being current when the copy does
    await cachePut(memoKey(k), JSON.stringify(have), LAST_GOOD_MS, have.asOf)
    return { part: have, stale: false }
  }
  if (!(await cacheGet(failKey(k), RETRY_MS, now))) {
    try {
      const part = await FETCH[k](now, stored, refused)
      // kept as fetched now: a source whose own time is older is not asked again at once
      await cachePut(memoKey(k), JSON.stringify(part), LAST_GOOD_MS, now)
      Object.assign(fetched, { [k]: part })
      return { part, stale: false }
    } catch (e) {
      console.warn(`rates: ${k} unavailable`, msg(e))
      await cachePut(failKey(k), '1', RETRY_MS, now)
    }
  }
  const older = [have, await cachedPart(k, LAST_GOOD_MS, now)]
    .filter((p): p is PricePart | FxPart => !!p && now - p.asOf < LAST_GOOD_MS)
    .sort((a, b) => b.asOf - a.asOf)[0]
  return older ? { part: older, stale: true } : null
}

export const rates = new Hono<{ Bindings: Env }>()

// NIM in USD (CoinGecko, else CoinPaprika, else Gate.io with Kraken) and USD in EUR/CRC/GMD
// (open.er-api.com). The cron keeps the last good copy of each in D1, so a request rarely asks
// upstream. When the sources fail, the last good copy (at most a day old) is served with its own
// time and marked stale, each part on its own (`priceAsOf`/`priceStale`, `fxAsOf`/`fxStale`; `asOf`
// is the older one, `stale` either). A rate no source gave is left out, never filled in: the app then
// shows USD. Without any NIM price there is nothing to answer.
rates.get('/', async (c) => {
  const now = Date.now()
  let stored: Promise<Stored> | null = null
  const read = () => (stored ??= readStored(c.env?.DB))
  const fetched: Parts = {}
  const refused: string[] = []
  const [price, fx] = await Promise.all([resolvePart('price', now, read, fetched, refused), resolvePart('fx', now, read, fetched, refused)])
  await keep(c.env?.DB, fetched, refused, now)
  if (!price) {
    c.header('cache-control', 'no-store')
    return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'price_unavailable' }), 503)
  }
  const stale = price.stale || !!fx?.stale
  c.header('cache-control', stale ? 'public, max-age=30' : 'public, max-age=60')
  const p = price.part as PricePart
  const f = fx?.part as FxPart | undefined
  return c.json({
    asOf: Math.min(p.asOf, f?.asOf ?? p.asOf),
    priceAsOf: p.asOf,
    ...(f ? { fxAsOf: f.asOf } : {}),
    nimUsd: p.nimUsd,
    ...(p.usdtUsd !== undefined ? { usdtUsd: p.usdtUsd } : {}),
    fx: { USD: 1, ...(f?.fx ?? {}) },
    source: f ? [p.source, f.source] : [p.source],
    ...(stale ? { stale: true } : {}),
    ...(price.stale ? { priceStale: true } : {}),
    ...(fx?.stale ? { fxStale: true } : {}),
  })
})

/**
 * Cron step: refreshes whichever part of D1's last good copy is older than REWARM_MS, so requests
 * read current rates from D1 instead of asking the sources. Two D1 calls and up to five fetches;
 * never throws. Per part: the source that answered, 'kept' (still current) or 'failed'.
 */
export async function warmRates(env: Pick<Env, 'DB'>, now = Date.now()): Promise<Record<Kind, string>> {
  const stored = await readStored(env.DB)
  const fetched: Parts = {}
  const refused: string[] = []
  const out: Record<Kind, string> = { price: 'kept', fx: 'kept' }
  await Promise.all(
    (['price', 'fx'] as const).map(async (k) => {
      const have = stored[k]
      if (have && now - have.asOf < REWARM_MS && now >= have.asOf) return
      try {
        const part = await FETCH[k](now, stored, refused)
        Object.assign(fetched, { [k]: part })
        out[k] = part.source
      } catch (e) {
        console.warn(`rates: ${k} unavailable`, msg(e))
        out[k] = 'failed'
      }
    }),
  )
  await keep(env.DB, fetched, refused, now)
  return out
}
