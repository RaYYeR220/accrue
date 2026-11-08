import { Hono } from 'hono'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { readThrough } from './cache'

export const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,tether&vs_currencies=usd'
export const FX_URL = 'https://open.er-api.com/v6/latest/USD'
const FRESH_MS = 5 * 60_000
const STALE_MS = 60 * 60_000
const FIATS = ['EUR', 'CRC', 'GMD'] as const

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`)
  return res.json()
}

async function loadPrice(): Promise<string> {
  const b = (await getJson(PRICE_URL)) as Record<string, { usd?: unknown } | undefined>
  const nimUsd = b?.['nimiq-2']?.usd
  if (!positive(nimUsd)) throw new Error('CoinGecko: no NIM price')
  const usdt = b?.tether?.usd
  return JSON.stringify({ nimUsd, usdtUsd: positive(usdt) ? usdt : null })
}

async function loadFx(): Promise<string> {
  const b = (await getJson(FX_URL)) as { result?: unknown; rates?: Record<string, unknown> }
  if (b?.result !== 'success' || !b.rates) throw new Error('open.er-api.com: no rates')
  const fx: Partial<Record<(typeof FIATS)[number], number>> = {}
  for (const f of FIATS) if (positive(b.rates[f])) fx[f] = b.rates[f]
  if (!Object.keys(fx).length) throw new Error('open.er-api.com: none of EUR, CRC, GMD')
  return JSON.stringify(fx)
}

export const rates = new Hono<{ Bindings: Env }>()

// NIM in USD (CoinGecko) and USD in EUR/CRC/GMD (open.er-api.com), each kept 5 minutes and served
// up to an hour old when its source fails. A rate no source gave is left out, never filled in: the
// app then shows USD. Without any NIM price there is nothing to answer.
rates.get('/', async (c) => {
  const now = Date.now()
  const [price, fx] = await Promise.allSettled([
    readThrough('rates:price', { freshMs: FRESH_MS, staleMs: STALE_MS }, loadPrice, now),
    readThrough('rates:fx', { freshMs: FRESH_MS, staleMs: STALE_MS }, loadFx, now),
  ])
  if (price.status === 'rejected') return c.json(errorBody('RPC_UNAVAILABLE', { reason: 'price_unavailable' }), 503)
  const p = JSON.parse(price.value.body) as { nimUsd: number; usdtUsd: number | null }
  const f = fx.status === 'fulfilled' ? (JSON.parse(fx.value.body) as Record<string, number>) : null
  c.header('cache-control', 'public, max-age=60')
  return c.json({
    asOf: Math.min(price.value.at, f && fx.status === 'fulfilled' ? fx.value.at : price.value.at),
    nimUsd: p.nimUsd,
    ...(p.usdtUsd !== null ? { usdtUsd: p.usdtUsd } : {}),
    fx: { USD: 1, ...(f ?? {}) },
    source: f ? ['CoinGecko', 'open.er-api.com'] : ['CoinGecko'],
  })
})
