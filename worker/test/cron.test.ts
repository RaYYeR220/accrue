import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS, COINBASE_ADDRESS, addressFromBytesHex, type NimTx } from '@accrue/shared'
import { aggregate, hourFromDb, poolWindowFromAggregates, type PoolHourDb } from '../src/indexer/aggregate'
import { runIndexerTick } from '../src/indexer/cron'
import { VALIDATORS_API } from '../src/indexer/pools'
import { FakeChain, load } from './chain'
import { FakeD1 } from './d1'

const garuda = load('garuda-2026-11-07.json')
const POOL = garuda.address
const SURF = 'NQ51 SURF MCTM AQXM 15PA K9FX 8EEX 29BE VGH8'
const top = Math.max(...garuda.txs.map((t) => t.blockNumber))
const lastMacro = (head: number) => Math.floor(head / BATCH_BLOCKS) * BATCH_BLOCKS
const MIN = 60_000

const validators = [
  { address: POOL, name: 'Garuda Pool', fee: 0.05, payoutType: 'restake', payoutSchedule: 'Every 12 hours', accentColor: '#c08e2f', logo: 'data:x', isListed: true, balance: 25798184421741, stakers: 256 },
  { address: SURF, name: 'Nimiq Surf', fee: 0, payoutType: 'none', payoutSchedule: '', accentColor: null, logo: null, isListed: true, balance: 1, stakers: 6 },
]

const isRestake = (t: NimTx) => t.toType === 3 && t.recipientData.startsWith('06')
const outsider = garuda.txs.find((t) => t.from === POOL && t.toType === 0)!.to

function routes(chain: FakeChain, state: { rpcDown: boolean; fetches: number; validator: 'ok' | 'none' | 'fault' | 'moved' }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    state.fetches++
    const url = String(input)
    if (url === VALIDATORS_API) return new Response(JSON.stringify(validators))
    if (state.rpcDown) return new Response('', { status: 503 })
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
    const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
    const err = (data?: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', ...(data ? { data } : {}) } }))
    if (method === 'getValidatorByAddress') {
      if (params[0] !== POOL || state.validator === 'none') return err(`No validator with address: ${params[0]}`)
      if (state.validator === 'moved') return ok({ address: POOL, rewardAddress: SURF })
      return state.validator === 'fault' ? err() : ok({ address: POOL, rewardAddress: POOL })
    }
    if (method === 'getTransactionsByAddress') return ok(chain.page(params[0] as string, params[2] as string | null))
    if (method === 'getStakerByAddress') return params[0] === outsider ? err(`No staker with address: ${params[0]}`) : ok({ address: params[0], delegation: POOL, balance: 1 })
    return err('unknown method')
  })
}

function expectedUpTo(block: number) {
  const txs = garuda.txs.filter((t) => t.blockNumber <= block)
  const sum = (xs: NimTx[]) => xs.reduce((a, t) => a + t.value, 0)
  const out = txs.filter((t) => t.from === POOL)
  return {
    earned: sum(txs.filter((t) => t.from === COINBASE_ADDRESS)),
    out: sum(out),
    outsider: sum(out.filter((t) => t.toType === 0 && t.to === outsider)),
    restake: sum(out.filter(isRestake)),
  }
}

describe('runIndexerTick', () => {
  let db: FakeD1
  let chain: FakeChain
  const state = { rpcDown: false, fetches: 0, validator: 'ok' as 'ok' | 'none' | 'fault' | 'moved' }
  const env = () => ({ DB: db as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never })
  let t = Date.UTC(2026, 10, 7, 12)
  const tick = async (advanceMs = 5 * MIN) => {
    t += advanceMs
    const before = { f: state.fetches, d: db.calls }
    const r = await runIndexerTick(env(), { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
    return { ...r, subrequests: state.fetches - before.f + (db.calls - before.d) }
  }
  const sums = () =>
    db.query<{ earned: number; paid: number; restake: number; unverified: number; other: number }>(
      'SELECT SUM(earned) earned, SUM(paid_restake) + SUM(paid_direct) paid, SUM(paid_restake) restake, SUM(paid_unverified) unverified, SUM(other_out) other FROM pool_hour WHERE pool = ?',
      POOL,
    )[0]!
  const cursor = () => db.query<Record<string, number | string | null>>('SELECT * FROM pool_cursor WHERE pool = ?', POOL)[0]
  const meta = (k: string) => db.query<{ value: string; updated_at: number }>('SELECT value, updated_at FROM meta WHERE key = ?', k)[0]

  beforeEach(() => {
    db = new FakeD1()
    chain = new FakeChain(POOL, garuda.txs, top - 20_000)
    state.rpcDown = false
    state.validator = 'ok'
    vi.stubGlobal('fetch', routes(chain, state))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('backfills from an empty database within the per-tick budget, then follows the head', async () => {
    const first = await tick()
    expect(first.subrequests).toBeLessThanOrEqual(25)
    expect(first.pages).toBe(1)
    expect(db.query('SELECT address, reward_address, listed FROM pools ORDER BY address')).toEqual([
      { address: POOL, reward_address: POOL, listed: 1 },
      { address: SURF, reward_address: null, listed: 1 },
    ])
    expect(cursor()!.backfill_done).toBe(0)

    let n = 1
    while (cursor()!.backfill_done !== 1 && n++ < 30) {
      const r = await tick()
      expect(r.subrequests).toBeLessThanOrEqual(25)
      expect(r.pages).toBeLessThanOrEqual(3)
    }
    const e1 = expectedUpTo(lastMacro(chain.head))
    expect(sums().earned).toBe(e1.earned)
    expect(sums().paid + sums().other).toBe(e1.out)
    expect(sums().restake).toBe(e1.restake)
    expect(sums().other).toBeGreaterThanOrEqual(0)

    const received = db.query<{ s: number }>('SELECT SUM(received) s FROM staker_day WHERE pool = ?', POOL)[0]!.s
    expect(received).toBe(sums().paid)
    expect(meta('indexer_last_error')!.value).toBe('')
    expect(meta('indexer_last_ok')!.updated_at).toBe(t)

    // the chain moves on; ticks pick up the new txs, including the hole they leave behind
    chain.head = top
    const cursorBefore = cursor()!.newest_block as number
    for (let i = 0; i < 40 && (cursor()!.newest_block !== lastMacro(top) || cursor()!.resume_hash); i++) {
      const r = await tick(30 * MIN)
      expect(r.subrequests).toBeLessThanOrEqual(25)
    }
    expect(cursor()!.newest_block).toBeGreaterThan(cursorBefore)
    const e2 = expectedUpTo(lastMacro(top))
    expect(sums().earned).toBe(e2.earned)
    expect(sums().paid + sums().other).toBe(e2.out)

    // the outsider ends up cached as "not a staker"; once known, its payouts are other_out, and
    // nothing else ever is
    const cached = db.query<{ address: string }>("SELECT address FROM recipient_delegation WHERE delegation = ''")
    expect(cached).toEqual([{ address: outsider }])
    expect(sums().other).toBeGreaterThan(0)
    expect(sums().other).toBeLessThanOrEqual(e2.outsider)
    const someStaker = addressFromBytesHex(garuda.txs.find((x) => x.from === POOL && isRestake(x))!.recipientData.slice(2))
    expect(db.query('SELECT * FROM staker_day WHERE pool = ? AND staker = ?', POOL, someStaker).length).toBeGreaterThan(0)
  })

  it('stored rows rebuild the same payout window as the in-memory aggregate', async () => {
    chain.head = top
    for (let i = 0; i < 30 && cursor()?.backfill_done !== 1; i++) await tick()
    const rows = db.query<PoolHourDb>('SELECT hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts FROM pool_hour WHERE pool = ?', POOL)
    const days = db.query<{ staker: string; day: number; payouts: number; received: number }>('SELECT staker, day, payouts, received FROM staker_day WHERE pool = ?', POOL).map((d) => ({ ...d, received: BigInt(d.received) }))
    const range = { fromTs: Math.min(...garuda.txs.map((x) => x.timestamp)), toTs: t }
    const stored = poolWindowFromAggregates(rows.map(hourFromDb), days, range)
    const txs = garuda.txs.filter((x) => x.blockNumber <= lastMacro(top))
    const mem = aggregate(txs, { rewardAddress: POOL }, () => true)
    const direct = poolWindowFromAggregates(mem.hours, mem.stakerDays, range)
    expect(stored.earned).toBe(direct.earned)
    expect(stored.paidRestake + stored.paidDirect + stored.otherOut).toBe(direct.paidRestake + direct.paidDirect + direct.otherOut)
    expect(stored.cycles).toBe(direct.cycles)
    expect(stored.cycles).toBeGreaterThanOrEqual(3)
  })

  it('stores how far the data reaches', async () => {
    await tick()
    const c = cursor()!
    const page = chain.page(POOL, null)
    const head = page.reduce((m, x) => Math.max(m, x.blockNumber + (x as { confirmations?: number }).confirmations! - 1), 0)
    expect(c.newest_block).toBe(lastMacro(head))
    expect(c.reach_ts).toBe(page[0]!.timestamp + (lastMacro(head) - page[0]!.blockNumber) * 1000)
    expect(c.hole_from_ts).toBe(0)
    expect(c.hole_to_ts).not.toBeNull()
  })

  it('a single "No validator" keeps the reward address; only a second one drops it', async () => {
    for (let i = 0; i < 12 && cursor()?.backfill_done !== 1; i++) await tick()
    const pool = () => db.query<{ reward_address: string | null; reward_misses: number }>('SELECT reward_address, reward_misses FROM pools WHERE address = ?', POOL)[0]!
    state.validator = 'none'
    await tick(25 * 60 * MIN)
    expect(pool()).toEqual({ reward_address: POOL, reward_misses: 1 })
    expect(meta('indexer_last_error')!.value).toMatch(/validator not found/)
    const cursorKept = cursor()
    await tick(61 * MIN)
    expect(pool()).toEqual({ reward_address: null, reward_misses: 0 })
    expect(cursor()!.newest_block).toBe(cursorKept!.newest_block)
  })

  it('a new reward address resets the cursor to "from the head on", reach and hole included', async () => {
    for (let i = 0; i < 12 && cursor()?.backfill_done !== 1; i++) await tick()
    expect(cursor()!.reach_ts).not.toBeNull()
    state.validator = 'moved'
    await tick(25 * 60 * MIN)
    const c = cursor()!
    expect(db.query<{ reward_address: string }>('SELECT reward_address FROM pools WHERE address = ?', POOL)[0]!.reward_address).toBe(SURF)
    expect([c.newest_block, c.resume_hash, c.reach_ts, c.hole_from_ts, c.hole_to_ts, c.backfill_done]).toEqual([null, null, null, null, null, 1])
  })

  it('a server fault on getValidatorByAddress changes nothing', async () => {
    for (let i = 0; i < 12 && cursor()?.backfill_done !== 1; i++) await tick()
    state.validator = 'fault'
    await tick(25 * 60 * MIN)
    const p = db.query<{ reward_address: string | null; reward_misses: number }>('SELECT reward_address, reward_misses FROM pools WHERE address = ?', POOL)[0]!
    expect(p).toEqual({ reward_address: POOL, reward_misses: 0 })
    expect(meta('indexer_last_error')!.value).toMatch(/Internal error/)
  })

  it('an RPC outage keeps the data, records the error and never throws', async () => {
    for (let i = 0; i < 12 && cursor()?.backfill_done !== 1; i++) await tick()
    const before = cursor()
    const s = sums()
    state.rpcDown = true
    chain.head = top
    const r = await tick(120 * MIN)
    expect(r.pages).toBe(0)
    expect(r.subrequests).toBeLessThanOrEqual(25)
    expect(cursor()).toEqual(before)
    expect(sums()).toEqual(s)
    expect(meta('indexer_last_error')!.value).toMatch(/503/)
    state.rpcDown = false
    await tick()
    expect(meta('indexer_last_error')!.value).toBe('')
  })

  it('two overlapping ticks fold the same txs only once', async () => {
    for (let i = 0; i < 12 && cursor()?.backfill_done !== 1; i++) await tick()
    chain.head = top - 15_000
    t += 120 * MIN
    const run = () => runIndexerTick(env(), { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
    const [a, b] = await Promise.all([run(), run()])
    expect(a.pages + b.pages).toBeGreaterThan(1)
    const e = expectedUpTo(lastMacro(chain.head))
    for (let i = 0; i < 10 && cursor()!.resume_hash; i++) await tick()
    expect(sums().earned).toBe(e.earned)
    expect(sums().paid + sums().other).toBe(e.out)
  })
})

describe('a wedged pool cannot starve the others (review r3)', () => {
  const WEDGE = 'NQ24 8V0E L24U TGQ6 KAGA 0KGY SR4F GVV1 SXNA'
  const vals = [validators[0], { ...validators[0], address: WEDGE, name: 'Wedge Pool' }]
  afterEach(() => vi.unstubAllGlobals())

  it('an open descent whose RPC keeps answering [] is backed off and the other pools keep moving', async () => {
    const db = new FakeD1()
    const chain = new FakeChain(POOL, garuda.txs, top - 20_000)
    const calls = { wedge: 0 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === VALIDATORS_API) return new Response(JSON.stringify(vals))
        const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
        const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
        if (method === 'getValidatorByAddress') return ok({ address: params[0], rewardAddress: params[0] })
        if (method === 'getStakerByAddress') return ok({ address: params[0], delegation: POOL, balance: 1 })
        if (params[0] === WEDGE) {
          calls.wedge++
          return ok([])
        }
        return ok(chain.page(params[0] as string, params[2] as string | null))
      }),
    )
    let t = Date.UTC(2026, 10, 7, 12)
    // a catch-up descent the RPC will never serve
    db.db.prepare(
      'INSERT INTO pool_cursor (pool, newest_hash, newest_block, oldest_block, backfill_done, resume_hash, floor_block, visited_at, txs_per_hour) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(WEDGE, 'w-top', 66_200_000, 65_000_000, 1, 'w-resume', 66_100_000, t - 2 * 3_600_000, 10)
    const env = { DB: db as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never }
    const garudaCursor = () => db.query<Record<string, number | string | null>>('SELECT newest_block, resume_hash, backfill_done FROM pool_cursor WHERE pool = ?', POOL)[0]
    const progress: unknown[] = []
    for (let i = 0; i < 4; i++) {
      t += 5 * 60_000
      await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
      progress.push(garudaCursor() && JSON.stringify(garudaCursor()))
    }
    // the wedged pool was tried once, then left alone for the back-off; Garuda kept being scanned
    expect(calls.wedge).toBe(1)
    expect(new Set(progress).size).toBe(4)
    const err = db.query<{ value: string }>("SELECT value FROM meta WHERE key = ?", `scan_error:${WEDGE}`)[0]
    expect(err?.value).toMatch(/empty page/)
    // after the back-off it is tried again, still without stopping the rest
    t += 31 * 60_000
    await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
    expect(calls.wedge).toBe(2)
  })
})

describe('one pool the RPC fails on cannot starve the others (Task 8 minor)', () => {
  const BAD = 'NQ51 7BS3 0HVH 9R5M TUDH C5PG 490G S7XT KD4D'
  const BAD2 = 'NQ40 FC4D HAT6 9N1H P52H P4FX QL8P CE6Y 10VT'
  afterEach(() => vi.unstubAllGlobals())

  function world(failing: Record<string, () => Response>, extra: string[] = []) {
    const db = new FakeD1()
    const chain = new FakeChain(POOL, garuda.txs, top - 20_000)
    const calls: Record<string, number> = {}
    const vals = [validators[0]!, ...[...Object.keys(failing), ...extra].map((a, i) => ({ ...validators[0]!, address: a, name: `Pool ${i}` }))]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === VALIDATORS_API) return new Response(JSON.stringify(vals))
        const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
        const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
        if (method === 'getValidatorByAddress') return ok({ address: params[0], rewardAddress: params[0] })
        if (method === 'getStakerByAddress') return ok({ address: params[0], delegation: POOL, balance: 1 })
        const who = params[0] as string
        if (failing[who]) {
          calls[who] = (calls[who] ?? 0) + 1
          return failing[who]!()
        }
        return ok(chain.page(who, params[2] as string | null))
      }),
    )
    const env = { DB: db as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never }
    let t = Date.UTC(2026, 10, 7, 12)
    // every pool known with its reward address, so the first ticks scan only
    for (const v of vals) {
      db.db.prepare('INSERT INTO pools (address, name, fee, payout_type, schedule, listed, reward_address, reward_checked_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(v.address, v.name, 0.05, 'restake', 'Every 12 hours', 1, v.address, t)
    }
    db.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('pools_synced_at', ?, ?)").run(String(vals.length), t)
    // the failing pools sit in open descents, the highest visit priority, so they come first every tick
    for (const a of Object.keys(failing)) {
      db.db.prepare(
        'INSERT INTO pool_cursor (pool, newest_hash, newest_block, oldest_block, backfill_done, resume_hash, floor_block, visited_at, txs_per_hour) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(a, `${a}-top`, 66_200_000, 65_000_000, 1, `${a}-resume`, 66_100_000, t - 2 * 3_600_000, 10)
    }
    const tick = async (ms = 5 * 60_000) => {
      t += ms
      return runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
    }
    const garudaCursor = () => db.query<Record<string, unknown>>('SELECT newest_block, resume_hash, backfill_done FROM pool_cursor WHERE pool = ?', POOL)[0]
    const meta = (k: string) => db.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', k)[0]?.value
    return { db, calls, tick, garudaCursor, meta }
  }
  const rpcFault = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } }))

  it('a pool whose pages always fail is backed off like a data error, and Garuda keeps moving', async () => {
    const w = world({ [BAD]: rpcFault })
    const progress: unknown[] = []
    for (let i = 0; i < 4; i++) {
      await w.tick()
      progress.push(JSON.stringify(w.garudaCursor() ?? null))
    }
    // three attempts in the first tick, then the 30 min back-off; Garuda is scanned in every later tick
    expect(w.calls[BAD]).toBe(3)
    expect(new Set(progress.slice(1)).size).toBe(3)
    expect(progress[3]).not.toBe('null')
    expect(w.meta(`scan_error:${BAD}`)).toMatch(/Internal error/)
    await w.tick(31 * 60_000)
    expect(w.calls[BAD]).toBe(6)
  })

  it('failures on two different pools in one tick are an RPC outage: the tick stops and nobody is backed off', async () => {
    // a 4xx is not retried, so both pools fail inside one tick's budget
    const w = world({ [BAD]: () => new Response('', { status: 400 }), [BAD2]: () => new Response('', { status: 400 }) })
    const r = await w.tick()
    expect(r.pages).toBe(0)
    expect([w.calls[BAD], w.calls[BAD2]]).toEqual([1, 1])
    expect(w.meta(`scan_error:${BAD}`)).toBeUndefined()
    expect(w.meta(`scan_error:${BAD2}`)).toBeUndefined()
    expect(w.meta('indexer_last_error')).toMatch(/Pool 0.*Pool 1|Pool 1.*Pool 0/)
    // Garuda was not visited after the outage was seen
    expect(w.garudaCursor()).toBeUndefined()
    await w.tick()
    expect([w.calls[BAD], w.calls[BAD2]]).toEqual([2, 2])
  })

  it('a reward-address check that keeps failing for one pool does not stop the scans', async () => {
    const db = new FakeD1()
    const chain = new FakeChain(POOL, garuda.txs, top - 20_000)
    let rewardFaults = 0
    const vals = [validators[0], { ...validators[0], address: BAD, name: 'Bad Reward' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === VALIDATORS_API) return new Response(JSON.stringify(vals))
        const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
        const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
        if (method === 'getValidatorByAddress') {
          if (params[0] === BAD) {
            rewardFaults++
            return rpcFault()
          }
          return ok({ address: params[0], rewardAddress: params[0] })
        }
        if (method === 'getStakerByAddress') return ok({ address: params[0], delegation: POOL, balance: 1 })
        return ok(chain.page(params[0] as string, params[2] as string | null))
      }),
    )
    const env = { DB: db as never, NIM_RPCS: 'https://rpc.test', POLYGON_RPCS: '', RELAYER_ADDRESS: '', RELAYER: null as never }
    // BAD has never been checked, so it sorts first among the reward checks of every tick
    db.db.prepare('INSERT INTO pools (address, name, fee, payout_type, schedule, listed, reward_checked_at) VALUES (?,?,?,?,?,?,?)').run(BAD, 'Bad Reward', 0.05, 'restake', '', 1, null)
    db.db.prepare('INSERT INTO pools (address, name, fee, payout_type, schedule, listed, reward_checked_at, reward_address) VALUES (?,?,?,?,?,?,?,?)').run(POOL, 'Garuda Pool', 0.05, 'restake', '', 1, 1, POOL)
    let t = Date.UTC(2026, 10, 7, 12)
    db.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('pools_synced_at', '2', ?)").run(t)
    const blocks: unknown[] = []
    for (let i = 0; i < 3; i++) {
      t += 5 * 60_000
      await runIndexerTick(env, { maxPages: 3, maxMs: 25_000 }, { now: () => t, sleep: async () => {} })
      blocks.push(db.query<{ n: number }>('SELECT COUNT(*) n FROM pool_hour WHERE pool = ?', POOL)[0]!.n)
    }
    expect(blocks[0]).toBeGreaterThan(0)
    // tried once (three attempts), then left alone for the back-off
    expect(rewardFaults).toBe(3)
  })
})
