import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import type { Verdict } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { payoutTypeOf, type PayoutType } from '../indexer/pools'
import { NOT_CHECKED, VERDICTS_KEY, currentEntry, parseVerdictCache, type PoolMetaRow, type VerdictCache } from '../indexer/verdicts'
import { compactNim, parseNimAddress } from './nim'

export const WINDOW_DAYS = 7

export interface PoolDbRow extends PoolMetaRow {
  name: string
  balance: number | null
  stakers: number | null
  accent: string | null
  has_logo: number
  updated_at: number | null
}

export interface PoolView {
  address: string
  name: string
  fee: number | null
  payoutType: PayoutType
  schedule: string
  balanceLuna: string
  stakers: number
  accent: string | null
  logo: string | null
  verdict: Verdict | null
  ratio: number | null
  expectedRatio: number | null
  lastPayoutTs: number | null
  reasons: string[]
}

export const POOL_COLUMNS = 'address, name, fee, payout_type, schedule, reward_address, listed, balance, stakers, accent, logo IS NOT NULL AS has_logo, updated_at'

const ACCENT = /^#[0-9a-fA-F]{6}$/

export function poolView(r: PoolDbRow, cache: VerdictCache | null): PoolView {
  const e = currentEntry(r, cache)
  return {
    address: r.address,
    name: r.name,
    fee: r.fee,
    payoutType: payoutTypeOf(r.payout_type),
    schedule: r.schedule ?? '',
    balanceLuna: String(Math.max(0, Math.round(r.balance ?? 0))),
    stakers: r.stakers ?? 0,
    accent: r.accent && ACCENT.test(r.accent) ? r.accent : null,
    logo: r.has_logo ? `/api/pools/${compactNim(r.address)}/logo` : null,
    verdict: e?.verdict ?? null,
    ratio: e?.ratio ?? null,
    expectedRatio: e ? e.expectedRatio : r.fee === null ? null : 1 - r.fee,
    lastPayoutTs: e?.lastPayoutTs ?? null,
    reasons: e?.reasons ?? [NOT_CHECKED],
  }
}

const byStake = (a: PoolView, b: PoolView) => {
  const x = BigInt(a.balanceLuna)
  const y = BigInt(b.balanceLuna)
  return x > y ? -1 : x < y ? 1 : 0
}

export const pools = new Hono<{ Bindings: Env }>()

// Reads the pool rows and the verdicts the cron cached; nothing is computed per request.
pools.get('/', async (c) => {
  let rows: PoolDbRow[]
  let cache: VerdictCache | null
  try {
    const [poolRes, metaRes] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT ${POOL_COLUMNS} FROM pools WHERE listed = 1`),
      c.env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(VERDICTS_KEY),
    ])
    rows = (poolRes?.results ?? []) as PoolDbRow[]
    cache = parseVerdictCache((metaRes?.results?.[0] as { value?: string } | undefined)?.value)
  } catch {
    return c.json(errorBody('INTERNAL', { reason: 'db_error' }), 500)
  }
  const list = rows.map((r) => poolView(r, cache)).sort(byStake)
  const asOf = cache?.at ?? Math.max(0, ...rows.map((r) => r.updated_at ?? 0))
  c.header('cache-control', 'public, max-age=60')
  return c.json({ asOf, windowDays: WINDOW_DAYS, pools: list })
})

const LOGO_TYPES = {
  'image/png': (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/svg+xml': (b: Uint8Array) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 4096))),
} as const
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const DATA_URI = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/

const notFound = () => errorBody('INTERNAL', { reason: 'not_found' })

// A pool's logo, decoded from the data URI the validators API published. Only image types whose
// bytes match their label are served, each under its own exact type; an SVG gets a CSP that lets
// nothing run, so opened as a page it cannot script our origin.
pools.get('/:address/logo', async (c) => {
  const address = parseNimAddress(c.req.param('address'))
  if (!address) return c.json(errorBody('INTERNAL', { reason: 'bad_request', field: 'address' }), 400)
  let logo: string | null | undefined
  try {
    logo = (await c.env.DB.prepare('SELECT logo FROM pools WHERE address = ? AND listed = 1').bind(address).first<{ logo: string | null }>())?.logo
  } catch {
    return c.json(errorBody('INTERNAL', { reason: 'db_error' }), 500)
  }
  const m = logo ? DATA_URI.exec(logo) : null
  if (!m) return c.json(notFound(), 404)
  const type = m[1] as keyof typeof LOGO_TYPES
  const bytes = new Uint8Array(Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64'))
  if (!bytes.length || !LOGO_TYPES[type](bytes)) return c.json(notFound(), 404)
  return new Response(bytes, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  })
})
