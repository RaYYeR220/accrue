import { Hono } from 'hono'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { bind, type Stmt } from '../indexer/store'
import { cacheGet, cachePut } from './cache'

export const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,tether&vs_currencies=usd'
export const PAPRIKA_NIM_URL = 'https://api.coinpaprika.com/v1/tickers/nim-nimiq?quotes=USD'
export const PAPRIKA_USDT_URL = 'https://api.coinpaprika.com/v1/tickers/usdt-tether?quotes=USD'
export const FX_URL = 'https://open.er-api.com/v6/latest/USD'
// a copy this young is answered without asking anyone (the cron refreshes D1 every 5 minutes)
const CURRENT_MS = 10 * 60_000
// the cron leaves a copy alone while it is this young
const REWARM_MS = 4 * 60_000
// the last good copy is served this long when no source answers; after that there is no rate
export const LAST_GOOD_MS = 24 * 3_600_000
// after a failed fetch an isolate waits this long before asking the sources again
const RETRY_MS = 60_000
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

const lastGoodKey = (k: Kind) => `rates_last_good:${k}`
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120)

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`)
  return res.json()
}

async function fromCoinGecko(now: number): Promise<PricePart> {
  const b = (await getJson(PRICE_URL)) as Record<string, { usd?: unknown } | undefined>
  const nimUsd = b?.['nimiq-2']?.usd
  if (!positive(nimUsd)) throw new Error('CoinGecko: no NIM price')
  const usdt = b?.tether?.usd
  return { asOf: now, nimUsd, ...(positive(usdt) ? { usdtUsd: usdt } : {}), source: 'CoinGecko' }
}

const paprikaUsd = (b: unknown) => (b as { quotes?: { USD?: { price?: unknown } } } | null)?.quotes?.USD?.price

async function fromCoinPaprika(now: number): Promise<PricePart> {
  const [nim, usdt] = await Promise.allSettled([getJson(PAPRIKA_NIM_URL), getJson(PAPRIKA_USDT_URL)])
  if (nim.status === 'rejected') throw nim.reason
  const nimUsd = paprikaUsd(nim.value)
  if (!positive(nimUsd)) throw new Error('CoinPaprika: no NIM price')
  const usdtUsd = usdt.status === 'fulfilled' ? paprikaUsd(usdt.value) : null
  return { asOf: now, nimUsd, ...(positive(usdtUsd) ? { usdtUsd } : {}), source: 'CoinPaprika' }
}

/** NIM (and USDT) in USD: CoinGecko, or CoinPaprika when CoinGecko does not answer (it refuses some Cloudflare egress). */
async function fetchPrice(now: number): Promise<PricePart> {
  try {
    return await fromCoinGecko(now)
  } catch (first) {
    try {
      return await fromCoinPaprika(now)
    } catch (second) {
      throw new Error(`${msg(first)}; ${msg(second)}`)
    }
  }
}

async function fetchFx(now: number): Promise<FxPart> {
  const b = (await getJson(FX_URL)) as { result?: unknown; rates?: Record<string, unknown> }
  if (b?.result !== 'success' || !b.rates) throw new Error('open.er-api.com: no rates')
  const fx: Fx = {}
  for (const f of FIATS) if (positive(b.rates[f])) fx[f] = b.rates[f]
  if (!Object.keys(fx).length) throw new Error('open.er-api.com: none of EUR, CRC, GMD')
  return { asOf: now, fx, source: 'open.er-api.com' }
}

const FETCH: Record<Kind, (now: number) => Promise<PricePart | FxPart>> = { price: fetchPrice, fx: fetchFx }

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

async function readLastGood(db: D1Database | null | undefined): Promise<Parts> {
  try {
    const { results } = await db!
      .prepare('SELECT key, value FROM meta WHERE key IN (?, ?)')
      .bind(lastGoodKey('price'), lastGoodKey('fx'))
      .all<{ key: string; value: string }>()
    const out: Parts = {}
    for (const r of results ?? []) {
      if (r.key === lastGoodKey('price')) out.price = parsePart('price', r.value) as PricePart | undefined
      if (r.key === lastGoodKey('fx')) out.fx = parsePart('fx', r.value) as FxPart | undefined
    }
    return out
  } catch {
    // without D1 the in-memory copies still serve
    return {}
  }
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

async function keepLastGood(db: D1Database | null | undefined, parts: Parts) {
  const stmts = (['price', 'fx'] as const).flatMap((k) => (parts[k] ? [lastGoodStatement(k, parts[k]!)] : []))
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
async function resolvePart(k: Kind, now: number, lastGood: () => Promise<Parts>, fetched: Parts): Promise<{ part: PricePart | FxPart; stale: boolean } | null> {
  const hit = await cachedPart(k, CURRENT_MS, now)
  if (hit) return { part: hit, stale: false }
  const stored = (await lastGood())[k]
  if (stored && now - stored.asOf < CURRENT_MS && now >= stored.asOf) {
    // stored under its own time, so it stops being current when the copy does
    await cachePut(memoKey(k), JSON.stringify(stored), LAST_GOOD_MS, stored.asOf)
    return { part: stored, stale: false }
  }
  if (!(await cacheGet(failKey(k), RETRY_MS, now))) {
    try {
      const part = await FETCH[k](now)
      await cachePut(memoKey(k), JSON.stringify(part), LAST_GOOD_MS, now)
      Object.assign(fetched, { [k]: part })
      return { part, stale: false }
    } catch (e) {
      console.warn(`rates: ${k} unavailable`, msg(e))
      await cachePut(failKey(k), '1', RETRY_MS, now)
    }
  }
  const older = [stored, await cachedPart(k, LAST_GOOD_MS, now)]
    .filter((p): p is PricePart | FxPart => !!p && now - p.asOf < LAST_GOOD_MS)
    .sort((a, b) => b.asOf - a.asOf)[0]
  return older ? { part: older, stale: true } : null
}

export const rates = new Hono<{ Bindings: Env }>()

// NIM in USD (CoinGecko, else CoinPaprika) and USD in EUR/CRC/GMD (open.er-api.com). The cron keeps
// the last good copy of each in D1, so a request rarely asks upstream. When the sources fail, the
// last good copy (at most a day old) is served with its own asOf and `stale: true`. A rate no source
// gave is left out, never filled in: the app then shows USD. Without any NIM price there is nothing
// to answer.
rates.get('/', async (c) => {
  const now = Date.now()
  let read: Promise<Parts> | null = null
  const lastGood = () => (read ??= readLastGood(c.env?.DB))
  const fetched: Parts = {}
  const [price, fx] = await Promise.all([resolvePart('price', now, lastGood, fetched), resolvePart('fx', now, lastGood, fetched)])
  await keepLastGood(c.env?.DB, fetched)
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
    nimUsd: p.nimUsd,
    ...(p.usdtUsd !== undefined ? { usdtUsd: p.usdtUsd } : {}),
    fx: { USD: 1, ...(f?.fx ?? {}) },
    source: f ? [p.source, f.source] : [p.source],
    ...(stale ? { stale: true } : {}),
  })
})

/**
 * Cron step: refreshes whichever part of D1's last good copy is older than REWARM_MS, so requests
 * read current rates from D1 instead of asking the sources. Two D1 calls and up to four fetches;
 * never throws. Per part: the source that answered, 'kept' (still current) or 'failed'.
 */
export async function warmRates(env: Pick<Env, 'DB'>, now = Date.now()): Promise<Record<Kind, string>> {
  const stored = await readLastGood(env.DB)
  const fetched: Parts = {}
  const out: Record<Kind, string> = { price: 'kept', fx: 'kept' }
  await Promise.all(
    (['price', 'fx'] as const).map(async (k) => {
      const have = stored[k]
      if (have && now - have.asOf < REWARM_MS && now >= have.asOf) return
      try {
        const part = await FETCH[k](now)
        Object.assign(fetched, { [k]: part })
        out[k] = part.source
      } catch (e) {
        console.warn(`rates: ${k} unavailable`, msg(e))
        out[k] = 'failed'
      }
    }),
  )
  await keepLastGood(env.DB, fetched)
  return out
}
