import { decodeEventLog, encodeEventTopics, getAddress, numberToHex, type Address, type Hex, type PublicClient } from 'viem'
import { ASSETS, POLYGON, type AssetKey } from '@accrue/shared'
import type { Env } from '../env'
import { routerAbi, routerAddress } from '../relayer/chain'
import { polygonClient } from '../rpc/polygon'
import { bind, type Stmt } from './store'

// public Polygon RPCs refuse eth_getLogs over wider ranges (some at 2,000 blocks)
export const LOG_CHUNK_BLOCKS = 1_800
// the cron folds only blocks this far below the head; younger ones a request reads itself
export const SETTLE_BLOCKS = 64
const RAY = 10n ** 27n

export interface RouterEvent {
  kind: 'Supplied' | 'Withdrawn'
  owner: Address
  asset: AssetKey
  amount: bigint
  index: bigint
  block: number
  logIndex: number
}

/** What Accrue put into Aave for one owner and asset: the scaled balance it minted, and what was paid in. */
export interface Holding {
  scaled: bigint
  principal: bigint
}
export type Holdings = Partial<Record<AssetKey, Holding>>

const ASSET_BY_ADDRESS = new Map((Object.keys(ASSETS) as AssetKey[]).map((k) => [ASSETS[k].address.toLowerCase(), k]))

// Aave's rayDiv (half up): the scaled amount a supply mints or a withdraw burns at `index`
const rayDiv = (a: bigint, b: bigint) => (a * RAY + b / 2n) / b

/**
 * Folds one router event into an owner's holdings, in block order. A supply adds its scaled amount
 * and its principal; a withdraw burns scaled balance and takes principal off in the same proportion
 * (average cost), so `earned` stays the interest on what is still in Aave.
 */
export function applyEvent(h: Holdings, e: RouterEvent): Holdings {
  const cur = h[e.asset] ?? { scaled: 0n, principal: 0n }
  if (e.kind === 'Supplied') {
    h[e.asset] = { scaled: cur.scaled + rayDiv(e.amount, e.index), principal: cur.principal + e.amount }
  } else if (cur.scaled > 0n) {
    const burned = rayDiv(e.amount, e.index)
    const b = burned > cur.scaled ? cur.scaled : burned
    h[e.asset] = { scaled: cur.scaled - b, principal: cur.principal - (cur.principal * b) / cur.scaled }
  }
  return h
}

export function holdingsFromJson(raw: string | null | undefined): Holdings {
  const out: Holdings = {}
  if (!raw) return out
  try {
    const o = JSON.parse(raw) as Record<string, { scaled?: string; principal?: string }>
    for (const k of Object.keys(ASSETS) as AssetKey[]) {
      const v = o[k]
      if (v && /^\d+$/.test(v.scaled ?? '') && /^\d+$/.test(v.principal ?? '')) out[k] = { scaled: BigInt(v.scaled!), principal: BigInt(v.principal!) }
    }
  } catch {
    // an unreadable row reads as empty; the next event rewrites it
  }
  return out
}

export const holdingsToJson = (h: Holdings) =>
  JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { scaled: v.scaled.toString(), principal: v.principal.toString() }])))

export const scanKey = (router: Address) => `router_scan:${router.toLowerCase()}`
export const holdingsKey = (router: Address, owner: Address) => `router_pos:${router.toLowerCase()}:${owner.toLowerCase()}`

/** The block the router was deployed in: `ROUTER_DEPLOY_BLOCK` with an overridden router, else deployments.json. */
export function deployBlock(env: Pick<Env, 'ROUTER_ADDRESS' | 'ROUTER_DEPLOY_BLOCK'>): number | null {
  const raw = env.ROUTER_DEPLOY_BLOCK?.trim()
  if (raw && /^\d+$/.test(raw)) return Number(raw)
  return env.ROUTER_ADDRESS?.trim() ? null : POLYGON.deployBlock
}

const EVENT_TOPICS = [
  encodeEventTopics({ abi: routerAbi, eventName: 'Supplied' })[0],
  encodeEventTopics({ abi: routerAbi, eventName: 'Withdrawn' })[0],
] as Hex[]

/**
 * Supplied/Withdrawn logs of the router between two blocks, in chunks of LOG_CHUNK_BLOCKS (all
 * requested at once), optionally for one owner, in block order.
 */
export async function routerEvents(client: PublicClient, router: Address, from: number, to: number, owner?: Address): Promise<RouterEvent[]> {
  const ranges: [number, number][] = []
  for (let a = from; a <= to; a += LOG_CHUNK_BLOCKS) ranges.push([a, Math.min(to, a + LOG_CHUNK_BLOCKS - 1)])
  const ownerTopic = owner ? (encodeEventTopics({ abi: routerAbi, eventName: 'Supplied', args: { owner } })[1] as Hex) : null
  const pages = await Promise.all(
    ranges.map(([a, b]) =>
      client.request({
        method: 'eth_getLogs',
        params: [{ address: router, topics: ownerTopic ? [EVENT_TOPICS, ownerTopic] : [EVENT_TOPICS], fromBlock: numberToHex(a), toBlock: numberToHex(b) }],
      }),
    ),
  )
  const out: RouterEvent[] = []
  for (const log of pages.flat()) {
    if (log.removed || log.address.toLowerCase() !== router.toLowerCase()) continue
    const d = decodeEventLog({ abi: routerAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data })
    if (d.eventName !== 'Supplied' && d.eventName !== 'Withdrawn') continue
    const args = d.args as { owner: Address; asset: Address; amount: bigint; index: bigint }
    const asset = ASSET_BY_ADDRESS.get(args.asset.toLowerCase())
    if (!asset || args.index <= 0n) continue
    out.push({ kind: d.eventName, owner: getAddress(args.owner), asset, amount: args.amount, index: args.index, block: Number(log.blockNumber), logIndex: Number(log.logIndex) })
  }
  return out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

export interface RouterScan {
  skipped?: boolean
  from?: number
  to?: number
  events?: number
  error?: string
}

/**
 * Cron step: folds the router's logs (every owner) from where the last scan stopped up to
 * SETTLE_BLOCKS below the head, at most `maxChunks` chunks, into one meta row per owner, and moves
 * the scan cursor in the same D1 batch. Nothing moves unless the whole range was read.
 */
export async function scanRouterLogs(env: Env, opts: { maxChunks?: number } = {}): Promise<RouterScan> {
  const router = routerAddress(env)
  const first = deployBlock(env)
  if (!router || first === null) return { skipped: true }
  try {
    const client = polygonClient(env)
    const [cursorRow, head] = await Promise.all([
      env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(scanKey(router)).first<{ value: string }>(),
      client.getBlockNumber({ cacheTime: 0 }),
    ])
    const from = cursorRow ? Number(cursorRow.value) + 1 : first
    const to = Math.min(Number(head) - SETTLE_BLOCKS, from + (opts.maxChunks ?? 3) * LOG_CHUNK_BLOCKS - 1)
    if (to < from) return { from, to, events: 0 }
    const events = await routerEvents(client, router, from, to)
    // every write holds only while the cursor is still the one read here: two overlapping runs never
    // fold the same events twice (the cursor write comes last and moves the guard)
    const guarded = (key: string, value: string): Stmt => ({
      sql:
        'INSERT INTO meta (key, value, updated_at) SELECT ?, ?, ? WHERE (SELECT value FROM meta WHERE key = ?) IS ? ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      params: [key, value, Date.now(), scanKey(router), cursorRow?.value ?? null],
    })
    const writes: Stmt[] = []
    if (events.length) {
      const owners = [...new Set(events.map((e) => e.owner))]
      const rows = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${owners.map(() => '?').join(', ')})`)
        .bind(...owners.map((o) => holdingsKey(router, o)))
        .all<{ key: string; value: string }>()
      const stored = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
      const holdings = new Map(owners.map((o) => [o, holdingsFromJson(stored.get(holdingsKey(router, o)))]))
      for (const e of events) applyEvent(holdings.get(e.owner)!, e)
      for (const [o, h] of holdings) writes.push(guarded(holdingsKey(router, o), holdingsToJson(h)))
    }
    writes.push(guarded(scanKey(router), String(to)))
    await env.DB.batch(bind(env.DB, writes))
    return { from, to, events: events.length }
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}
