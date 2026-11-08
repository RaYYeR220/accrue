import { afterEach, describe, expect, it, vi } from 'vitest'
import { BATCH_BLOCKS, type NimTx } from '@accrue/shared'
import { aggregate } from '../src/indexer/aggregate'
import { Budget, PAGE_SIZE, freshCursor, rpcSource, scanPool, type Cursor } from '../src/indexer/scan'
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
    const c: Cursor = { ...freshCursor(), newestHash: 'x', newestBlock: top - 100, oldestBlock: 1, backfillDone: true, lastPayoutBlock: 7, visitedAt: 3, txsPerHour: 10 }
    const s = await scanPool(chain.source(), garuda.address, c, { maxPages: 3, now: 9, canFetch: () => true })
    expect(s.pages).toBe(0)
    expect(s.txs).toHaveLength(0)
    expect(s.cursor).toEqual(c)
  })

  it('an empty head page for an address with history is an error, not "nothing new"', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top)
    const c: Cursor = { ...freshCursor(), newestHash: 'x', newestBlock: top - 100, oldestBlock: 1, backfillDone: true, lastPayoutBlock: 7, visitedAt: 3, txsPerHour: 10 }
    const s = await scanPool({ ...chain.source(), txPage: async () => [] }, garuda.address, c, { maxPages: 3, now: 9, canFetch: () => true })
    expect(s.error).toMatch(/empty head page/)
    expect(s.pages).toBe(0)
    expect(s.cursor).toEqual(c)
  })

  it('a changed reward address (head anchor) indexes forward only', async () => {
    const chain = new FakeChain(garuda.address, garuda.txs, top - 10_000)
    const anchor: Cursor = { ...freshCursor(), backfillDone: true }
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

// Synthetic reward address for the paging edge cases: one tx per few blocks, newest first.
const ADDR = 'NQ00 TEST'
const mk = (i: number, block: number) =>
  ({ hash: `h${i}`, blockNumber: block, timestamp: block * 1000, from: 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000', to: ADDR, fromType: 0, toType: 0, value: 1, fee: 0, senderData: '', recipientData: '', relatedAddresses: [] }) as NimTx
function synth(all: NimTx[], head: { head: number }, emptyOn: number[] = []) {
  let calls = 0
  return {
    calls: () => calls,
    async txPage(_a: string, startAt: string | null) {
      calls++
      if (emptyOn.includes(calls)) return []
      const vis = all.filter((t) => t.blockNumber <= head.head).sort((a, b) => b.blockNumber - a.blockNumber || (a.hash < b.hash ? 1 : -1))
      const i = startAt === null ? 0 : vis.findIndex((t) => t.hash === startAt) + 1
      if (startAt !== null && i === 0) return []
      return vis.slice(i, i + PAGE_SIZE).map((t) => ({ ...t, confirmations: head.head - t.blockNumber + 1 })) as NimTx[]
    },
    async delegation() {
      return ''
    },
    async rewardAddress(v: string) {
      return v
    },
  }
}
const existing = (newestBlock: number): Cursor => ({ ...freshCursor(), newestHash: 'h0', newestBlock, oldestBlock: 1, backfillDone: true, visitedAt: 0, txsPerHour: 1 })
const run = (src: ReturnType<typeof synth>, c: Cursor | null, maxPages: number, now = 1e9) =>
  scanPool(src, ADDR, c, { maxPages, now, canFetch: () => true })

describe('scanPool paging edge cases', () => {
  it('an empty page after a full one is an error that keeps the descent open; nothing is lost', async () => {
    const txs = [...Array.from({ length: 2000 }, (_, i) => mk(i, 20_000 + i * 2)), ...Array.from({ length: 30 }, (_, i) => mk(5000 + i, 18_000 + i))]
    const head = { head: 24_100 }
    const src = synth(txs, head, [2])
    const s1 = await run(src, existing(19_000), 5)
    expect(s1.error).toMatch(/empty page/)
    expect(s1.txs).toHaveLength(PAGE_SIZE)
    expect(s1.cursor.resumeHash).toBe(s1.txs[s1.txs.length - 1]!.hash)
    const s2 = await run(src, s1.cursor, 5)
    expect(s2.error).toBeNull()
    expect(s2.cursor.resumeHash).toBeNull()
    const all = [...s1.txs, ...s2.txs].map((t) => t.hash)
    const want = txs.filter((t) => t.blockNumber > 19_000 && t.blockNumber <= lastMacro(head.head))
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(want.length)
  })

  it('an empty first page when continuing a descent is an error, the resume point stays', async () => {
    const txs = Array.from({ length: 1200 }, (_, i) => mk(i, 30_000 + i * 2))
    const head = { head: 32_500 }
    const src = synth(txs, head, [2])
    const s1 = await run(src, existing(29_000), 1)
    expect(s1.cursor.resumeHash).not.toBeNull()
    const s2 = await run(src, s1.cursor, 3)
    expect(s2.error).toMatch(/empty page/)
    expect(s2.cursor.resumeHash).toBe(s1.cursor.resumeHash)
    expect(s2.txs).toHaveLength(0)
  })

  it('a short page that never reaches indexed history is an RPC fault: error, resume kept', async () => {
    const txs = [...Array.from({ length: 900 }, (_, i) => mk(i, 80_000 + i * 2)), ...Array.from({ length: 30 }, (_, i) => mk(5000 + i, 78_000 + i))]
    const head = { head: 81_900 }
    const src = synth(txs, head)
    const truncating = { ...src, txPage: async (a: string, st: string | null) => (await src.txPage(a, st)).slice(0, 200) }
    const s1 = await run(truncating as never, existing(79_000), 3)
    expect(s1.error).toMatch(/short page/)
    expect(s1.cursor.resumeHash).toBe(s1.txs[s1.txs.length - 1]!.hash)
    expect(s1.cursor.floorBlock).toBe(79_000)
    // the RPC behaves again: the descent picks up where it stopped, nothing lost or doubled
    const s2 = await run(src, s1.cursor, 5)
    expect(s2.error).toBeNull()
    expect(s2.cursor.resumeHash).toBeNull()
    const all = [...s1.txs, ...s2.txs].map((t) => t.hash)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(txs.filter((t) => t.blockNumber > 79_000 && t.blockNumber <= lastMacro(head.head)).length)
  })

  it('a first visit that only saw unfinalised txs does not wedge the cursor', async () => {
    // the whole history is above the last macro block at the first visit, so nothing is folded and
    // there is no tx at or below newestBlock; a later short page is then the plain end of history
    const ADDR3 = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
    const tx3 = (i: number, block: number) => ({ ...mk(i, block), to: ADDR3 }) as NimTx
    const chain3 = new FakeChain(ADDR3, [tx3(3, 1_000_160), tx3(2, 1_000_100), tx3(1, 1_000_030)], 1_000_040)
    let c: Cursor | null = null
    const folded: string[] = []
    for (const head of [1_000_040, 1_000_200, 1_000_300, 1_000_400, 1_000_500]) {
      chain3.head = head
      const st = await scanPool(chain3.source(), ADDR3, c, { maxPages: 3, now: head * 1000, canFetch: () => true, backfillBlocks: 50_000 })
      expect(st.error, `head ${head}`).toBeNull()
      folded.push(...st.txs.map((t) => t.hash))
      c = st.cursor
    }
    expect(folded.sort()).toEqual(['h1', 'h2', 'h3'])
    expect(c!.resumeHash).toBeNull()
  })

  it('tells an RPC fault from a data inconsistency', async () => {
    const txs = [...Array.from({ length: 900 }, (_, i) => mk(i, 90_000 + i * 2)), ...Array.from({ length: 30 }, (_, i) => mk(5000 + i, 88_000 + i))]
    const src = synth(txs, { head: 92_000 }, [2])
    const s1 = await run(src, existing(89_000), 3)
    expect(s1.errorKind).toBe('data')
    const down = { ...src, txPage: async () => { throw new Error('HTTP 503') } }
    const s2 = await run(down as never, existing(89_000), 3)
    expect(s2.errorKind).toBe('rpc')
    expect((await run(src, s1.cursor, 3)).errorKind).toBeNull()
  })

  it('a short page is the end of history: no extra fetch', async () => {
    const txs = Array.from({ length: 700 }, (_, i) => mk(i, 40_000 + i * 3))
    const src = synth(txs, { head: 42_200 })
    const s = await scanPool(src, ADDR, null, { maxPages: 10, now: 1e9, canFetch: () => true, backfillBlocks: 10_000 })
    expect(src.calls()).toBe(2)
    expect(s.cursor.backfillDone).toBe(true)
    expect(s.cursor.resumeHash).toBeNull()
    expect(s.txs).toHaveLength(700)
  })

  it('a backfill that meets the first tx at a page boundary asks once more, then ends', async () => {
    const txs = Array.from({ length: 1000 }, (_, i) => mk(i, 70_000 + i * 2))
    const src = synth(txs, { head: 72_100 })
    const s = await scanPool(src, ADDR, null, { maxPages: 10, now: 1e9, canFetch: () => true, backfillBlocks: 50_000 })
    expect(s.error).toBeNull()
    expect(s.txs).toHaveLength(1000)
    expect(s.cursor.backfillDone).toBe(true)
    expect(src.calls()).toBe(4)
  })

  it('more than a page of txs above the last macro block is never folded twice', async () => {
    const txs: NimTx[] = []
    let n = 0
    for (let b = 10_000; b < 11_980; b += 4) txs.push(mk(n++, b))
    for (let k = 0; k < 600; k++) txs.push(mk(n++, 12_001 + (k % 58)))
    const head = { head: 12_059 }
    const src = synth(txs, head)
    const s1 = await run(src, existing(11_000), 1)
    const s2 = await run(src, s1.cursor, 5)
    head.head = 12_200
    const s3 = await run(src, s2.cursor, 5, 2e9)
    const got = [...s1.txs, ...s2.txs, ...s3.txs].map((t) => t.hash)
    expect(new Set(got).size).toBe(got.length)
    expect(got.length).toBe(txs.filter((t) => t.blockNumber > 11_000 && t.blockNumber <= lastMacro(12_200)).length)
  })

  it('an empty head page never moves a fresh or reset cursor', async () => {
    const src = synth([], { head: 50_000 })
    const fresh = await run(src, null, 2)
    expect(fresh.cursor.newestBlock).toBeNull()
    expect(fresh.cursor.backfillDone).toBe(false)
    const reset: Cursor = { ...freshCursor(), backfillDone: true }
    const again = await run(src, reset, 2)
    expect(again.cursor.newestBlock).toBeNull()
  })

  it('dates the reach from the head, not from an old tx, on an idle address', async () => {
    // newest tx is ~1M blocks below the head: extrapolating from it would date the reach wrongly
    const txs = [mk(1, 1_000_000), mk(2, 999_000)]
    const head = { head: 2_000_000 }
    const now = 5_000_000_000_000
    const s = await scanPool(synth(txs, head), ADDR, existing(1_500_000), { maxPages: 1, now, canFetch: () => true })
    expect(s.cursor.reachTs).toBeLessThanOrEqual(now)
    expect(s.cursor.reachTs).toBe(now - (head.head - lastMacro(head.head)) * 1000)
  })

  it('records where the data reaches and the hole an open descent leaves', async () => {
    const txs = [...Array.from({ length: 1500 }, (_, i) => mk(i, 60_000 + i * 2)), ...Array.from({ length: 30 }, (_, i) => mk(5000 + i, 58_000 + i))]
    const head = { head: 63_100 }
    const src = synth(txs, head)
    const before: Cursor = { ...existing(59_000), reachTs: 59_000_000 }
    const s1 = await run(src, before, 1)
    expect(s1.cursor.reachTs).toBe(lastMacro(head.head) * 1000)
    expect(s1.cursor.holeFromTs).toBe(59_000_000)
    expect(s1.cursor.holeToTs).toBe(s1.txs[s1.txs.length - 1]!.timestamp)
    const s2 = await run(src, s1.cursor, 1)
    expect(s2.cursor.holeToTs).toBe(s2.txs[s2.txs.length - 1]!.timestamp)
    const s3 = await run(src, s2.cursor, 5)
    expect(s3.cursor.resumeHash).toBeNull()
    expect(s3.cursor.holeFromTs).toBeNull()
    expect(s3.cursor.holeToTs).toBeNull()
  })
})

describe('rpcSource negative answers', () => {
  afterEach(() => vi.unstubAllGlobals())
  const env = { NIM_RPCS: 'https://rpc.test' }
  const rpcErr = (data?: string) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', ...(data ? { data } : {}) } }))

  it('a bare "Internal error" is not "not a staker": retried, then thrown', async () => {
    const f = vi.fn(async () => rpcErr())
    vi.stubGlobal('fetch', f)
    const src = rpcSource(env, new Budget(10, Date.now() + 60_000), { sleep: async () => {} })
    await expect(src.delegation('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).rejects.toThrow(/Internal error/)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('"No staker" / "No validator" in the error data are final answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const m = JSON.parse(String(init.body)).method
        return rpcErr(m === 'getStakerByAddress' ? 'No staker with address: X' : 'No validator with address: Y')
      }),
    )
    const b = new Budget(10, Date.now() + 60_000)
    const src = rpcSource(env, b, { sleep: async () => {} })
    expect(await src.delegation('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe('')
    expect(await src.rewardAddress('NQ51 SURF MCTM AQXM 15PA K9FX 8EEX 29BE VGH8')).toBeNull()
    expect(b.used).toBe(2)
  })

  it('a bare "Internal error" on getValidatorByAddress is not "not a validator"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcErr()))
    const src = rpcSource(env, new Budget(10, Date.now() + 60_000), { sleep: async () => {} })
    await expect(src.rewardAddress('NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH')).rejects.toThrow()
  })
})
