import type { Env } from '../env'
import { VERSION } from '../env'
import { GAS_POLICY } from '../relayer/gas'
import { polygonReadClient } from '../rpc/polygon'
import { routerConfig, scanKey } from '../indexer/router'

/** Early warning only; relays stop at GAS_POLICY.floorWei, which is also what makes health not ok. */
const LOW_GAS_WEI = 1_000_000_000_000_000_000n // 1 POL
const MAX_INDEXER_LAG_MIN = 30
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/

async function relayerStatus(env: Env) {
  const address = env.RELAYER_ADDRESS?.trim()
  if (!address) return { relayer: null, ok: true }
  try {
    const bal = await polygonReadClient(env).getBalance({ address: address as `0x${string}` })
    return {
      relayer: { address, polBalance: bal.toString(), low: bal < LOW_GAS_WEI },
      ok: bal >= GAS_POLICY.floorWei,
    }
  } catch {
    return { relayer: { address, polBalance: null, low: false, error: 'rpc_unavailable' }, ok: false }
  }
}

async function indexerStatus(env: Env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value, updated_at FROM meta WHERE key IN ('indexer_last_ok','indexer_last_error')",
    ).all<{ key: string; value: string; updated_at: number }>()
    const ok = results.find(r => r.key === 'indexer_last_ok')
    const err = results.find(r => r.key === 'indexer_last_error')
    // An error the indexer has since recovered from is history, not status.
    const current = err?.value && (!ok || err.updated_at >= ok.updated_at) ? err.value : null
    return {
      lagMinutes: ok ? Math.max(0, Math.round((Date.now() - ok.updated_at) / 60000)) : null,
      // Stored codes pass through; anything free-text could leak internals, so it is masked.
      lastError: current === null ? null : CODE_RE.test(current) ? current : 'indexer_error',
    }
  } catch {
    return { lagMinutes: null, lastError: 'db_error' }
  }
}

/**
 * The router and how far the cron's fold of its logs is behind: blocks between the last folded one
 * and the head (null when either cannot be read), and minutes since the fold last moved (null before
 * the first fold). A router whose deploy block is unknown cannot have its logs read: /api/position
 * answers 503 for it.
 */
async function routerStatus(env: Env) {
  const cfg = routerConfig(env)
  if (!cfg) return null
  if (cfg.misconfigured) return 'misconfigured' as const
  const readCursor = async () => {
    try {
      const row = await env.DB.prepare('SELECT value, updated_at FROM meta WHERE key = ?').bind(scanKey(cfg.router)).first<{ value: string; updated_at: number }>()
      return row ?? ('none' as const)
    } catch {
      return null
    }
  }
  const readHead = async () => {
    try {
      return Number(await polygonReadClient(env, { timeoutMs: 2_500 }).getBlockNumber({ cacheTime: 0 }))
    } catch {
      return null
    }
  }
  const [cursor, head] = await Promise.all([readCursor(), readHead()])
  const folded = cursor === null ? null : cursor === 'none' ? (cfg.deployBlock as number) - 1 : Number(cursor.value)
  return {
    address: cfg.router,
    deployBlock: cfg.deployBlock,
    lagBlocks: head === null || folded === null ? null : Math.max(0, head - folded),
    lagMinutes: cursor && cursor !== 'none' ? Math.max(0, Math.round((Date.now() - cursor.updated_at) / 60_000)) : null,
  }
}

export async function health(env: Env) {
  const [r, indexer, router] = await Promise.all([relayerStatus(env), indexerStatus(env), routerStatus(env)])
  const indexerOk = !indexer.lastError && (indexer.lagMinutes === null || indexer.lagMinutes <= MAX_INDEXER_LAG_MIN)
  return { ok: r.ok && indexerOk && router !== 'misconfigured', relayer: r.relayer, router, indexer, version: VERSION }
}
