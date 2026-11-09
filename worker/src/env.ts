import type { Relayer } from './relayer/Relayer'

export interface Env {
  DB: D1Database
  RELAYER: DurableObjectNamespace<Relayer>
  NIM_RPCS: string
  POLYGON_RPCS: string
  /** Nodes that serve eth_getLogs over a whole LOG_CHUNK_BLOCKS chunk, in order; unset means POLYGON_RPCS. */
  POLYGON_LOG_RPCS?: string
  RELAYER_ADDRESS: string
  /** Router override; empty falls back to the deployed address in @accrue/shared. */
  ROUTER_ADDRESS?: string
  /** Block the overriding ROUTER_ADDRESS was deployed in; its Supplied/Withdrawn logs are read from there. */
  ROUTER_DEPLOY_BLOCK?: string
  /** Cron cadence and job sizes (see src/scheduled.ts cronConfig); unset means the per-minute defaults. */
  CRON_EVERY_MIN?: string
  CRON_ONE_JOB_PER_RUN?: string
  CRON_TXS_PER_RUN?: string
  CRON_PAGES_PER_RUN?: string
  CRON_VERDICTS_PER_RUN?: string
  CRON_RATES_EVERY_MIN?: string
  /** Secret (wrangler secret / .dev.vars). The relayer's hot key. */
  RELAYER_KEY?: string
}

export const VERSION = '0.1.0'
