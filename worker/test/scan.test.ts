import { afterEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS, type NimTx } from '@accrue/shared'
import { aggregate } from '../src/indexer/aggregate'
import { Budget, PAGE_SIZE, rpcSource, scanPool, type Cursor } from '../src/indexer/scan'
import { FakeChain, load } from './chain'

const garuda = load('garuda-2026-11-07.json')
const POOL = { rewardAddress: garuda.address }
const top = Math.max(...garuda.txs.map((t) => t.blockNumber))
const bottom = Math.min(...garuda.txs.map((t) => t.blockNumber))
const lastMacro = (head: number) => Math.floor(head / BATCH_BLOCKS) * BATCH_BLOCKS

// Drives scanPool tick after tick the way the cron does, keeping every slice it hands back.
async function drive(chain: FakeChain, cursor: Cursor | null, maxPages: number, maxTicks = 200) {
  const slices: { txs: NimTx[]; fromHead: boolean; before: Cursor | null }[] = []
  let c = cursor
  for (let i = 0; i < maxTicks; i++) {
    const s = await scanPool(chain.source(), garuda.address, c, { maxPages, now: 1_000_000 + i, canFetch: () => true, backfillBlocks: top - bottom + 10_000 })
    slices.push({ txs: s.txs, fromHead: s.fromHead, before: c })
    c = s.cursor
    if (!c.resumeHash) break
  }
  return { cursor: c!, slices }
}

const hashes = (xs: NimTx[]) => xs.map((t) => t.hash)

describe('scanPool', () => {
  it('backfills a new pool over several ticks without gaps or repeats', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top - 20_000)
    const { cursor, slices } = await drive(chain, null, 3)
    const got = slices.flatMap((s) => s.txs)
    const want = garuda.txs.filter((t) => t.blockNumber <= lastMacro(chain.head))
    expect(slices.length).toBeGreaterThan(1)
    expect(new Set(hashes(got)).size).toBe(got.length)
    expect(new Set(hashes(got))).toEqual(new Set(hashes(want)))
    expect(cursor.backfillDone).toBe(true)
    expect(cursor.resumeHash).toBeNull()
    expect(cursor.newestBlock).toBe(lastMacro(chain.head))
    expect(cursor.oldestBlock).toBeLessThanOrEqual(bottom)
  })

  it('catches up incrementally and through a hole longer than one tick', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top - 80_000)
    const first = await drive(chain, null, 3)
    chain.head = top - 76_000
    const small = await drive(chain, first.cursor, 1)
    expect(small.slices).toHaveLength(1)
    chain.head = top
    const big = await drive(chain, small.cursor, 1)
    expect(big.slices.length).toBeGreaterThan(2)
    expect(big.slices[0]!.txs).toHaveLength(PAGE_SIZE)
    expect(big.slices.slice(1).every((s) => !s.fromHead)).toBe(true)

    const all = [...first.slices, ...small.slices, ...big.slices].flatMap((s) => s.txs)
    const want = garuda.txs.filter((t) => t.blockNumber <= lastMacro(top))
    expect(new Set(hashes(all)).size).toBe(all.length)
    expect(new Set(hashes(all))).toEqual(new Set(hashes(want)))

    // folding the slices one by one gives the same money as folding everything at once
    const once = aggregate(want, POOL, () => true)
    let prev: number | null = null
    let earned = 0n
    let paid = 0n
    for (const s of [...first.slices, ...small.slices, ...big.slices]) {
      const a = aggregate(s.txs, POOL, () => true, s.fromHead ? prev : null)
      if (s.fromHead) prev = a.lastPayoutBlock
      for (const h of a.hours) {
        earned += h.earned
        paid += h.paidRestake + h.paidDirect
      }
    }
    const sum = (f: (h: (typeof once.hours)[number]) => bigint) => once.hours.reduce((x, h) => x + f(h), 0n)
    expect(earned).toBe(sum((h) => h.earned))
    expect(paid).toBe(sum((h) => h.paidRestake + h.paidDirect))
  })

  it('leaves blocks after the last macro block for the next visit', async () => {
    const head = lastMacro(top - 5_000) + 37
    const chain = new FakeChain(garuda.address, garuda.txs, head)
    const { cursor, slices } = await drive(chain, null, 50)
    const got = slices.flatMap((s) => s.txs)
    expect(Math.max(...got.map((t) => t.blockNumber))).toBeLessThanOrEqual(lastMacro(head))
    expect(cursor.newestBlock).toBe(lastMacro(head))
    chain.head = top
    const next = await drive(chain, cursor, 50)
    const later = next.slices.flatMap((s) => s.txs)
    expect(later.every((t) => t.blockNumber > lastMacro(head))).toBe(true)
  })

  it('an RPC failure mid-descent keeps what was fetched and resumes from there', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top)
    const backfillBlocks = top - bottom + 10_000
    const run = (c: Cursor | null) => scanPool(chain.source(), garuda.address, c, { maxPages: 3, now: 5, canFetch: () => true, backfillBlocks })
    const a = await run(null)
    chain.failNext = 0
    const b1 = await scanPool(
      {
        ...chain.source(),
        txPage: (() => {
          let n = 0
          return async (addr: string, s: string | null) => {
            if (++n === 2) throw new Error('HTTP 503')
            return chain.page(addr, s)
          }
        })(),
      },
      garuda.address,
      a.cursor,
      { maxPages: 3, now: 6, canFetch: () => true },
    )
    expect(b1.error).toMatch(/503/)
    expect(b1.pages).toBe(1)
    expect(b1.cursor.resumeHash).toBe(b1.txs[b1.txs.length - 1]!.hash)
    const rest = await drive(chain, b1.cursor, 3)
    const all = [...a.txs, ...b1.txs, ...rest.slices.flatMap((s) => s.txs)]
    expect(new Set(hashes(all)).size).toBe(all.length)
    expect(all.length).toBe(garuda.txs.length)
  })

  it('a failure on the first page leaves the cursor untouched', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top)
    chain.failNext = 1
    const c: Cursor = { newestHash: 'x', newestBlock: top - 100, oldestBlock: 1, backfillDone: true, resumeHash: null, floorBlock: null, lastPayoutBlock: 7, visitedAt: 3, txsPerHour: 10 }
    const s = await scanPool(chain.source(), garuda.address, c, { maxPages: 3, now: 9, canFetch: () => true })
    expect(s.pages).toBe(0)
    expect(s.txs).toHaveLength(0)
    expect(s.cursor).toEqual(c)
  })

  it('an empty head page for an address with history is an error, not "nothing new"', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top)
    const c: Cursor = { newestHash: 'x', newestBlock: top - 100, oldestBlock: 1, backfillDone: true, resumeHash: null, floorBlock: null, lastPayoutBlock: 7, visitedAt: 3, txsPerHour: 10 }
    const s = await scanPool({ ...chain.source(), txPage: async () => [] }, garuda.address, c, { maxPages: 3, now: 9, canFetch: () => true })
    expect(s.error).toMatch(/empty head page/)
    expect(s.pages).toBe(0)
    expect(s.cursor).toEqual(c)
  })

  it('a changed reward address (head anchor) indexes forward only', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top - 10_000)
    const anchor: Cursor = { newestHash: null, newestBlock: null, oldestBlock: null, backfillDone: true, resumeHash: null, floorBlock: null, lastPayoutBlock: null, visitedAt: null, txsPerHour: null }
    const s = await scanPool(chain.source(), garuda.address, anchor, { maxPages: 3, now: 1, canFetch: () => true })
    expect(s.txs).toHaveLength(0)
    expect(s.cursor.newestBlock).toBe(lastMacro(top - 10_000))
  })
})

describe('Budget and rpcSource', () => {
  afterEach(() => vi.unstubAllGlobals())
  const env = { NIM_RPCS: 'https://rpc.test' }
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('retries transient failures and charges each attempt', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(reply({}, 503))
      .mockResolvedValueOnce(reply({ result: { data: [] } }))
    vi.stubGlobal('fetch', f)
    const b = new Budget(10, Date.now() + 10_000)
    const src = rpcSource(env, b, { sleep: async () => {} })
    expect(await src.txPage('NQ00', null)).toEqual([])
    expect(b.used).toBe(2)
  })

  it('retries an unparseable body instead of reading it as "not a staker"', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(reply({ result: { data: { delegation: 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH' } } }))
    vi.stubGlobal('fetch', f)
    const b = new Budget(10, Date.now() + 10_000)
    const src = rpcSource(env, b, { sleep: async () => {} })
    expect(await src.delegation('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe('NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('waits out the rate window after a 429 and counts RPC tokens', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', error: 'Rate limit exceeded' }), { status: 429 }))
      .mockResolvedValueOnce(reply({ result: { data: [] } }))
    vi.stubGlobal('fetch', f)
    const waits: number[] = []
    const b = new Budget(10, Date.now() + 60_000, Date.now, 18)
    const src = rpcSource(env, b, { sleep: async (ms) => void waits.push(ms) })
    await src.txPage('NQ00', null)
    expect(waits[0]).toBeGreaterThanOrEqual(10_000)
    expect(b.tokens).toBe(10)
    expect(b.can(1, 0, 8)).toBe(true)
    expect(b.can(1, 0, 9)).toBe(false)
  })

  it('reads a JSON-RPC error on getStakerByAddress as "not a staker" without retrying', async () => {
    const f = vi.fn(async () => reply({ error: { code: -32603, message: 'Internal error', data: 'No staker with address' } }))
    vi.stubGlobal('fetch', f)
    const b = new Budget(10, Date.now() + 10_000)
    const src = rpcSource(env, b, { sleep: async () => {} })
    expect(await src.delegation('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe('')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('stops at the budget, keeping the reserve free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({}, 503)))
    const b = new Budget(5, Date.now() + 10_000)
    const src = rpcSource(env, b, { sleep: async () => {}, reserve: 2 })
    await expect(src.txPage('NQ00', null)).rejects.toThrow()
    expect(b.used).toBe(3)
    expect(b.can(1, 2)).toBe(false)
  })
})
