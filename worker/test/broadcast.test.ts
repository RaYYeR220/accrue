import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcast } from '../src/relayer/broadcast'

type Answer = { error: { code: number; message: string } } | { result: string } | { http: number } | 'throw'

/** One node per answer, at https://n<i>.test. */
function nodes(answers: Answer[]) {
  vi.stubGlobal('fetch', async (url: string) => {
    const a = answers[Number(/n(\d+)/.exec(url)![1])]!
    if (a === 'throw') throw new DOMException('aborted', 'TimeoutError')
    if ('http' in a) return new Response('rate limited', { status: a.http })
    return Response.json({ jsonrpc: '2.0', id: 1, ...a })
  })
  return answers.map((_, i) => `https://n${i}.test`)
}
const err = (message: string, code = -32000): Answer => ({ error: { code, message } })

afterEach(() => vi.unstubAllGlobals())

describe('broadcast classification', () => {
  it.each([
    ['a hash', { result: `0x${'ab'.repeat(32)}` }, 'accepted'],
    ['already known', err('already known'), 'accepted'],
    ['nonce too low', err('nonce too low: next nonce 7, tx nonce 5'), 'nonce_low'],
    ['insufficient funds', err('insufficient funds for gas * price + value'), 'no_funds'],
    ['replacement underpriced', err('replacement transaction underpriced'), 'rejected'],
    ['underpriced', err('transaction underpriced'), 'rejected'],
    ['intrinsic gas', err('intrinsic gas too low'), 'rejected'],
    ['below base fee', err('max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2'), 'rejected'],
    ['fee cap', err('tx fee (2.00 ether) exceeds the configured cap (1.00 ether)'), 'rejected'],
    ['invalid sender', err('invalid sender'), 'rejected'],
    ['wrong chain', err('invalid chain id for signer: have 1 want 137'), 'rejected'],
    ['-32603 Request timeout', err('Request timeout', -32603), 'ambiguous'],
    ['-32005 limit exceeded', err('limit exceeded', -32005), 'ambiguous'],
    ['-32603 internal error', err('internal error', -32603), 'ambiguous'],
    ['HTTP 429', { http: 429 }, 'ambiguous'],
    ['network error', 'throw', 'ambiguous'],
  ] as [string, Answer, string][])('%s -> %s', async (_name, answer, outcome) => {
    expect(await broadcast(nodes([answer]), '0x02')).toBe(outcome)
  })

  it('combines nodes: any acceptance wins, any unknown makes a refusal ambiguous', async () => {
    expect(await broadcast(nodes([err('transaction underpriced'), { result: '0x1' }]), '0x02')).toBe('accepted')
    expect(await broadcast(nodes([err('transaction underpriced'), err('Request timeout', -32603)]), '0x02')).toBe('ambiguous')
    expect(await broadcast(nodes([err('transaction underpriced'), err('intrinsic gas too low')]), '0x02')).toBe('rejected')
  })
})
