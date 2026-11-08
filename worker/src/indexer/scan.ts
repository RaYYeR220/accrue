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

// A JSON-RPC error is a final answer only when it says so ("No staker with address", "No validator
// with address" - the detail nimRpc keeps from error.data). A bare "Internal error", 5xx, 429, an
// empty or unparseable body or a timeout is a fault worth a retry, never a negative answer: reading
// it as "not a staker" would cache a wrong verdict, as "not a validator" would drop a reward address.
const NO_STAKER = /No staker/i
const NO_VALIDATOR = /No validator/i
const CLIENT_ERROR = /HTTP 4(?!08|25|29)\d\d/

export function rpcSource(
  env: Pick<Env, 'NIM_RPCS'>,
  budget: Budget,
  opts: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>; reserve?: number | (() => number) } = {},
): NimSource {
  const attempts = opts.attempts ?? 3
  const backoffMs = opts.backoffMs ?? 400
  const reserve = opts.reserve ?? 0
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // nimRpc may try every configured server, so charge for all of them
  const cost = Math.max(1, nimUrls(env).length)

  // ok: data; negative: the server said the thing does not exist (`negative` matches its answer)
  async function call<T>(
    method: string,
    params: unknown[],
    tokens: number,
    negative?: RegExp,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    let last = ''
    let wait = 0
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(wait)
      const keep = typeof reserve === 'function' ? reserve() : reserve
      if (!budget.can(cost, keep, tokens)) throw new BudgetExhausted()
      budget.take(cost, tokens)
      try {
        return { ok: true, data: await nimRpc<T>(env, method, params) }
      } catch (e) {
        if (!(e instanceof RpcUnavailable)) throw e
        if (negative && e.causes.length && e.causes.every((c) => negative.test(c))) return { ok: false, error: e.message }
        if (e.causes.length && e.causes.every((c) => CLIENT_ERROR.test(c))) throw e
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
      const r = await call<{ delegation: string }>('getStakerByAddress', [address], 1, NO_STAKER)
      return r.ok ? canonicalAddress(r.data.delegation) : ''
    },
    async rewardAddress(validator) {
      const r = await call<{ rewardAddress: string }>('getValidatorByAddress', [validator], 1, NO_VALIDATOR)
      return r.ok ? canonicalAddress(r.data.rewardAddress) : null
    },
  }
}

/**
 * Per-pool position in the reward address's history (newest first).
 * Everything at or below `newestBlock` is folded in, except an open descent: from `resumeHash`
 * (exclusive) down to `floorBlock` (exclusive) is still to do. A first visit is a descent with the
 * floor BACKFILL_BLOCKS below the head; a catch-up longer than a tick's pages is one too.
 * `newestBlock` null means nothing is folded yet: a new pool (backfill) or, with `backfillDone`
 * set, a changed reward address (start from the head, no backfill).
 *
 * Readers: `reachTs` is the time of `newestBlock`, how far the data reaches (use it, not the wall
 * clock, as the end of a window). While a descent is open, no data exists between `holeFromTs` and
 * `holeToTs`; a window must not span that range (`holeFromTs` 0 = nothing below, a backfill).
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
  reachTs: number | null
  holeFromTs: number | null
  holeToTs: number | null
}

export const freshCursor = (): Cursor => ({
  newestHash: null, newestBlock: null, oldestBlock: null, backfillDone: false, resumeHash: null,
  floorBlock: null, lastPayoutBlock: null, visitedAt: null, txsPerHour: null, reachTs: null,
  holeFromTs: null, holeToTs: null,
})

export interface ScanStep {
  /** txs to fold in, newest first, contiguous with what the cursor already covers */
  txs: NimTx[]
  cursor: Cursor
  pages: number
  /** this step started at the head (as opposed to continuing an open descent) */
  fromHead: boolean
  error: string | null
  /** 'rpc': the RPC failed (stop using it this tick); 'data': it answered something inconsistent for this pool */
  errorKind: 'rpc' | 'data' | null
}

// Albatross produces a block per second; used only to date a macro block with no tx of ours in it.
const BLOCK_MS = 1000
// beyond this distance a tx's timestamp says little about the head's time (block times drift)
const DATE_FROM_TX_BLOCKS = 3_600

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const confirmations = (tx: NimTx) => (tx as { confirmations?: number }).confirmations ?? 1

export async function scanPool(
  src: NimSource,
  rewardAddress: string,
  cursor: Cursor | null,
  opts: { maxPages: number; now: number; canFetch: () => boolean; backfillBlocks?: number },
): Promise<ScanStep> {
  const c: Cursor = { ...freshCursor(), ...(cursor ?? {}) }
  const isNew = c.newestBlock === null && !c.backfillDone
  const fromHead = c.resumeHash === null
  const txs: NimTx[] = []
  let startAt = c.resumeHash
  let boundary: number | null = fromHead ? c.newestBlock : c.floorBlock ?? -1
  // a descent never folds above the head it started from: those blocks belong to the next head step
  let lastMacro = fromHead ? Number.POSITIVE_INFINITY : (c.newestBlock ?? Number.POSITIVE_INFINITY)
  let reachTs: number | null = null
  let lastFetchedTs: number | null = null
  let pages = 0
  // History at or below the boundary is known to exist only once a tx was folded at or below it
  // (newestHash), or for a catch-up opened that way (backfillDone stays set). Then a short page that
  // stops above the boundary is an RPC fault; without that evidence it is just the start of history.
  const historyBelow = c.backfillDone && (fromHead ? c.newestHash !== null : true)
  let reached = false
  let askedAgain = false
  let error: string | null = null
  let errorKind: 'rpc' | 'data' | null = null

  while (pages < opts.maxPages && opts.canFetch()) {
    let page: NimTx[]
    try {
      page = await src.txPage(rewardAddress, startAt)
    } catch (e) {
      // running out of budget mid-retry is a normal stop, not an RPC failure
      if (!(e instanceof BudgetExhausted)) {
        error = msg(e)
        errorKind = 'rpc'
      }
      break
    }
    if (page.length === 0) {
      if (fromHead && pages === 0 && c.newestBlock === null) {
        // nothing on this address yet: note the visit, fold nothing, keep the cursor where it is
        return { txs, cursor: { ...c, visitedAt: opts.now }, pages: 1, fromHead, error, errorKind }
      }
      // The RPC returns full pages while more history exists, so after a full page (in this
      // call or the one that left this resume point) an empty one is a fault, not the end. Only a
      // backfill can run into an address's first tx at a page boundary; ask once more there.
      if (!c.backfillDone && !askedAgain && opts.canFetch()) {
        askedAgain = true
        continue
      }
      if (!c.backfillDone && askedAgain) {
        reached = true
        break
      }
      error = fromHead && pages === 0 ? 'empty head page from RPC' : 'empty page from RPC after a full page'
      errorKind = 'data'
      break
    }
    pages++
    if (fromHead && pages === 1) {
      // only blocks up to the last macro block are final; younger ones wait for the next visit
      const head = page.reduce((m, t) => Math.max(m, t.blockNumber + confirmations(t) - 1), 0)
      lastMacro = Math.floor(head / BATCH_BLOCKS) * BATCH_BLOCKS
      // date the last macro block from our newest tx when it is close, else from the head (the
      // RPC answered just now); an idle address's newest tx can be months old
      const ref = page[0]!
      reachTs = Math.min(
        opts.now,
        lastMacro - ref.blockNumber <= DATE_FROM_TX_BLOCKS
          ? ref.timestamp + (lastMacro - ref.blockNumber) * BLOCK_MS
          : opts.now - (head - lastMacro) * BLOCK_MS,
      )
      if (boundary === null) boundary = isNew ? lastMacro - (opts.backfillBlocks ?? BACKFILL_BLOCKS) : lastMacro
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
    lastFetchedTs = page[page.length - 1]!.timestamp
    if (reached) break
    if (page.length < PAGE_SIZE) {
      if (historyBelow) {
        error = 'short page from RPC above indexed history'
        errorKind = 'data'
      } else reached = true
      break
    }
  }

  if (pages === 0) return { txs, cursor: c, pages, fromHead, error, errorKind }

  const lowest = txs.length ? txs[txs.length - 1]! : null
  const lower = (b: number | null) => {
    if (b !== null) c.oldestBlock = c.oldestBlock === null ? b : Math.min(c.oldestBlock, b)
  }
  lower(lowest?.blockNumber ?? null)
  // the folded data above an open descent starts here
  const holeTop = lowest?.timestamp ?? lastFetchedTs

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
      c.holeFromTs = isNew ? 0 : c.reachTs
      c.holeToTs = holeTop
      // no tx folded yet at or below the floor: this catch-up may run into the start of history,
      // like a backfill (closing it sets backfillDone again)
      if (c.newestHash === null) c.backfillDone = false
      if (rate !== null) c.txsPerHour = Math.max(c.txsPerHour ?? 0, rate)
    }
    if (txs.length) c.newestHash = txs[0]!.hash
    if (Number.isFinite(lastMacro) && lastMacro >= (c.newestBlock ?? 0)) {
      c.newestBlock = lastMacro
      c.reachTs = reachTs
    }
    c.visitedAt = opts.now
  } else if (reached) {
    lower(c.floorBlock !== null ? c.floorBlock + 1 : null)
    c.resumeHash = null
    c.floorBlock = null
    c.holeFromTs = null
    c.holeToTs = null
    c.backfillDone = true
  } else {
    c.resumeHash = startAt
    if (holeTop !== null) c.holeToTs = holeTop
  }
  return { txs, cursor: c, pages, fromHead, error, errorKind }
}
