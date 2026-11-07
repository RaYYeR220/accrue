import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS, COINBASE_ADDRESS, addressFromBytesHex, type NimTx } from '@accrue/shared'
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

function routes(chain: FakeChain, state: { rpcDown: boolean; fetches: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    state.fetches++
    const url = String(input)
    if (url === VALIDATORS_API) return new Response(JSON.stringify(validators))
    if (state.rpcDown) return new Response('', { status: 503 })
    const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] }
    const ok = (data: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data } }))
    const err = (data: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data } }))
    if (method === 'getValidatorByAddress') return params[0] === POOL ? ok({ address: POOL, rewardAddress: POOL }) : err('No validator')
    if (method === 'getTransactionsByAddress') return ok(chain.page(params[0] as string, params[2] as string | null))
    if (method === 'getStakerByAddress') return params[0] === outsider ? err('No staker') : ok({ address: params[0], delegation: POOL, balance: 1 })
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
  const state = { rpcDown: false, fetches: 0 }
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
