import { readFileSync } from 'node:fs'
import type { NimTx } from '@accrue/shared'
import type { NimSource } from '../src/indexer/scan'

export const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../../packages/shared/test/fixtures/${f}`, import.meta.url), 'utf8')) as { address: string; txs: NimTx[] }

/**
 * Replays a recorded reward-address history as the RPC would serve it at `head`: newest first,
 * 500 per page, `startAt` exclusive, unknown `startAt` -> empty page, confirmations from the head.
 */
export class FakeChain {
  head: number
  calls = 0
  failNext = 0
  constructor(
    readonly address: string,
    readonly txs: NimTx[],
    head?: number,
  ) {
    this.head = head ?? Math.max(...txs.map((t) => t.blockNumber))
  }
  visible() {
    return this.txs.filter((t) => t.blockNumber <= this.head)
  }
  page(address: string, startAt: string | null, size = 500): NimTx[] {
    if (address !== this.address) return []
    const list = this.visible()
    const i = startAt === null ? 0 : list.findIndex((t) => t.hash === startAt) + 1
    if (startAt !== null && i === 0) return []
    return list.slice(i, i + size).map((t) => ({ ...t, confirmations: this.head - t.blockNumber + 1 }) as NimTx)
  }
  source(delegations: Map<string, string> = new Map()): NimSource {
    return {
      txPage: async (address, startAt) => {
        this.calls++
        if (this.failNext > 0) {
          this.failNext--
          throw new Error('HTTP 503')
        }
        return this.page(address, startAt)
      },
      delegation: async (a) => delegations.get(a) ?? '',
      rewardAddress: async (v) => v,
    }
  }
}
