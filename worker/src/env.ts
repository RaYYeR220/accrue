export interface Env {
  DB: D1Database
  RELAYER: DurableObjectNamespace
  NIM_RPCS: string
  POLYGON_RPCS: string
  RELAYER_ADDRESS: string
}

export const VERSION = '0.1.0'
