import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

export class Relayer extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
