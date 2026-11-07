import type { Env } from '../env'
import { VERSION } from '../env'
import { GAS_POLICY } from '../relayer/gas'
import { polygonClient } from '../rpc/polygon'

/** Early warning only; relays stop at GAS_POLICY.floorWei, which is also what makes health not ok. */
const LOW_GAS_WEI = 1_000_000_000_000_000_000n // 1 POL
const MAX_INDEXER_LAG_MIN = 30
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/

async function relayerStatus(env: Env) {
  const address = env.RELAYER_ADDRESS?.trim()
  if (!address) return { relayer: null, ok: true }
  try {
    const bal = await polygonClient(env).getBalance({ address: address as `0x${string}` })
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

export async function health(env: Env) {
  const [r, indexer] = await Promise.all([relayerStatus(env), indexerStatus(env)])
  const indexerOk = !indexer.lastError && (indexer.lagMinutes === null || indexer.lagMinutes <= MAX_INDEXER_LAG_MIN)
  return { ok: r.ok && indexerOk, relayer: r.relayer, indexer, version: VERSION }
}
