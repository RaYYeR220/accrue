import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS } from '@accrue/shared'
import { dayOf } from '../src/indexer/aggregate'
import { runIndexerTick } from '../src/indexer/cron'
import { VALIDATORS_API } from '../src/indexer/pools'
import { PAGES_PER_RUN, TXS_PER_RUN, pickJob, runScheduled } from '../src/scheduled'
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
  it('one heavy job per run: the hourly pool sync, else the daily prune, else a scan', () => {
    expect(pickJob({ syncedAt: null, prunedDay: null }, now)).toBe('sync')
    expect(pickJob({ syncedAt: now - HOUR, prunedDay: String(dayOf(now)) }, now)).toBe('sync')
    expect(pickJob({ syncedAt: now - HOUR + 1, prunedDay: null }, now)).toBe('prune')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: String(dayOf(now) - 1) }, now)).toBe('prune')
    expect(pickJob({ syncedAt: now - 5 * MIN, prunedDay: String(dayOf(now)) }, now)).toBe('scan')
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
  // the hourly sync and the daily prune just ran, so the next runs scan
  const housekept = () => {
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('pools_synced_at', '1', ?)").run(t)
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('pruned_day', ?, ?)").run(String(dayOf(t)), t)
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

  it('the pool sync and the prune each get a run of their own, with no tx pages and no verdicts', async () => {
    await indexedUpTo(top - 20_000)
    db.db.prepare("DELETE FROM meta WHERE key IN ('pools_synced_at', 'pruned_day')").run()
    chain.head = top
    asked.length = 0

    const sync = await run(DUE)
    expect(sync.job).toBe('sync')
    expect(sync.tick?.synced).toBe(true)
    expect(asked).toEqual([])
    expect(sync.verdicts).toBeNull()

    const prune = await run()
    expect(prune.job).toBe('prune')
    expect(prune.verdicts?.pruned).toBe(true)
    expect(prune.verdicts?.computed).toBe(0)
    expect(asked).toEqual([])

    const scan = await run()
    expect(scan.job).toBe('scan')
    expect(asked.length).toBeGreaterThan(0)
    expect(scan.verdicts?.computed).toBeLessThanOrEqual(2)
  })

  it('a scan run asks for about as many txs as are waiting, never more than TXS_PER_RUN in all', async () => {
    await indexedUpTo(top - 20_000)
    const scanRun = async (advanceMs: number) => {
      t += advanceMs
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
    // the next visit asks for what its pace says came since, with slack, not a full page, and finishes
    head += 5_700
    chain.head = head
    await scanRun(DUE)
    expect(asked[0]).toBeLessThan(250)
    expect(asked.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(TXS_PER_RUN)
    expect(cursor()!.resume_hash).toBeNull()
    expect(cursor()!.newest_block).toBe(lastMacro(head))

    // a payout run of 250 stakers lands: at most TXS_PER_RUN asked per run, and the backlog drains
    chain.head = top
    for (let i = 0; i < 4 && (cursor()!.newest_block !== lastMacro(top) || cursor()!.resume_hash); i++) {
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
    const r = await run(DUE)
    expect(r.job).toBe('scan')
    expect(r.tick!.synced).toBe(false)
    expect(cursor()!.newest_block).toBe(lastMacro(top - 20_000 + 1_200))
  })

})
