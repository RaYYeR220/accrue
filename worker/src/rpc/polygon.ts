import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { polygon } from 'viem/chains'
import type { Env } from '../env'

const split = (raw: string | undefined) => (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)

export function polygonUrls(env: Pick<Env, 'POLYGON_RPCS'>): string[] {
  return split(env.POLYGON_RPCS)
}

// The API's own reads (router logs, positions, Aave, health) go to POLYGON_READ_RPCS in the order that
// answers fastest from Cloudflare; unset, POLYGON_RPCS, which the relayer keeps for its own reads and
// broadcasts.
export function polygonReadUrls(env: Pick<Env, 'POLYGON_RPCS' | 'POLYGON_READ_RPCS'>): string[] {
  const reads = split(env.POLYGON_READ_RPCS)
  return reads.length ? reads : polygonUrls(env)
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

export const polygonReadClient = (env: Pick<Env, 'POLYGON_RPCS' | 'POLYGON_READ_RPCS'>, opts: Omit<ClientOpts, 'urls'> = {}) =>
  polygonClient(env, { ...opts, urls: polygonReadUrls(env) })
