import type { Env } from '../env'
import { VERSION } from '../env'
import { polygonClient } from '../rpc/polygon'

const LOW_GAS_WEI = 1_000_000_000_000_000_000n // 1 POL

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function relayerStatus(env: Env) {
  const address = env.RELAYER_ADDRESS?.trim()
  if (!address) return null
  try {
    const bal = await polygonClient(env).getBalance({ address: address as `0x${string}` })
    return { address, polBalance: bal.toString(), low: bal < LOW_GAS_WEI }
  } catch (e) {
    return { address, polBalance: null, low: false, error: msg(e) }
  }
}

async function indexerStatus(env: Env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value, updated_at FROM meta WHERE key IN ('indexer_last_ok','indexer_last_error')",
    ).all<{ key: string; value: string; updated_at: number }>()
    const ok = results.find(r => r.key === 'indexer_last_ok')
    const err = results.find(r => r.key === 'indexer_last_error')
    return {
      lagMinutes: ok ? Math.max(0, Math.round((Date.now() - ok.updated_at) / 60000)) : null,
      lastError: err?.value || null,
    }
  } catch (e) {
    return { lagMinutes: null, lastError: msg(e) }
  }
}

export async function health(env: Env) {
  const [relayer, indexer] = await Promise.all([relayerStatus(env), indexerStatus(env)])
  const ok = !(relayer && (relayer.low || 'error' in relayer)) && !indexer.lastError
  return { ok, relayer, indexer, version: VERSION }
}
