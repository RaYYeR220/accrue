import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { keccak256, type Hex } from 'viem'

/** D1 stand-in backed by an in-memory SQLite with the real migrations applied. */
export function fakeD1() {
  const db = new DatabaseSync(':memory:')
  for (const f of ['0001_init.sql', '0002_indexer.sql', '0003_indexer_runs.sql', '0004_relay_jobs_detail.sql'])
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => {
      db.prepare(sql).run(...(args as never[]))
      return { success: true }
    },
  })
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => Promise.all(stmts.map(s => s.all())),
    rows: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[],
  }
}

/** Durable Object storage stand-in (KV API + alarm). Values are cloned like the real thing. */
export function fakeStorage() {
  const map = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    map,
    alarmAt: () => alarm,
    get: async (k: string) => structuredClone(map.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => {
      if (typeof k === 'string') map.set(k, structuredClone(v))
      else for (const [a, b] of Object.entries(k)) map.set(a, structuredClone(b))
    },
    delete: async (k: string) => map.delete(k),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => void (alarm = t),
    deleteAlarm: async () => void (alarm = null),
  }
}

export class RpcError {
  constructor(
    readonly message: string,
    readonly code = -32000,
    readonly data?: Hex,
  ) {}
}
export const TIMEOUT = Symbol('timeout')
/** A node that never answers: the request hangs until the caller aborts it, like a real stalled fetch. */
export const HANG = Symbol('hang')

type Handler = (params: unknown[], url: string) => unknown

/**
 * JSON-RPC chain behind a stubbed fetch. Every URL hits the same chain; per-URL behaviour (one node slow, another
 * refusing) goes through `onSend`. Return RpcError for an error response, TIMEOUT to throw like an aborted fetch,
 * HANG for a node that never answers.
 */
export class FakeChain {
  calls: { url: string; method: string; params: unknown[] }[] = []
  sent: { url: string; raw: Hex }[] = []
  receipts = new Map<string, Record<string, unknown>>()
  txs = new Map<string, Record<string, unknown>>()
  logs: Record<string, unknown>[] = []
  pendingNonce = 0
  latestNonce = 0
  baseFee = 250_000_000_000n
  onSend: (url: string, raw: Hex) => unknown = (_u, raw) => keccak256(raw)
  onCall: Handler = () => '0x'
  onEstimate: Handler = () => '0x4c2c0'
  extra: Record<string, Handler> = {}

  count(method: string) {
    return this.calls.filter(c => c.method === method).length
  }
  distinctSent() {
    return [...new Set(this.sent.map(s => s.raw))]
  }

  private handle(method: string, params: unknown[], url: string): unknown {
    if (this.extra[method]) return this.extra[method](params, url)
    switch (method) {
      case 'eth_chainId':
        return '0x89'
      case 'eth_blockNumber':
        return '0x2710'
      case 'eth_getBalance':
        return `0x${(5n * 10n ** 18n).toString(16)}`
      case 'eth_estimateGas':
        return this.onEstimate(params, url)
      case 'eth_call':
        return this.onCall(params, url)
      case 'eth_feeHistory':
        return {
          oldestBlock: '0x2710',
          baseFeePerGas: [`0x${this.baseFee.toString(16)}`, `0x${this.baseFee.toString(16)}`],
          gasUsedRatio: [0.5],
        }
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00'
      case 'eth_getTransactionCount':
        return `0x${(params[1] === 'pending' ? this.pendingNonce : this.latestNonce).toString(16)}`
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex
        this.sent.push({ url, raw })
        return this.onSend(url, raw)
      }
      case 'eth_getTransactionReceipt':
        return this.receipts.get(String(params[0])) ?? null
      case 'eth_getTransactionByHash':
        return this.txs.get(String(params[0])) ?? null
      case 'eth_getLogs':
        return this.logs
      default:
        return new RpcError(`unsupported ${method}`)
    }
  }

  fetch = async (input: unknown, init?: { body?: string; signal?: AbortSignal | null }) => {
    const url = String(input)
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] }
    this.calls.push({ url, method: req.method, params: req.params ?? [] })
    const out = await this.handle(req.method, req.params ?? [], url)
    if (out === HANG) {
      await new Promise((_, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'))
        if (init?.signal?.aborted) abort()
        init?.signal?.addEventListener('abort', abort)
      })
    }
    if (out === TIMEOUT) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (out instanceof RpcError)
      return Response.json({ jsonrpc: '2.0', id: req.id, error: { code: out.code, message: out.message, data: out.data } })
    return Response.json({ jsonrpc: '2.0', id: req.id, result: out })
  }

  /** Mines `hash` with a successful (or reverted) receipt. */
  mine(hash: Hex, ok = true, logs: unknown[] = []) {
    this.receipts.set(hash, {
      transactionHash: hash,
      status: ok ? '0x1' : '0x0',
      gasUsed: '0x4c2c0',
      effectiveGasPrice: '0x41314cf000',
      logs,
    })
  }
}

export const fakeDurableObjectModule = () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
})
