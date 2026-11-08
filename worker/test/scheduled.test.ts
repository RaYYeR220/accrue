import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS } from '@accrue/shared'
import { dayOf } from '../src/indexer/aggregate'
import { runIndexerTick } from '../src/indexer/cron'
import { VALIDATORS_API } from '../src/indexer/pools'
import { PAGES_PER_RUN, TXS_PER_RUN, cronConfig, pickJob, runScheduled } from '../src/scheduled'
import { FakeChain, load } from './chain'
import { FakeD1 } from './d1'

const garuda = load('garuda-2026-11-07.json')
const POOL = garuda.address
const top = Math.max(...garuda.txs.map((t) => t.blockNumber))
const lastMacro = (head: number) => Math.floor(head / BATCH_BLOCKS) * BATCH_BLOCKS
const MIN = 60_000
const HOUR = 60 * MIN

const validators = [
  { address: POOL, name: 'Garuda Pool', fee: 0.05, payoutType: 'restake', payoutSchedule: 'Every 12 hours', accentColor: '#c08e2f', logo: 'data:x', isListed: true, balance: 25798184421741, stakers: 256 },
]

/** The public RPC, the validators API and the rate sources, as the cron sees them; records every tx page it was asked for. */
function world(chain: FakeChain, asked: number[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === VALIDATORS_API) return new Response(JSON.stringify(validators))
    if (!url.startsWith('https://rpc.test')) return new Response('', { status: 503 })
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
    const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
    if (method === 'getValidatorByAddress') return ok({ address: POOL, rewardAddress: POOL })
    if (method === 'getTransactionsByAddress') {
      asked.push(params[1] as number)
      return ok(chain.page(params[0] as string, params[2] as string | null, params[1] as number))
    }
    if (method === 'getStakerByAddress') return ok({ address: params[0], delegation: POOL, balance: 1 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown method' } }))
  })
}

describe('pickJob', () => {
  const now = Date.UTC(2026, 10, 8, 12, 5)
  const today = String(dayOf(now))
  it('one job per run: the hourly pool sync, the daily prune, the rates every five minutes, then verdicts and scans by turns', () => {
    expect(pickJob({ syncedAt: null, prunedDay: null, ratesTriedAt: null }, now)).toBe('sync')
    expect(pickJob({ syncedAt: now - HOUR, prunedDay: today, ratesTriedAt: now }, now)).toBe('sync')
    expect(pickJob({ syncedAt: now - HOUR + 1, prunedDay: null, ratesTriedAt: null }, now)).toBe('prune')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: String(dayOf(now) - 1), ratesTriedAt: now }, now)).toBe('prune')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: today, ratesTriedAt: null }, now)).toBe('rates')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: today, ratesTriedAt: now - 5 * MIN }, now)).toBe('rates')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: today, ratesTriedAt: now - 3 * MIN }, now)).toBe('verdict')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: today, ratesTriedAt: now - 3 * MIN }, now + MIN)).toBe('scan')
  })

  it('a sync or a prune tried in the last ten minutes yields to the other jobs', () => {
    const failing = { syncedAt: now - 2 * HOUR, prunedDay: null, ratesTriedAt: now - 3 * MIN, syncTriedAt: now - 2 * MIN, pruneTriedAt: now - 9 * MIN }
    expect(pickJob(failing, now)).toBe('verdict')
    expect(pickJob({ ...failing, syncTriedAt: now - 10 * MIN }, now)).toBe('sync')
    expect(pickJob({ ...failing, pruneTriedAt: now - 10 * MIN }, now)).toBe('prune')
    expect(pickJob({ ...failing, ratesTriedAt: now - 5 * MIN }, now)).toBe('rates')
  })

  it('with a slower cadence configured, verdicts and scans still take turns', () => {
    const done = { syncedAt: now - 5 * MIN, prunedDay: today }
    const every5 = { ...cronConfig({}), everyMs: 5 * MIN }
    const jobs = [0, 5, 10, 15].map((m) => Date.UTC(2026, 10, 8, 12, m)).map((at) => pickJob({ ...done, ratesTriedAt: at - MIN }, at, every5))
    expect(jobs.sort()).toEqual(['scan', 'scan', 'verdict', 'verdict'])
  })
})

describe('cronConfig', () => {
  it('reads the cadence and the job sizes from the vars, with the per-minute defaults', () => {
    expect(cronConfig({})).toEqual({ everyMs: MIN, oneJobPerRun: true, txsPerRun: 250, pagesPerRun: 3, verdictsPerRun: 1, ratesEveryMs: 5 * MIN })
    expect(
      cronConfig({ CRON_EVERY_MIN: '5', CRON_ONE_JOB_PER_RUN: 'false', CRON_TXS_PER_RUN: '1500', CRON_PAGES_PER_RUN: '4', CRON_VERDICTS_PER_RUN: '3', CRON_RATES_EVERY_MIN: '10' }),
    ).toEqual({ everyMs: 5 * MIN, oneJobPerRun: false, txsPerRun: 1500, pagesPerRun: 4, verdictsPerRun: 3, ratesEveryMs: 10 * MIN })
    // nonsense falls back to the defaults
    expect(cronConfig({ CRON_TXS_PER_RUN: '-3', CRON_EVERY_MIN: 'x' })).toMatchObject({ txsPerRun: 250, everyMs: MIN })
  })
})

describe('runScheduled', () => {
  let db: FakeD1
  let chain: FakeChain
  let asked: number[]
  let t = Date.UTC(2026, 10, 7, 12)
  const env = () => ({ DB: db as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never })
  const cursor = () => db.query<Record<string, number | string | null>>('SELECT * FROM pool_cursor WHERE pool = ?', POOL)[0]
  const run = (advanceMs = 5 * MIN) => {
    t += advanceMs
    return runScheduled(env(), { now: () => t, sleep: async () => {} })
  }
  // backfilled up to `head` with the indexer's own ticks
  async function indexedUpTo(head: number) {
    chain.head = head
    for (let i = 0; i < 40 && cursor()?.backfill_done !== 1; i++) {
      t += 5 * MIN
      await runIndexerTick(env(), { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
    }
    expect(cursor()!.backfill_done).toBe(1)
  }
  // the hourly sync, the daily prune and the rates just ran, so the next runs verdict or scan
  const housekept = () => {
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('pools_synced_at', '1', ?)").run(t)
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('pruned_day', ?, ?)").run(String(dayOf(t)), t)
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('rates_tried_at', '', ?)").run(t)
  }
  // an even minute: a scan, not a verdict
  const evenMinute = () => {
    if (Math.floor(t / MIN) % 2) t += MIN
  }

  beforeEach(() => {
    db = new FakeD1()
    chain = new FakeChain(POOL, garuda.txs, top - 20_000)
    asked = []
    vi.stubGlobal('fetch', world(chain, asked))
  })
  afterEach(() => vi.unstubAllGlobals())

  // a pool with no new tx in sight is visited once it has gone this long unvisited (cron MAX_STALE_MS)
  const DUE = 95 * MIN

  it('the pool sync, the prune, the rates and a verdict each get a run of their own, with no tx pages', async () => {
    await indexedUpTo(top - 20_000)
    db.db.prepare("DELETE FROM meta WHERE key IN ('pools_synced_at', 'pruned_day')").run()
    chain.head = top
    asked.length = 0
    t += DUE
    evenMinute()

    const sync = await run(0)
    expect(sync.job).toBe('sync')
    expect(sync.tick?.synced).toBe(true)
    expect(asked).toEqual([])
    expect(sync.verdicts).toBeNull()

    const prune = await run(MIN)
    expect(prune.job).toBe('prune')
    expect(prune.verdicts?.pruned).toBe(true)
    expect(prune.verdicts?.computed).toBe(0)
    expect(asked).toEqual([])

    const rates = await run(MIN)
    expect(rates.job).toBe('rates')
    expect(rates.rates).not.toBeNull()
    expect(rates.tick).toBeNull()
    expect(asked).toEqual([])

    // odd minute: Garuda has no verdict yet, so this run computes it and scans nothing
    const verdict = await run(MIN)
    expect(verdict.job).toBe('verdict')
    expect(verdict.verdicts?.computed).toBe(1)
    expect(asked).toEqual([])

    const scan = await run(MIN)
    expect(scan.job).toBe('scan')
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(TXS_PER_RUN)

    // odd minute again, but no verdict is due (the data moved less than 15 minutes ago): it scans
    const next = await run(MIN)
    expect(next.job).toBe('scan')
    expect(next.verdicts?.computed).toBe(0)
  })

  it('a scan run asks for about as many txs as are waiting, never more than TXS_PER_RUN in all', async () => {
    await indexedUpTo(top - 20_000)
    const scanRun = async (advanceMs: number) => {
      t += advanceMs
      evenMinute()
      housekept()
      asked.length = 0
      const r = await runScheduled(env(), { now: () => t, sleep: async () => {} })
      expect(r.job).toBe('scan')
      return r
    }
    // one visit measures the pool's pace (coinbase only here, about one tx a minute)
    let head = top - 20_000 + 5_700
    chain.head = head
    await scanRun(DUE)
    // the next visit asks for what its pace says came since, with slack, not a full page
    head += 5_700
    chain.head = head
    await scanRun(DUE)
    expect(asked[0]).toBeLessThan(TXS_PER_RUN)
    expect(asked.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(TXS_PER_RUN)
    // what did not fit is the next scan's
    for (let i = 0; i < 2 && cursor()!.resume_hash; i++) await scanRun(2 * MIN)
    expect(cursor()!.resume_hash).toBeNull()
    expect(cursor()!.newest_block).toBe(lastMacro(head))

    // a payout run of 250 stakers lands: at most TXS_PER_RUN asked per run, and the backlog drains
    chain.head = top
    for (let i = 0; i < 8 && (cursor()!.newest_block !== lastMacro(top) || cursor()!.resume_hash); i++) {
      const r = await scanRun(DUE)
      expect(asked.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(TXS_PER_RUN)
      expect(asked.length).toBeLessThanOrEqual(PAGES_PER_RUN)
      expect(r.tick!.txs).toBeLessThanOrEqual(TXS_PER_RUN)
    }
    expect(cursor()!.newest_block).toBe(lastMacro(top))
    expect(cursor()!.resume_hash).toBeNull()
  })

  it('a validators API that is down does not stop the indexer: the run scans instead', async () => {
    await indexedUpTo(top - 20_000)
    housekept()
    db.db.prepare("DELETE FROM meta WHERE key = 'pools_synced_at'").run()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === VALIDATORS_API ? new Response('', { status: 502 }) : world(chain, asked)(input, init))))
    chain.head = top - 20_000 + 1_200
    t += DUE
    evenMinute()
    const r = await run(0)
    expect(r.job).toBe('scan')
    expect(r.tick!.synced).toBe(false)
    expect(cursor()!.newest_block).toBe(lastMacro(top - 20_000 + 1_200))
  })


  it('with the validators API down for 30 minutes, the prune, the rates and the verdicts still run, and it is asked once every ten minutes', async () => {
    await indexedUpTo(top - 20_000)
    db.db.prepare("DELETE FROM meta WHERE key IN ('pools_synced_at', 'pruned_day', 'rates_tried_at')").run()
    const perRun: number[] = []
    let validators = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === VALIDATORS_API) {
        validators++
        return new Response('', { status: 502 })
      }
      return world(chain, asked)(input, init)
    }))
    const jobs: string[] = []
    let verdicts = 0
    for (let i = 0; i < 30; i++) {
      const before = validators
      const r = await run(MIN)
      perRun.push(validators - before)
      jobs.push(r.job)
      verdicts += r.verdicts?.computed ?? 0
    }
    expect(Math.max(...perRun)).toBe(1)
    expect(validators).toBe(3)
    expect(jobs.filter((j) => j === 'prune')).toHaveLength(1)
    expect(jobs.filter((j) => j === 'rates').length).toBeGreaterThanOrEqual(5)
    expect(verdicts).toBeGreaterThanOrEqual(1)
    expect(db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'pruned_day'")[0]?.value).toBe(String(dayOf(t)))
  })

  it('a prune that keeps failing is retried every ten minutes, and the other jobs go on', async () => {
    await indexedUpTo(top - 20_000)
    housekept()
    db.db.prepare("DELETE FROM meta WHERE key = 'pruned_day'").run()
    const batch = db.batch.bind(db)
    let prunes = 0
    db.batch = async (stmts) => {
      if (stmts.some((x) => x.sql.startsWith('DELETE FROM staker_day'))) {
        prunes++
        throw new Error('D1 refused')
      }
      return batch(stmts)
    }
    const jobs: string[] = []
    for (let i = 0; i < 15; i++) jobs.push((await run(MIN)).job)
    expect(prunes).toBe(2)
    expect(jobs.filter((j) => j === 'rates').length).toBeGreaterThanOrEqual(2)
    expect(jobs.filter((j) => j === 'scan' || j === 'verdict').length).toBeGreaterThanOrEqual(10)
  })

  it('a scan that folds no new tx refreshes one verdict, never two', async () => {
    await indexedUpTo(top - 20_000)
    // two pools without a verdict: Garuda and a twin holding the same rows, visited just now
    const TWIN = 'NQ02 31N6 3KM5 T6G5 22TN EPF5 5XPY RLHK RMB3'
    db.db.prepare('INSERT INTO pools (address, name, reward_address, fee, payout_type, schedule, listed, updated_at, reward_checked_at) SELECT ?, ?, ?, fee, payout_type, schedule, 1, updated_at, reward_checked_at FROM pools WHERE address = ?').run(TWIN, 'Twin', TWIN, POOL)
    db.db.prepare('INSERT INTO pool_hour (pool, hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts) SELECT ?, hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts FROM pool_hour WHERE pool = ?').run(TWIN, POOL)
    db.db.prepare('INSERT INTO staker_day (pool, staker, day, received, payouts) SELECT ?, staker, day, received, payouts FROM staker_day WHERE pool = ?').run(TWIN, POOL)
    t += DUE
    db.db.prepare('INSERT INTO pool_cursor (pool, newest_hash, newest_block, oldest_block, backfill_done, last_payout_block, visited_at, txs_per_hour, reach_ts) SELECT ?, newest_hash, newest_block, oldest_block, backfill_done, last_payout_block, ?, txs_per_hour, reach_ts FROM pool_cursor WHERE pool = ?').run(TWIN, t, POOL)
    evenMinute()
    housekept()
    asked.length = 0
    const r = await run(0)
    expect(r.job).toBe('scan')
    expect(r.tick!.txs).toBeGreaterThan(0)
    expect(r.tick!.folded).toBe(0)
    expect(r.verdicts?.computed).toBe(1)
  })

  it('with one job per run switched off, a run does every due job, sized by the vars', async () => {
    await indexedUpTo(top - 20_000)
    db.db.prepare("DELETE FROM meta WHERE key IN ('pools_synced_at', 'pruned_day', 'rates_tried_at')").run()
    chain.head = top
    asked.length = 0
    t += DUE
    const r = await runScheduled({ ...env(), CRON_ONE_JOB_PER_RUN: 'false', CRON_TXS_PER_RUN: '600' } as never, { now: () => t, sleep: async () => {} })
    expect(r.jobs).toEqual(['sync', 'prune', 'rates', 'scan', 'verdict'])
    expect(asked.reduce((a, n) => a + n, 0)).toBeGreaterThan(TXS_PER_RUN)
    expect(asked.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(600)
    expect(r.verdicts?.computed).toBe(1)
  })
})
