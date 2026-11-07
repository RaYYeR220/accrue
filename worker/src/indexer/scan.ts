import { BATCH_BLOCKS, type NimTx } from '@accrue/shared'
import type { Env } from '../env'
import { nimRpc, nimUrls, RpcUnavailable } from '../rpc/nimiq'
import { HOUR_MS, canonicalAddress } from './aggregate'

export const PAGE_SIZE = 500
// 7-day window plus slack, so the window is fully covered right after a backfill
export const BACKFILL_BLOCKS = 7 * 86_400 + 6 * 3_600

export class BudgetExhausted extends Error {
  constructor() {
    super('subrequest budget exhausted')
    this.name = 'BudgetExhausted'
  }
}

/**
 * Counts every outgoing call (RPC, HTTP, D1) of one invocation against the free-plan limits, and
 * the public Nimiq RPC's rate-limit tokens (20 per 10 s per IP; a tx page costs one token per 100
 * requested txs, other calls one).
 */
export class Budget {
  used = 0
  tokens = 0
  constructor(
    readonly limit: number,
    readonly deadline: number,
    private readonly now: () => number = Date.now,
    readonly tokenLimit = Number.POSITIVE_INFINITY,
  ) {}
  left() {
    return this.limit - this.used
  }
  /** true when `n` more calls (costing `tokens`) fit and at least `reserve` calls stay free. */
  can(n = 1, reserve = 0, tokens = 0) {
    return this.used + n + reserve <= this.limit && this.tokens + tokens <= this.tokenLimit && this.now() < this.deadline
  }
  take(n = 1, tokens = 0) {
    if (this.used + n > this.limit || this.tokens + tokens > this.tokenLimit) throw new BudgetExhausted()
    this.used += n
    this.tokens += tokens
  }
  /** Counts a call that has to happen regardless (the final D1 write); the platform hard limit is 50. */
  charge(n = 1) {
    this.used += n
  }
}

export const RATE_WINDOW_MS = 10_000
export const PAGE_TOKENS = Math.ceil(PAGE_SIZE / 100)

export interface NimSource {
  /** Up to PAGE_SIZE txs, newest first, starting after `startAt` (exclusive). */
  txPage(address: string, startAt: string | null): Promise<NimTx[]>
  /** Validator the address delegates to, or '' when it is not a staker. */
  delegation(address: string): Promise<string>
  /** Reward address of a validator, or null when the address is not a validator. */
  rewardAddress(validator: string): Promise<string | null>
}

// Only an answer in JSON-RPC error form (or a plain 4xx) is final; anything else (5xx, 429, empty or
// unparseable body, timeouts) is worth a retry. getStakerByAddress answers "Internal error" for a
// non-staker, so misreading a hiccup as final would cache a wrong "not a staker".
const DEFINITIVE = /\b(Internal error|Invalid params|Invalid request|Method not found|rpc error)\b|HTTP 4(?!08|25|29)\d\d/i

export function rpcSource(
  env: Pick<Env, 'NIM_RPCS'>,
  budget: Budget,
  opts: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>; reserve?: number } = {},
): NimSource {
  const attempts = opts.attempts ?? 3
  const backoffMs = opts.backoffMs ?? 400
  const reserve = opts.reserve ?? 0
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // nimRpc may try every configured server, so charge for all of them
  const cost = Math.max(1, nimUrls(env).length)

  // ok: data; definitive: the server answered with a JSON-RPC error (e.g. "no staker")
  async function call<T>(method: string, params: unknown[], tokens: number): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    let last = ''
    let wait = 0
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(wait)
      if (!budget.can(cost, reserve, tokens)) throw new BudgetExhausted()
      budget.take(cost, tokens)
      try {
        return { ok: true, data: await nimRpc<T>(env, method, params) }
      } catch (e) {
        if (!(e instanceof RpcUnavailable)) throw e
        if (e.causes.every((c) => DEFINITIVE.test(c))) return { ok: false, error: e.message }
        last = e.message
        // a 429 only clears when the rate window rolls over
        wait = e.causes.some((c) => c.includes('HTTP 429')) ? RATE_WINDOW_MS + 500 : backoffMs * 3 ** i
      }
    }
    throw new Error(last || `${method} failed`)
  }

  return {
    async txPage(address, startAt) {
      const r = await call<NimTx[]>('getTransactionsByAddress', [address, PAGE_SIZE, startAt], PAGE_TOKENS)
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    async delegation(address) {
      const r = await call<{ delegation: string }>('getStakerByAddress', [address], 1)
      return r.ok ? canonicalAddress(r.data.delegation) : ''
    },
    async rewardAddress(validator) {
      const r = await call<{ rewardAddress: string }>('getValidatorByAddress', [validator], 1)
      return r.ok ? canonicalAddress(r.data.rewardAddress) : null
    },
  }
}

/**
 * Per-pool position in the reward address's history (newest first).
 * Everything at or below `newestBlock` is folded in, except an open descent: from `resumeHash`
 * (exclusive) down to `floorBlock` (exclusive) is still to do. A first visit is a descent with the
 * floor BACKFILL_BLOCKS below the head; a catch-up longer than a tick's pages is one too.
 * `newestBlock` null with `backfillDone` set means "start from the head" (reward address changed).
 */
export interface Cursor {
  newestHash: string | null
  newestBlock: number | null
  oldestBlock: number | null
  backfillDone: boolean
  resumeHash: string | null
  floorBlock: number | null
  lastPayoutBlock: number | null
  visitedAt: number | null
  txsPerHour: number | null
}

export const freshCursor = (): Cursor => ({
  newestHash: null, newestBlock: null, oldestBlock: null, backfillDone: false, resumeHash: null,
  floorBlock: null, lastPayoutBlock: null, visitedAt: null, txsPerHour: null,
})

export interface ScanStep {
  /** txs to fold in, newest first, contiguous with what the cursor already covers */
  txs: NimTx[]
  cursor: Cursor
  pages: number
  /** this step started at the head (as opposed to continuing an open descent) */
  fromHead: boolean
  error: string | null
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const confirmations = (tx: NimTx) => (tx as { confirmations?: number }).confirmations ?? 1

export async function scanPool(
  src: NimSource,
  rewardAddress: string,
  cursor: Cursor | null,
  opts: { maxPages: number; now: number; canFetch: () => boolean; backfillBlocks?: number },
): Promise<ScanStep> {
  const c: Cursor = cursor ? { ...cursor } : freshCursor()
  const isNew = cursor === null
  const fromHead = c.resumeHash === null
  const txs: NimTx[] = []
  let startAt = c.resumeHash
  let boundary: number | null = fromHead ? c.newestBlock : c.floorBlock ?? -1
  let lastMacro = Number.POSITIVE_INFINITY
  let pages = 0
  let reached = false
  let error: string | null = null

  while (pages < opts.maxPages && opts.canFetch()) {
    let page: NimTx[]
    try {
      page = await src.txPage(rewardAddress, startAt)
    } catch (e) {
      // running out of budget mid-retry is a normal stop, not an RPC failure
      if (!(e instanceof BudgetExhausted)) error = msg(e)
      break
    }
    if (page.length === 0 && fromHead && pages === 0 && c.newestHash !== null) {
      // an address we already saw txs on cannot have an empty head page
      error = 'empty head page from RPC'
      break
    }
    pages++
    if (fromHead && pages === 1) {
      // only blocks up to the last macro block are final; younger ones wait for the next visit
      const head = page.reduce((m, t) => Math.max(m, t.blockNumber + confirmations(t) - 1), 0)
      lastMacro = Math.floor(head / BATCH_BLOCKS) * BATCH_BLOCKS
      if (boundary === null) boundary = isNew ? lastMacro - (opts.backfillBlocks ?? BACKFILL_BLOCKS) : lastMacro
    }
    if (page.length === 0) {
      reached = true
      break
    }
    for (const tx of page) {
      if (tx.blockNumber > lastMacro) continue
      if (tx.blockNumber <= boundary!) {
        reached = true
        break
      }
      txs.push(tx)
    }
    startAt = page[page.length - 1]!.hash
    if (reached) break
  }

  if (pages === 0) return { txs, cursor: c, pages, fromHead, error }

  const lowest = txs.length ? txs[txs.length - 1]!.blockNumber : null
  const lower = (b: number | null) => {
    if (b !== null) c.oldestBlock = c.oldestBlock === null ? b : Math.min(c.oldestBlock, b)
  }
  lower(lowest)

  if (fromHead) {
    // a rate measured over a few seconds is noise
    const hours = c.visitedAt !== null ? (opts.now - c.visitedAt) / HOUR_MS : 0
    const rate = hours >= 0.05 ? txs.length / hours : null
    if (reached) {
      if (isNew) {
        c.backfillDone = true
        lower(Math.max(0, boundary! + 1))
      }
      if (rate !== null) c.txsPerHour = c.txsPerHour === null ? rate : (c.txsPerHour + rate) / 2
    } else {
      c.resumeHash = startAt
      c.floorBlock = boundary
      if (rate !== null) c.txsPerHour = Math.max(c.txsPerHour ?? 0, rate)
    }
    if (txs.length) c.newestHash = txs[0]!.hash
    if (Number.isFinite(lastMacro)) c.newestBlock = Math.max(c.newestBlock ?? 0, lastMacro)
    c.visitedAt = opts.now
  } else if (reached) {
    lower(c.floorBlock !== null ? c.floorBlock + 1 : null)
    c.resumeHash = null
    c.floorBlock = null
    c.backfillDone = true
  } else {
    c.resumeHash = startAt
  }
  return { txs, cursor: c, pages, fromHead, error }
}
