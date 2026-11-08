import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { polygon } from 'viem/chains'
import type { Env } from '../env'

export function polygonUrls(env: Pick<Env, 'POLYGON_RPCS'>): string[] {
  return env.POLYGON_RPCS.split(',').map(s => s.trim()).filter(Boolean)
}

export function polygonClient(env: Pick<Env, 'POLYGON_RPCS'>): PublicClient {
  const transports = polygonUrls(env).map(url => http(url, { timeout: 4000, retryCount: 0 }))
  return createPublicClient({ chain: polygon, transport: fallback(transports, { retryCount: 0 }) }) as PublicClient
}
