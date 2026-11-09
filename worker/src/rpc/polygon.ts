import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { polygon } from 'viem/chains'
import type { Env } from '../env'

const split = (raw: string | undefined) => (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)

export function polygonUrls(env: Pick<Env, 'POLYGON_RPCS'>): string[] {
  return split(env.POLYGON_RPCS)
}

// Several public nodes cap eth_getLogs ranges (1rpc at 50 blocks), so router logs go to the nodes in
// POLYGON_LOG_RPCS that serve whole chunks; unset, the general list.
export function polygonLogUrls(env: Pick<Env, 'POLYGON_RPCS' | 'POLYGON_LOG_RPCS'>): string[] {
  const logs = split(env.POLYGON_LOG_RPCS)
  return logs.length ? logs : polygonUrls(env)
}

export interface ClientOpts {
  /** per node; once it passes, the next node is asked */
  timeoutMs?: number
  urls?: string[]
}

export function polygonClient(env: Pick<Env, 'POLYGON_RPCS'>, opts: ClientOpts = {}): PublicClient {
  const transports = (opts.urls ?? polygonUrls(env)).map(url => http(url, { timeout: opts.timeoutMs ?? 4000, retryCount: 0 }))
  return createPublicClient({ chain: polygon, transport: fallback(transports, { retryCount: 0 }) }) as PublicClient
}

export const polygonLogClient = (env: Pick<Env, 'POLYGON_RPCS' | 'POLYGON_LOG_RPCS'>, opts: Omit<ClientOpts, 'urls'> = {}) =>
  polygonClient(env, { ...opts, urls: polygonLogUrls(env) })
