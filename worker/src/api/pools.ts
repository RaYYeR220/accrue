import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { uniqueReasons, type Verdict } from '@accrue/shared'
import type { Env } from '../env'
import { errorBody } from '../relayer/errors'
import { payoutTypeOf, scheduleMsOf, type PayoutType } from '../indexer/pools'
import { NOT_CHECKED, NOT_INDEXED, NO_FEE, VERDICTS_KEY, currentEntry, parseVerdictCache, type PoolMetaRow, type VerdictCache } from '../indexer/verdicts'
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

/** Why a pool has (or has not) a verdict: the cron has not reached it, it lists no fee, nothing is indexed, or it is checked. */
export type PoolState = 'unchecked' | 'no_fee' | 'not_indexed' | 'checked'

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
  state: PoolState
  /** how far the data behind the verdict reaches (ms), null when nothing is indexed */
  reachTs: number | null
}

export const POOL_COLUMNS = 'address, name, fee, payout_type, schedule, reward_address, listed, balance, stakers, accent, logo IS NOT NULL AS has_logo, updated_at'

const ACCENT = /^#[0-9a-fA-F]{6}$/

const HOUR_MS = 3_600_000
const STALE_FLOOR_MS = 3 * HOUR_MS
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * A pool's row with its cached verdict. A verdict whose data stopped more than max(2 x the published
 * interval, 3 h) before `now` stays, with a reason saying how old its data is.
 */
export function poolView(r: PoolDbRow, cache: VerdictCache | null, now: number): PoolView {
  const e = currentEntry(r, cache)
  const reachTs = e?.reachTs ?? null
  const reasons = e?.reasons ?? [NOT_CHECKED]
  const state: PoolState = !e ? 'unchecked' : e.reasons.includes(NO_FEE) ? 'no_fee' : e.reasons.includes(NOT_INDEXED) ? 'not_indexed' : 'checked'
  const behind =
    e?.verdict != null && e.verdict !== 'NO_PAYOUTS_BY_DESIGN' && reachTs !== null &&
    now - reachTs > Math.max(2 * (scheduleMsOf(r.schedule) ?? 0), STALE_FLOOR_MS)
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
    reasons: uniqueReasons(behind ? [...reasons, `Data as of ${iso(reachTs)}; indexing is behind`] : reasons),
    state,
    reachTs,
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
  const now = Date.now()
  const list = rows.map((r) => poolView(r, cache, now)).sort(byStake)
  const asOf = cache?.at ?? Math.max(0, ...rows.map((r) => r.updated_at ?? 0))
  c.header('cache-control', 'public, max-age=60')
  return c.json({ asOf, windowDays: WINDOW_DAYS, pools: list })
})

/**
 * Whether a document starts like an SVG: optional BOM, XML declaration, comments and DOCTYPE, then
 * `<svg`. One pass with indexOf, so it stays linear on any input (a backtracking pattern over a run
 * of comments took exponential time on third-party data).
 */
export function looksLikeSvg(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++
  }
  const skipPast = (end: string) => {
    const at = text.indexOf(end, i)
    if (at < 0) return false
    i = at + end.length
    return true
  }
  skipSpace()
  if (text.startsWith('<?xml', i) && !skipPast('?>')) return false
  let doctype = false
  for (;;) {
    skipSpace()
    if (text.startsWith('<!--', i)) {
      i += 4
      if (!skipPast('-->')) return false
    } else if (!doctype && text.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      doctype = true
      if (!skipPast('>')) return false
    } else break
  }
  return /^<svg[\s>/]/i.test(text.slice(i, i + 5))
}

const LOGO_TYPES = {
  'image/png': (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/svg+xml': (b: Uint8Array) => looksLikeSvg(new TextDecoder().decode(b.subarray(0, 4096))),
} as const
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const DATA_URI = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/

// form-action does not fall back to default-src: without it a scriptless SVG opened directly could
// still post a form from our origin; sandbox drops the origin altogether
const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; sandbox"

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
      'content-security-policy': LOGO_CSP,
    },
  })
})
