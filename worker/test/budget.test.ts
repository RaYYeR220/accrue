import { afterEach, describe, expect, it, vi } from 'vitest'
import { dayOf } from '../src/indexer/aggregate'
import { runIndexerTick } from '../src/indexer/cron'
import { VALIDATORS_API } from '../src/indexer/pools'
import { runScheduled } from '../src/scheduled'
import { FakeChain, load } from './chain'
import { FakeD1 } from './d1'

// CPU budget of one cron run in Node: runScheduled timed end to end, minus the time the stand-ins
// spend (the in-process SQLite behind FakeD1, building the fake RPC's answers), which on Cloudflare
// is I/O. Every stand-in answers at once and timers are stubbed, so the run never waits and its wall
// clock is its CPU (plus any preemption, hence the best of several runs). process.cpuUsage would be
// the direct measure, but on Windows it moves in 15.6 ms steps. Bounds are generous: they catch a run
// that goes back to doing several jobs or pages at once, not noise.
//
// Node -> workerd: the free plan's 10 ms is workerd CPU, and Cloudflare runs each cron invocation on
// an isolate that has rarely run the indexer's code before. Measured with `wrangler tail` on Nov 8,
// 2026, a scan run that takes 2-3 ms here took 9-23 ms there, a verdict run (1-5 ms here) 8-17 ms, the
// pool sync (~3 ms here) ~16 ms: a factor of 3 to 7. So this test only guards against regressions
// (a run doing several jobs or pages again); the cron's real budget is read from the tail.

const garuda = load('garuda-2026-11-07.json')
const POOL = garuda.address
const top = Math.max(...garuda.txs.map((t) => t.blockNumber))
const MIN = 60_000

let stubMs = 0
function timed<T>(f: () => T): T {
  const a = performance.now()
  try {
    return f()
  } finally {
    stubMs += performance.now() - a
  }
}

// FakeD1 with its SQLite work counted as stand-in time (its methods do all their work synchronously)
function timedD1(db: FakeD1) {
  const wrap = (s: ReturnType<FakeD1['prepare']>): unknown => ({
    bind: (...p: unknown[]) => wrap(s.bind(...p)),
    all: () => timed(() => s.all()),
    first: () => timed(() => s.first()),
    run: () => timed(() => s.run()),
    raw: s,
  })
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: { raw: ReturnType<FakeD1['prepare']> }[]) => timed(() => db.batch(stmts.map((x) => x.raw))),
  }
}

// a day's validators list as the API sends it: 21 pools, ~1.3 MB, nearly all of it logos
function validatorsList() {
  const logo = (i: number) => `data:image/png;base64,${Buffer.alloc(45_000, i).toString('base64')}`
  return [
    { address: POOL, name: 'Garuda Pool', fee: 0.05, payoutType: 'restake', payoutSchedule: 'Every 12 hours', accentColor: '#c08e2f', logo: logo(0), isListed: true, balance: 25798184421741, stakers: 256 },
    ...Array.from({ length: 20 }, (_, i) => ({
      address: `NQ${String(10 + i).padStart(2, '0')} 0000 0000 0000 0000 0000 0000 0000 ${String(i).padStart(4, '0')}`, name: `Pool ${i}`, fee: 0.05,
      payoutType: 'none', payoutSchedule: '', accentColor: null, logo: logo(i + 1), isListed: true, balance: 1, stakers: 1,
    })),
  ]
}

function world(chain: FakeChain, validators: string) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    timed(() => {
      const url = String(input)
      if (url === VALIDATORS_API) return Promise.resolve(new Response(validators))
      if (!url.startsWith('https://rpc.test')) return Promise.resolve(new Response('', { status: 503 }))
      const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
      const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } })))
      if (method === 'getValidatorByAddress') return ok({ address: params[0], rewardAddress: params[0] })
      if (method === 'getTransactionsByAddress') return ok(chain.page(params[0] as string, params[2] as string | null, params[1] as number))
      return ok({ address: params[0], delegation: POOL, balance: 1 })
    }),
  )
}

/** Garuda indexed up to eleven hours ago, a 250-staker payout run since: a catch-up scan. */
async function scenario() {
  const db = new FakeD1()
  const chain = new FakeChain(POOL, garuda.txs, top - 40_000)
  const validators = JSON.stringify(validatorsList())
  vi.stubGlobal('fetch', world(chain, validators))
  let t = Date.UTC(2026, 10, 7, 12)
  const env = { DB: timedD1(db) as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never }
  for (let i = 0; i < 40 && db.query<{ d: number }>('SELECT backfill_done d FROM pool_cursor')[0]?.d !== 1; i++) {
    t += 5 * MIN
    await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
  }
  chain.head = top
  t += 95 * MIN
  const keep = (k: string, v: string) => db.db.prepare('INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, t)
  return {
    db,
    run: async (job: 'scan' | 'sync' | 'verdict') => {
      // scans run on even minutes, verdicts on odd ones
      if (Math.floor(t / MIN) % 2 !== (job === 'verdict' ? 1 : 0)) t += MIN
      keep('pools_synced_at', '21')
      keep('pruned_day', String(dayOf(t)))
      keep('rates_tried_at', '')
      // a day's first sync also writes the logos
      if (job === 'sync') db.db.prepare("UPDATE meta SET updated_at = ? WHERE key = 'pools_synced_at'").run(t - 2 * 60 * MIN - 86_400_000)
      stubMs = 0
      const a = performance.now()
      const r = await runScheduled(env, { now: () => t, sleep: async () => {} })
      return { r, ms: performance.now() - a - stubMs }
    },
  }
}

const BOUND_MS = 6

describe('CPU of one cron run (Node)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it(`a scan run with a 250-staker payout run waiting stays under ${BOUND_MS} ms`, async () => {
    const runs: number[] = []
    for (let i = 0; i < 5; i++) {
      const s = await scenario()
      const { r, ms } = await s.run('scan')
      expect(r.job).toBe('scan')
      expect(r.tick!.txs).toBeGreaterThan(200)
      expect(r.verdicts).toBeNull()
      runs.push(ms)
    }
    console.log('scan run CPU ms (first, then repeats):', runs.map((m) => m.toFixed(2)).join(' '))
    expect(Math.min(...runs)).toBeLessThan(BOUND_MS)
  })

  it(`a verdict run over ~2,000 staker-day rows stays under ${BOUND_MS} ms`, async () => {
    const runs: number[] = []
    for (let i = 0; i < 5; i++) {
      const s = await scenario()
      const { r, ms } = await s.run('verdict')
      expect(r.job).toBe('verdict')
      expect(r.verdicts!.computed).toBe(1)
      expect(r.tick).toBeNull()
      runs.push(ms)
    }
    console.log('verdict run CPU ms (first, then repeats):', runs.map((m) => m.toFixed(2)).join(' '))
    expect(Math.min(...runs)).toBeLessThan(BOUND_MS)
  })

  it(`the hourly sync run, with the day's 1.3 MB of logos, stays under ${BOUND_MS} ms`, async () => {
    const runs: number[] = []
    for (let i = 0; i < 5; i++) {
      const s = await scenario()
      const { r, ms } = await s.run('sync')
      expect(r.job).toBe('sync')
      expect(r.tick!.synced).toBe(true)
      expect(r.tick!.txs).toBe(0)
      runs.push(ms)
    }
    console.log('sync run CPU ms (first, then repeats):', runs.map((m) => m.toFixed(2)).join(' '))
    expect(Math.min(...runs)).toBeLessThan(BOUND_MS)
  })
})
