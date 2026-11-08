import type { Relayer } from './relayer/Relayer'

export interface Env {
  DB: D1Database
  RELAYER: DurableObjectNamespace<Relayer>
  NIM_RPCS: string
  POLYGON_RPCS: string
  RELAYER_ADDRESS: string
  /** Router override; empty falls back to the deployed address in @accrue/shared. */
  ROUTER_ADDRESS?: string
  /** Block the overriding ROUTER_ADDRESS was deployed in; its Supplied/Withdrawn logs are read from there. */
  ROUTER_DEPLOY_BLOCK?: string
  /** Secret (wrangler secret / .dev.vars). The relayer's hot key. */
  RELAYER_KEY?: string
}

export const VERSION = '0.1.0'
