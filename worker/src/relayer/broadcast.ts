import type { Hex } from 'viem'

/**
 * - accepted: at least one node took the tx (or already had it).
 * - ambiguous: no node confirmed it, but at least one may have it: a timeout, an HTTP error, a garbled answer or
 *   any JSON-RPC error that is not a known refusal (proxies report their own trouble, e.g. -32603 "Request timeout",
 *   while the tx may already be on its way).
 * - nonce_low / no_funds / rejected: every node answered, and each one refused for a reason that means the tx
 *   itself will never be taken in this form.
 */
export type SendOutcome = 'accepted' | 'ambiguous' | 'nonce_low' | 'no_funds' | 'rejected'

const ALREADY = /already known|known transaction|already imported|already exists|already in mempool/i
const NONCE_LOW = /nonce too low|nonce has already been used|nonce_expired|oldnonce|nonce is too low/i
const NO_FUNDS = /insufficient funds/i
const REFUSED =
  /underpriced|intrinsic gas too low|less than block base fee|fee cap|exceeds the configured cap|exceeds block gas limit|gas limit reached|invalid sender|invalid chain ?id|chain ?id mismatch|replay-protected/i

type NodeAnswer = 'accepted' | 'unknown' | 'nonce_low' | 'no_funds' | 'rejected'

async function sendTo(url: string, raw: Hex, timeoutMs: number): Promise<NodeAnswer> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (typeof body.result === 'string') return 'accepted'
    const msg = body.error?.message ?? ''
    if (!body.error) return 'unknown'
    if (ALREADY.test(msg)) return 'accepted'
    if (NONCE_LOW.test(msg)) return 'nonce_low'
    if (NO_FUNDS.test(msg)) return 'no_funds'
    if (REFUSED.test(msg)) return 'rejected'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Sends a signed tx to every configured node at once and reports the combined outcome. Unlike viem's fallback
 * transport, which only surfaces the last node's error, this keeps "node A may have it" visible.
 */
export async function broadcast(urls: string[], raw: Hex, timeoutMs = 4000): Promise<SendOutcome> {
  const answers = await Promise.all(urls.map(u => sendTo(u, raw, timeoutMs)))
  if (answers.includes('accepted')) return 'accepted'
  if (answers.includes('unknown') || answers.length === 0) return 'ambiguous'
  if (answers.includes('nonce_low')) return 'nonce_low'
  if (answers.includes('no_funds')) return 'no_funds'
  return 'rejected'
}
