import type { Env } from '../env'

const TIMEOUT_MS = 4000

export class RpcUnavailable extends Error {
  constructor(method: string, readonly causes: string[]) {
    super(`all Nimiq RPC servers failed for ${method}: ${causes.join('; ')}`)
    this.name = 'RpcUnavailable'
  }
}

export function nimUrls(env: Pick<Env, 'NIM_RPCS'>): string[] {
  return env.NIM_RPCS.split(',').map(s => s.trim()).filter(Boolean)
}

/** Calls a Nimiq JSON-RPC method, trying each configured server in order. Returns `result.data`. */
export async function nimRpc<T>(env: Pick<Env, 'NIM_RPCS'>, method: string, params: unknown[]): Promise<T> {
  const causes: string[] = []
  for (const url of nimUrls(env)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        causes.push(`${url} HTTP ${res.status}`)
        continue
      }
      const body = (await res.json()) as { result?: { data?: T } | null; error?: { message?: string; data?: unknown } }
      if (body.error) {
        // the detail ("No staker with address ...") is in `data`; callers need it to tell a
        // negative answer from a server fault
        const detail = typeof body.error.data === 'string' ? `: ${body.error.data}` : ''
        causes.push(`${url} ${body.error.message ?? 'rpc error'}${detail}`)
        continue
      }
      const data = body.result?.data
      if (data === undefined || data === null) {
        causes.push(`${url} empty result`)
        continue
      }
      return data
    } catch (e) {
      causes.push(`${url} ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new RpcUnavailable(method, causes)
}
