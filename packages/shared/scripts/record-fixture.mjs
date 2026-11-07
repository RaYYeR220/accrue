// One-off: node scripts/record-fixture.mjs <address> <out.json> [min]
import { writeFileSync } from 'node:fs'

const RPC = 'https://rpc.nimiqwatch.com'
const [address, out, minArg] = process.argv.slice(2)
const min = Number(minArg ?? 2000)

async function page(startAt) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsByAddress', params: [address, 500, startAt] }),
      })
      if (r.ok) {
        const j = await r.json()
        const d = j?.result?.data
        if (Array.isArray(d) && d.length) return d
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i))
  }
  return []
}

const txs = []
let cursor = null
while (txs.length < min) {
  const d = await page(cursor)
  if (!d.length) break
  for (const t of d) {
    delete t.proof
    txs.push(t)
  }
  cursor = d[d.length - 1].hash
  console.error(txs.length)
}
writeFileSync(out, JSON.stringify({ address, recordedAt: '2026-11-07', txs }))
console.error('saved', txs.length)
