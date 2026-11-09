import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COINBASE_ADDRESS, addressFromBytesHex, normalizeAddress, poolVerdict, userExpected, type NimTx } from '@accrue/shared'
import { app } from '../src/app'
import worker from '../src/index'
import { DAY_MS, HOUR_MS, hourFromDb, poolWindowsFromAggregates, userWindowFromAggregates, type PoolHourDb } from '../src/indexer/aggregate'
import { scheduleMsOf } from '../src/indexer/pools'
import { refreshVerdicts, VERDICTS_KEY } from '../src/indexer/verdicts'
import { clearMemoryCache } from '../src/api/cache'
import { poolView } from '../src/api/pools'
import { load } from './chain'
import { FakeD1 } from './d1'
import { GARUDA, POOLS, SIAM, seedHistory, seedPools, tile } from './seed'

vi.mock('cloudflare:workers', async () => (await import('./helpers')).fakeDurableObjectModule())

const garuda = load('garuda-2026-11-07.json')
const siam = load('siam-2026-11-07.json')
const STAKER = 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST'
const WEEK = 7 * DAY_MS
const siamOracle = (_: string, leg: 'restake' | 'direct') => leg === 'restake'
const siamWeek = tile(siam.txs, 14)

const isRestakeTo = (t: NimTx, who: string) =>
  t.from === SIAM && t.toType === 3 && t.recipientData.startsWith('06') && addressFromBytesHex(t.recipientData.slice(2)) === who

function counted(db: FakeD1) {
  const n = { prepare: 0, batch: 0 }
  const wrapped = {
    prepare: (sql: string) => {
      n.prepare++
      return db.prepare(sql)
    },
    batch: (s: never[]) => {
      n.batch++
      return db.batch(s)
    },
  }
  return { db: wrapped, n }
}

const env = (DB: unknown, over: Record<string, unknown> = {}) =>
  ({ DB, NIM_RPCS: 'https://nim.test', POLYGON_RPCS: 'https://polygon.test', RELAYER_ADDRESS: '', RELAYER: null, ...over }) as never

async function getJson(path: string, e: never) {
  const res = await app.request(path, {}, e)
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> }
}

async function storedWindows(db: FakeD1, pool: string, fee: number, schedule: string) {
  const c = db.query<{ reach_ts: number }>('SELECT reach_ts FROM pool_cursor WHERE pool = ?', pool)[0]!
  const hours = db.query<PoolHourDb>('SELECT * FROM pool_hour WHERE pool = ?', pool).map(hourFromDb)
  const days = db
    .query<{ staker: string; day: number; payouts: number; received: number }>('SELECT staker, day, payouts, received FROM staker_day WHERE pool = ?', pool)
    .map((d) => ({ ...d, received: BigInt(d.received) }))
  const scheduleMs = scheduleMsOf(schedule)
  const range = { fromTs: c.reach_ts - WEEK, toTs: c.reach_ts, scheduleMs, hole: null }
  const ws = poolWindowsFromAggregates(hours, days, range)
  return { ...ws, hours, days, range, reach: c.reach_ts, verdict: poolVerdict(ws.window, { fee, payoutType: 'restake', scheduleMs }, c.reach_ts, { earlier: ws.earlier }) }
}

describe('verdict cache and GET /api/pools', () => {
  afterEach(() => vi.useRealTimers())
  let db: FakeD1
  const now = Date.UTC(2026, 10, 15, 6)

  beforeEach(async () => {
    db = new FakeD1()
    seedPools(db, now, {
      [GARUDA]: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
      [SIAM]: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`,
    })
    await seedHistory(db, GARUDA, garuda.txs)
    await seedHistory(db, SIAM, siamWeek, { oracle: siamOracle })
  })

  it('refreshVerdicts computes what poolVerdict says about the stored rows, a few data pools per run', async () => {
    const first = await refreshVerdicts(env(db), { now, maxPools: 1 })
    expect(first.computed).toHaveLength(1)
    const second = await refreshVerdicts(env(db), { now, maxPools: 1 })
    expect(second.computed).toHaveLength(1)
    expect(new Set([...first.computed, ...second.computed])).toEqual(new Set([GARUDA, SIAM]))
    // nothing changed since: nothing to do
    expect((await refreshVerdicts(env(db), { now: now + 60_000, maxPools: 5 })).computed).toEqual([])

    const cache = JSON.parse(db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', VERDICTS_KEY)[0]!.value)
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    expect(cache.pools[GARUDA]).toMatchObject({
      verdict: g.verdict.verdict, ratio: g.verdict.ratio, expectedRatio: 0.95, reasons: g.verdict.reasons,
      lastPayoutTs: g.window.lastPayoutTs, cycleMs: g.cycleMs, reachTs: g.reach,
    })
    const s = await storedWindows(db, SIAM, 0.03, 'Every 3 hours')
    expect(s.verdict.verdict).toBe('PAID_AS_PROMISED')
    expect(cache.pools[SIAM].verdict).toBe('PAID_AS_PROMISED')
  })

  it('answers 21 pools from the cache with one D1 round trip, sorted by stake, no logo bytes inline', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(g.reach + HOUR_MS)
    const c = counted(db)
    const { status, headers, body } = await getJson('/api/pools', env(c.db))
    expect(status).toBe(200)
    expect(c.n.batch).toBe(1)
    expect(c.n.prepare).toBe(2)
    expect(headers.get('cache-control')).toMatch(/max-age=60/)
    expect(body.windowDays).toBe(7)
    expect(typeof body.asOf).toBe('number')
    expect(body.pools).toHaveLength(21)
    expect(JSON.stringify(body)).not.toContain('data:')
    const balances = body.pools.map((p: any) => BigInt(p.balanceLuna))
    expect([...balances].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(balances)

    const garudaRow = body.pools.find((p: any) => p.address === GARUDA)
    expect(garudaRow).toEqual({
      address: GARUDA, name: 'Garuda Pool', fee: 0.05, payoutType: 'restake', schedule: 'Every 12 hours',
      balanceLuna: '25798184421741', stakers: 256, accent: '#c08e2f', logo: '/api/pools/NQ15HNAHYRVHDFVMYHAGBSXG0QHKKA0QXDR7/logo',
      verdict: g.verdict.verdict, ratio: g.verdict.ratio, expectedRatio: 0.95, lastPayoutTs: g.window.lastPayoutTs, reasons: g.verdict.reasons,
      reachTs: g.reach, state: 'checked',
    })
    const by = (name: string) => body.pools.find((p: any) => p.name === name)
    // no payouts by design needs no data; a pool without a published fee has no promise to hold
    expect(by('Nimiq Surf')).toMatchObject({ verdict: 'NO_PAYOUTS_BY_DESIGN', ratio: null, expectedRatio: 1, logo: null })
    expect(by('Private Whalidator')).toMatchObject({ verdict: 'NO_PAYOUTS_BY_DESIGN', fee: null, expectedRatio: null })
    // listed and paying but not indexed yet: no verdict, never a guessed one
    expect(by('Mint Pool')).toMatchObject({ verdict: null, ratio: null, lastPayoutTs: null, expectedRatio: 0.95 })
    expect(by('Mint Pool').reasons.join(' ')).toMatch(/not been indexed/)
    expect(by('Mint Pool').state).toBe('not_indexed')
    expect(by('Nimiq Surf').state).toBe('checked')
    for (const p of body.pools) {
      expect(p.reasons.every((r: unknown) => typeof r === 'string')).toBe(true)
      expect(p.accent === null || /^#[0-9a-fA-F]{6}$/.test(p.accent)).toBe(true)
    }
  })

  it('says in `state` why a pool has no verdict: not looked at yet, no fee, not indexed, or checked', () => {
    const row = { address: 'NQ00 TEST', name: 'T', fee: 0.05, payout_type: 'restake', schedule: 'Every 12 hours', reward_address: 'NQ11 REWARD', listed: 1, balance: 1, stakers: 1, accent: null, has_logo: 0, updated_at: 1 } as never
    // a pool the cron has not reached: no cache entry at all
    expect(poolView(row, null, now)).toMatchObject({ verdict: null, state: 'unchecked' })
    // no published fee: nothing to check against
    expect(poolView({ ...(row as object), fee: null } as never, null, now)).toMatchObject({ verdict: null, state: 'no_fee' })
    // listed and paying, but nothing indexed
    const cursorless = poolView({ ...(row as object), reward_address: null } as never, null, now)
    expect(cursorless.state).toBe('unchecked')
    // a pool that pays nothing by design has its (quick) verdict
    expect(poolView({ ...(row as object), payout_type: 'none' } as never, null, now)).toMatchObject({ verdict: 'NO_PAYOUTS_BY_DESIGN', state: 'checked' })
  })

  it('a pool still catching up on a hole says so', async () => {
    db.db.prepare("UPDATE pool_cursor SET resume_hash = 'r', hole_from_ts = reach_ts - 3600000, hole_to_ts = reach_ts - 1800000 WHERE pool = ?").run(GARUDA)
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    const { body } = await getJson('/api/pools', env(db))
    expect(body.pools.find((p: any) => p.address === GARUDA).reasons.join(' ')).toMatch(/catching up/)
  })

  it('a pool whose data stopped well behind the clock keeps its verdict and says how old the data is', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    vi.useFakeTimers({ toFake: ['Date'] })
    const row = async (pool: string) => (await getJson('/api/pools', env(db))).body.pools.find((p: any) => p.address === pool)
    const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
    // Garuda publishes "Every 12 hours": behind once its data is more than 2 x 12 h old
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    vi.setSystemTime(g.reach + 23 * HOUR_MS)
    expect((await row(GARUDA)).reasons.join(' ')).not.toMatch(/indexing is behind/)
    vi.setSystemTime(g.reach + 25 * HOUR_MS)
    const late = await row(GARUDA)
    expect(late.verdict).toBe(g.verdict.verdict)
    expect(late.reachTs).toBe(g.reach)
    expect(late.reasons).toEqual([...g.verdict.reasons, `Data as of ${iso(g.reach)}; indexing is behind`])
    // Siam publishes "Every 3 hours": the 3 h floor does not apply, 2 x 3 h = 6 h does
    const s = await storedWindows(db, SIAM, 0.03, 'Every 3 hours')
    vi.setSystemTime(s.reach + 5 * HOUR_MS)
    expect((await row(SIAM)).reasons.join(' ')).not.toMatch(/indexing is behind/)
    vi.setSystemTime(s.reach + 7 * HOUR_MS)
    expect((await row(SIAM)).reasons).toContain(`Data as of ${iso(s.reach)}; indexing is behind`)
    // a pool that pays nothing by design has no data to be behind on
    expect((await row('NQ51 SURF MCTM AQXM 15PA K9FX 8EEX 29BE VGH8')).reasons.join(' ')).not.toMatch(/indexing is behind/)
  })

  it('never lists the same reason twice, whatever the cache holds', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    const raw = JSON.parse(db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', VERDICTS_KEY)[0]!.value)
    raw.pools[GARUDA].reasons = ['Paid 95.0% of earnings against 95.0% promised.', 'paid 95.0% of earnings against 95.0% promised', 'Another fact.']
    db.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(raw), VERDICTS_KEY)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(g.reach + HOUR_MS)
    clearMemoryCache()
    const p = (await getJson('/api/pools', env(db))).body.pools.find((x: any) => x.address === GARUDA)
    expect(p.reasons).toEqual(['Paid 95.0% of earnings against 95.0% promised.', 'Another fact.'])
  })

  it('verdicts cached by the previous verdict logic stay on show until the cron recomputes them, first in line', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    // the cache as the deployed logic (version 1) wrote it: same pool inputs, the old wording
    const raw = JSON.parse(db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', VERDICTS_KEY)[0]!.value)
    for (const e of Object.values(raw.pools) as { meta: string }[]) e.meta = JSON.stringify([1, ...JSON.parse(e.meta).slice(1)])
    const OLD = 'Only 2 complete payout cycle(s) with 462997721 luna earned in the window; need at least 3.'
    raw.pools[GARUDA].reasons = [OLD]
    db.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(raw), VERDICTS_KEY)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(g.reach + HOUR_MS)
    const garudaRow = async () => {
      clearMemoryCache()
      return (await getJson('/api/pools', env(db))).body.pools.find((p: any) => p.address === GARUDA)
    }
    expect(await garudaRow()).toMatchObject({ state: 'checked', verdict: g.verdict.verdict, reasons: [OLD] })

    // a deploy with new verdict logic recomputes every cached verdict, ahead of the data refreshes
    const r = await refreshVerdicts(env(db), { now: now + 60_000, maxPools: 1 })
    const r2 = await refreshVerdicts(env(db), { now: now + 120_000, maxPools: 1 })
    expect(new Set([...r.computed, ...r2.computed])).toEqual(new Set([GARUDA, SIAM]))
    expect(await garudaRow()).toMatchObject({ state: 'checked', verdict: g.verdict.verdict, reasons: g.verdict.reasons })
    expect((await refreshVerdicts(env(db), { now: now + 180_000, maxPools: 5 })).computed).toEqual([])
  })

  it('a pool whose fee changed has no verdict until it is recomputed', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    db.db.prepare('UPDATE pools SET fee = 0.5 WHERE address = ?').run(GARUDA)
    expect((await getJson('/api/pools', env(db))).body.pools.find((p: any) => p.address === GARUDA)).toMatchObject({ verdict: null, state: 'unchecked' })
  })

  it('a verdict is recomputed when the pool changes its fee, not on every run', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    db.db.prepare('UPDATE pools SET fee = 0.5 WHERE address = ?').run(GARUDA)
    const r = await refreshVerdicts(env(db), { now: now + 60_000, maxPools: 5 })
    expect(r.computed).toEqual([GARUDA])
    const { body } = await getJson('/api/pools', env(db))
    expect(body.pools.find((p: any) => p.address === GARUDA).expectedRatio).toBe(0.5)
  })

  it('keeps nine days of hourly and daily rows behind each pool once a day, never what a window can still read', async () => {
    const old = Math.floor((Date.UTC(2026, 9, 1)) / HOUR_MS)
    db.db.prepare('INSERT INTO pool_hour (pool, hour, earned) VALUES (?, ?, 5)').run(GARUDA, old)
    db.db.prepare('INSERT INTO staker_day (pool, staker, day, received, payouts) VALUES (?, ?, ?, 5, 1)').run(GARUDA, STAKER, Math.floor(old / 24))
    const before = db.query<{ n: number }>('SELECT COUNT(*) n FROM pool_hour')[0]!.n
    const r = await refreshVerdicts(env(db), { now, maxPools: 5 })
    expect(r.pruned).toBe(true)
    expect(db.query<{ n: number }>('SELECT COUNT(*) n FROM pool_hour')[0]!.n).toBe(before - 1)
    expect(db.query('SELECT * FROM staker_day WHERE staker = ? AND pool = ?', STAKER, GARUDA)).toEqual([])
    expect((await refreshVerdicts(env(db), { now: now + 60_000, maxPools: 5 })).pruned).toBe(false)
    // the same verdict after pruning
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    expect(g.verdict.verdict).toBe(JSON.parse(db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', VERDICTS_KEY)[0]!.value).pools[GARUDA].verdict)
  })

  it('before any refresh every pool is listed without a verdict', async () => {
    const { status, body } = await getJson('/api/pools', env(db))
    expect(status).toBe(200)
    expect(body.pools).toHaveLength(21)
    expect(body.pools.every((p: any) => p.verdict === null || p.verdict === 'NO_PAYOUTS_BY_DESIGN')).toBe(true)
  })

  it('scheduled() refreshes the cached verdicts after its indexer tick, even when the tick could not reach the RPC', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const waits: Promise<unknown>[] = []
    await worker.scheduled({} as never, env(db), { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never)
    await Promise.all(waits)
    vi.unstubAllGlobals()
    expect(db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'indexer_last_error'")[0]!.value).not.toBe('')
    const { body } = await getJson('/api/pools', env(db))
    const g = await storedWindows(db, GARUDA, 0.05, 'Every 12 hours')
    expect(body.pools.find((p: any) => p.address === GARUDA).verdict).toBe(g.verdict.verdict)
  })
})

describe('GET /api/pools/:address/logo', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script><rect width="1" height="1"/></svg>'
  const db = new FakeD1()
  const logos: Record<string, string> = {
    [POOLS[0]![0]]: `data:image/png;base64,${PNG}`,
    [POOLS[1]![0]]: `data:image/svg+xml;base64,${btoa(SVG)}`,
    [POOLS[2]![0]]: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
    [POOLS[3]![0]]: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=',
    [POOLS[4]![0]]: `data:text/html;base64,${btoa('<script>alert(1)</script>')}`,
    [POOLS[5]![0]]: `data:image/png;base64,${btoa('<html>not a png</html>')}`,
    [POOLS[6]![0]]: 'https://example.com/logo.png',
    [POOLS[7]![0]]: `data:image/gif;base64,R0lGODlhAQABAAAAACw=`,
  }
  beforeAll(() => seedPools(db, Date.UTC(2026, 10, 8), logos))
  const logo = (a: string) => app.request(`/api/pools/${encodeURIComponent(a)}/logo`, {}, env(db))

  it('serves a stored PNG with its own type, nosniff and a day of cache', async () => {
    const res = await logo(normalizeAddress(POOLS[0]![0]))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=86400/)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)))
  })

  it('serves an SVG under a CSP that lets no script run, for both address forms', async () => {
    for (const a of [POOLS[1]![0], normalizeAddress(POOLS[1]![0])]) {
      const res = await logo(a)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/svg+xml')
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; sandbox")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe(SVG)
    }
  })

  it('serves WebP and JPEG logos (3 live pools use them); refuses other types, mislabelled bytes and links', async () => {
    expect((await logo(POOLS[2]![0])).headers.get('content-type')).toBe('image/webp')
    expect((await logo(POOLS[3]![0])).headers.get('content-type')).toBe('image/jpeg')
    for (const i of [4, 5, 6, 7, 8]) {
      const res = await logo(POOLS[i]![0])
      expect(res.status, POOLS[i]![1]).toBe(404)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
    }
    expect((await logo('NQ00 0000 0000 0000 0000 0000 0000 0000 0000')).status).toBe(400)
    expect((await logo('nope')).status).toBe(400)
  })

  it('checks an SVG in linear time: comments before a tag that is not <svg> are refused at once', async () => {
    const svgDb = new FakeD1()
    const prolog = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- made by hand -->',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<!-- b --><svg xmlns="http://www.w3.org/2000/svg"/>',
    ].join(String.fromCharCode(10))
    const inputs = ['<!---->'.repeat(26) + 'X', '<!---->'.repeat(585) + 'X', '<!-- never closed <svg>', prolog]
    seedPools(svgDb, Date.UTC(2026, 10, 8), Object.fromEntries(inputs.map((x, i) => [POOLS[i]![0], `data:image/svg+xml;base64,${btoa(x)}`])))
    for (const [i, want] of [[0, 404], [1, 404], [2, 404], [3, 200]] as const) {
      const t = performance.now()
      const res = await app.request(`/api/pools/${normalizeAddress(POOLS[i]![0])}/logo`, {}, env(svgDb))
      // the old pattern backtracked exponentially: 22 empty comments took ~30 ms, each one more doubled it
      expect(performance.now() - t, `input ${i}`).toBeLessThan(50)
      expect(res.status, `input ${i}`).toBe(want)
    }
  })
})

describe('userWindowFromAggregates (a staker\'s week, on whole days)', () => {
  it('received is exactly the staker\'s payouts between two midnights; earned matches the raw coinbase between the settle points', async () => {
    const db = new FakeD1()
    const { reachTs } = await seedHistory(db, SIAM, siamWeek, { oracle: siamOracle })
    const s = await storedWindows(db, SIAM, 0.03, 'Every 3 hours')
    const userDays = db
      .query<{ day: number; payouts: number; received: number }>('SELECT day, payouts, received FROM staker_day WHERE pool = ? AND staker = ?', SIAM, STAKER)
      .map((d) => ({ ...d, received: BigInt(d.received) }))
    const u = userWindowFromAggregates(s.hours, userDays, { ...s.range, cycleMs: s.cycleMs })!
    expect(u).not.toBeNull()
    expect(u.fromTs % DAY_MS).toBe(0)
    expect(u.toTs % DAY_MS).toBe(0)
    expect(u.toTs - u.fromTs).toBeGreaterThanOrEqual(5 * DAY_MS)
    expect(u.toTs).toBeLessThanOrEqual(reachTs)
    const sum = (xs: NimTx[]) => xs.reduce((a, t) => a + BigInt(t.value), 0n)
    const mine = siamWeek.filter((t) => isRestakeTo(t, STAKER) && t.timestamp >= u.fromTs && t.timestamp < u.toTs)
    expect(u.received).toBe(sum(mine))
    expect(u.payouts).toBe(mine.length)
    expect(u.payouts).toBeGreaterThanOrEqual(3)
    // no payout between a settle point and its midnight
    expect(siamWeek.some((t) => t.from === SIAM && t.timestamp > u.startTs && t.timestamp < u.fromTs)).toBe(false)
    expect(siamWeek.some((t) => t.from === SIAM && t.timestamp > u.endTs && t.timestamp < u.toTs)).toBe(false)
    const coinbase = sum(siamWeek.filter((t) => t.from === COINBASE_ADDRESS && t.timestamp > u.startTs && t.timestamp <= u.endTs))
    // edge hours are pro-rated by time; one coinbase tx per batch keeps that within a few batches
    expect(Number(u.earned - coinbase) / Number(coinbase)).toBeLessThan(0.002)
    expect(Number(u.earned - coinbase) / Number(coinbase)).toBeGreaterThan(-0.002)
    // the pool paid its usual share over exactly that span
    expect(Number(u.paid) / Number(u.earned)).toBeCloseTo(Number(s.window.paidRestake) / Number(s.window.earned), 2)
  })

  it('never ends a staker window at a midnight a payout run is still crossing', async () => {
    // a 12 h pool whose 03:00 run takes 30 min, then a run that starts at 23:50 and ends at 00:40
    const POOL = SIAM
    const STK = '060000000000000000000000000000000000000001'
    const t0 = Date.UTC(2026, 10, 1)
    const txs: NimTx[] = []
    let n = 0
    const tx = (ts: number, from: string, value: number, payout: boolean): NimTx => ({
      hash: `h${n++}`, blockNumber: ts / 1000, timestamp: ts, from, to: payout ? 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001' : POOL,
      fromType: 0, toType: payout ? 3 : 0, value, fee: 0, senderData: '', recipientData: payout ? STK : '', relatedAddresses: [],
    })
    for (let ts = t0; ts < t0 + 8 * DAY_MS; ts += 60_000) txs.push(tx(ts, COINBASE_ADDRESS, 1000, false))
    for (let d = 0; d < 8; d++) {
      for (let m = 0; m < 30; m += 5) txs.push(tx(t0 + d * DAY_MS + 3 * HOUR_MS + m * 60_000, POOL, 100_000, true))
      for (let m = 0; m < 50; m += 5) txs.push(tx(t0 + d * DAY_MS + 23 * HOUR_MS + 50 * 60_000 + m * 60_000, POOL, 100_000, true))
    }
    const db = new FakeD1()
    const { reachTs } = await seedHistory(db, POOL, txs)
    const s = await storedWindows(db, POOL, 0.05, 'Every 12 hours')
    const userDays = db.query<{ day: number; payouts: number; received: number }>('SELECT day, payouts, received FROM staker_day WHERE pool = ?', POOL).map((d) => ({ ...d, received: BigInt(d.received) }))
    const u = userWindowFromAggregates(s.hours, userDays, { ...s.range, cycleMs: s.cycleMs })
    // every midnight sits inside the 23:50-00:40 run, so there is no honest staker window at all
    expect(reachTs).toBeGreaterThan(t0)
    expect(u).toBeNull()
  })
})

describe('GET /api/check/:nimAddress', () => {
  let db: FakeD1
  const stakers = new Map<string, Record<string, unknown>>()
  let rpcDown = false
  const rpcCalls: unknown[][] = []
  const now = Date.UTC(2026, 10, 15, 6)

  beforeEach(async () => {
    db = new FakeD1()
    seedPools(db, now)
    stakers.clear()
    clearMemoryCache()
    rpcDown = false
    rpcCalls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== 'https://nim.test') throw new Error(`unexpected fetch ${String(input)}`)
        if (rpcDown) return new Response('', { status: 503 })
        const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
        rpcCalls.push([method, ...params])
        const s = stakers.get(String(params[0]))
        if (method !== 'getStakerByAddress') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
        if (!s) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data: `No staker with address: ${params[0]}` } })
        return Response.json({ jsonrpc: '2.0', id: 1, result: { data: s, metadata: null } })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  /** The stake that makes the staker's share of Siam's payouts their share of its balance. */
  function fairStake(txs: NimTx[]) {
    const paid = txs.filter((t) => t.from === SIAM && t.toType === 3).reduce((a, t) => a + t.value, 0)
    const mine = txs.filter((t) => isRestakeTo(t, STAKER)).reduce((a, t) => a + t.value, 0)
    return Math.round((mine / paid) * 46639086111650)
  }
  const staker = (balance: number, delegation: string | null = SIAM) => ({
    address: STAKER, balance, delegation, inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0,
  })

  async function siamCached(txs = siamWeek) {
    await seedHistory(db, SIAM, txs, { oracle: siamOracle })
    await refreshVerdicts(env(db), { now, maxPools: 5 })
  }

  it('answers a malformed or mistyped address with 400 and never calls the RPC', async () => {
    for (const a of ['nope', 'NQ94UUV1JPTMXN2K5AH9SH6YMGUAMDHKF3SX', '0x1234', 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK']) {
      const r = await getJson(`/api/check/${encodeURIComponent(a)}`, env(db))
      expect(r.status, a).toBe(400)
      expect(r.body).toMatchObject({ error: 'INTERNAL', detail: { reason: 'bad_request', field: 'address' } })
    }
    expect(rpcCalls).toEqual([])
  })

  it('a valid address that is not a staker is 200 with staker null, not 404', async () => {
    const r = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ staker: null, windowDays: 7 })
    expect(rpcCalls).toEqual([['getStakerByAddress', STAKER]])
  })

  it('an RPC that does not answer is 503 RPC_UNAVAILABLE, never "not a staker"', async () => {
    rpcDown = true
    const r = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ error: 'RPC_UNAVAILABLE' })
  })

  it('a Siam staker gets expected and received over the same whole days, and a verdict', async () => {
    await siamCached()
    const stake = fairStake(siamWeek)
    stakers.set(STAKER, staker(stake))
    const compact = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    const spaced = await getJson(`/api/check/${encodeURIComponent(STAKER)}`, env(db))
    expect(compact.status).toBe(200)
    expect(spaced.body).toEqual(compact.body)
    const b = compact.body
    expect(b.staker).toEqual({ activeLuna: String(stake), inactiveLuna: '0', inactiveFrom: null, retiredLuna: '0', delegation: SIAM })
    expect(b.pool).toMatchObject({ address: SIAM, name: 'Siam Pool', verdict: 'PAID_AS_PROMISED', expectedRatio: 0.97 })
    expect(b.expectedLuna).toMatch(/^\d+$/)
    expect(b.receivedLuna).toMatch(/^\d+$/)

    const s = await storedWindows(db, SIAM, 0.03, 'Every 3 hours')
    const userDays = db
      .query<{ day: number; payouts: number; received: number }>('SELECT day, payouts, received FROM staker_day WHERE pool = ? AND staker = ?', SIAM, STAKER)
      .map((d) => ({ ...d, received: BigInt(d.received) }))
    const u = userWindowFromAggregates(s.hours, userDays, { ...s.range, cycleMs: s.cycleMs })!
    // the amounts cover the staker window, so its real length goes with them (the app divides by it)
    expect(b.windowDays).toBe((u.toTs - u.fromTs) / DAY_MS)
    expect(b.windowDays).toBeLessThan(7)
    expect([b.fromTs, b.toTs]).toEqual([u.fromTs, u.toTs])
    expect(b.receivedLuna).toBe(String(u.received))
    expect(b.expectedLuna).toBe(String(userExpected({ userActiveStake: BigInt(stake), poolStake: 46639086111650n, poolEarned: u.earned, fee: 0.03 })))
    expect(b.pct).toBeGreaterThan(0.98)
    expect(b.pct).toBeLessThan(1.03)
    expect(b.verdict).toBe('PAID_AS_PROMISED')
  })

  it('a staker who just doubled their stake reads low, but is never SHORT while the pool pays as promised', async () => {
    await siamCached()
    stakers.set(STAKER, staker(2 * fairStake(siamWeek)))
    const { body } = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(body.pct).toBeLessThan(0.6)
    expect(body.pool.verdict).toBe('PAID_AS_PROMISED')
    expect(body.verdict).toBe('NOT_ENOUGH_DATA')
  })

  it('in a pool the data shows SHORT, a staker paid short is SHORT too', async () => {
    const short = tile(siam.txs, 14, 45_000, 0.8)
    await siamCached(short)
    stakers.set(STAKER, staker(fairStake(short)))
    const { body } = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(body.pool.verdict).toBe('SHORT')
    expect(body.pct).toBeLessThan(0.85)
    expect(body.verdict).toBe('SHORT')
  })

  it('a staker of an unlisted validator gets the staker and no pool; one without a pool, delegation null', async () => {
    const other = 'NQ71 CT4J 8FBM 5L0S VBAP 5M9H LH7Q 3XQ0 A40S'
    stakers.set(STAKER, staker(1_000_000_000, other))
    let r = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(r.body).toEqual({ staker: { activeLuna: '1000000000', inactiveLuna: '0', inactiveFrom: null, retiredLuna: '0', delegation: other }, windowDays: 7 })
    stakers.set(STAKER, staker(5, null))
    clearMemoryCache()
    r = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(r.body.staker.delegation).toBeNull()
    expect(r.body.pool).toBeUndefined()
  })

  it('a staker of a pool that pays nothing by design is told so', async () => {
    await refreshVerdicts(env(db), { now, maxPools: 5 })
    const surf = 'NQ51 SURF MCTM AQXM 15PA K9FX 8EEX 29BE VGH8'
    stakers.set(STAKER, { ...staker(10_000_000, surf), inactiveBalance: 2_000_000, inactiveFrom: 66_300_000 })
    const { body } = await getJson(`/api/check/${normalizeAddress(STAKER)}`, env(db))
    expect(body.staker).toMatchObject({ inactiveLuna: '2000000', inactiveFrom: 66_300_000 })
    expect(body.pool).toMatchObject({ address: surf, verdict: 'NO_PAYOUTS_BY_DESIGN' })
    expect(body.verdict).toBe('NO_PAYOUTS_BY_DESIGN')
    expect(body.expectedLuna).toBeUndefined()
  })
})
