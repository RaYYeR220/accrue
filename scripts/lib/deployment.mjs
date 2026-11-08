// Shared by collect-results.mjs and verify-onchain.mjs: the deployment record, Polygon reads and the
// Sourcify rule, so both scripts read the same transactions and check them by the same rules.
//
// packages/shared/src/deployments.json   { "router": "0x…" | null, "deployBlock": n | null }
// contracts/deployments/polygon.json     { "router", "block", "txHash", "codeHash"?, "txs": { "<label>": "0x…", … } }
//
// Only `txHash` (the deployment) and the values of `txs` are read as transactions; every other field,
// such as `codeHash` or a block hash, is never fetched as one.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const POLYGON_RPCS = process.env.POLYGON_RPC
  ? [process.env.POLYGON_RPC]
  : ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic']

// Polygon mainnet constants, the same as contracts/script/Polygon.sol
export const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
export const RESERVES = [
  { symbol: 'USDT0', asset: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', aToken: '0x6ab707Aca953eDAeFBc4fD23bA73294241490620' },
  { symbol: 'USDC', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', aToken: '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD' },
]

// topic0 of AccrueRouter's events; both carry the owner as their first indexed topic
export const ROUTER_EVENTS = {
  '0x2b650c94fbe31b46ae7946bf007a115a23c6e4532d75ad025261819304334598': 'Supplied',
  '0x91fb9d98b786c57d74c099ccd2beca1739e9f6a81fb49001ca465c4b7591bbe2': 'Withdrawn',
}

// Sourcify v2 `match` values that mean the source is verified
export const SOURCIFY_VERIFIED = ['exact_match', 'match', 'perfect', 'partial']

const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// viem comes from the workspace (packages/shared depends on it); only its hashing and ABI helpers are used
export async function loadViem(root) {
  try {
    const req = createRequire(join(root, 'packages/shared/package.json'))
    return await import(pathToFileURL(req.resolve('viem')).href)
  } catch {
    throw new Error('viem not found: run `pnpm install` first')
  }
}

/**
 * The deployment as recorded. `problems` lists what is malformed or inconsistent (a bad address, a
 * record for another router or block, a transaction field that is not a hash); callers report them.
 */
export function readDeployment(root) {
  const dep = JSON.parse(readFileSync(join(root, 'packages/shared/src/deployments.json'), 'utf8'))
  const recordPath = 'contracts/deployments/polygon.json'
  const record = existsSync(join(root, recordPath)) ? JSON.parse(readFileSync(join(root, recordPath), 'utf8')) : null
  const problems = []
  const router = dep.router ?? null
  if (router !== null && !ADDRESS.test(String(router))) problems.push(`deployments.json router "${router}" is not an address`)
  const txs = []
  if (record) {
    if (!same(record.router, router)) problems.push(`${recordPath} router ${record.router} is not deployments.json's ${router}`)
    if (record.block !== undefined && dep.deployBlock !== undefined && dep.deployBlock !== null && Number(record.block) !== Number(dep.deployBlock)) {
      problems.push(`${recordPath} block ${record.block} is not deployments.json's deployBlock ${dep.deployBlock}`)
    }
    if (record.txHash !== undefined) {
      if (HASH.test(String(record.txHash))) txs.push({ label: 'deployment', hash: record.txHash, deployment: true })
      else problems.push(`${recordPath} txHash "${record.txHash}" is not a transaction hash`)
    }
    for (const [label, hash] of Object.entries(record.txs ?? {})) {
      if (HASH.test(String(hash))) txs.push({ label, hash, deployment: false })
      else problems.push(`${recordPath} txs.${label} "${hash}" is not a transaction hash`)
    }
    if (record.codeHash !== undefined && !HASH.test(String(record.codeHash))) problems.push(`${recordPath} codeHash "${record.codeHash}" is not a 32-byte hash`)
  }
  return { router, deployBlock: dep.deployBlock ?? null, recordPath, record, codeHash: record?.codeHash ?? null, txs, problems }
}

/** JSON-RPC over the given endpoints in turn. An error answer is final; transport failures move on. */
export async function rpc(urls, method, params) {
  let last
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json()
      if (body.error) {
        const err = new Error(`${body.error.message}${body.error.data ? `: ${body.error.data}` : ''}`)
        err.rpc = body.error
        throw err
      }
      return body.result
    } catch (e) {
      last = e
      if (e.rpc) throw e
    }
  }
  throw last
}
export const polygon = (method, params) => rpc(POLYGON_RPCS, method, params)

/** Sourcify's `match` for the router on chain 137, or 'none'. */
export async function sourcifyMatch(router) {
  const res = await fetch(`https://sourcify.dev/server/v2/contract/137/${router}`, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return 'none'
  if (!res.ok) throw new Error(`Sourcify answered HTTP ${res.status}`)
  const body = await res.json()
  return String(body.match ?? body.runtimeMatch ?? 'none')
}

/** Runtime code with the immutable slots blanked, so a local build compares to deployed code. */
export function maskedCode(hex, immutableReferences) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length)
  }
  return bytes
}

/** The local forge build of the router, or null before `forge build`. */
export function routerArtifact(root) {
  const p = join(root, 'contracts/out/AccrueRouter.sol/AccrueRouter.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).deployedBytecode : null
}

const word = (addr) => addr.slice(2).toLowerCase().padStart(64, '0')
const addrAt = (data, i) => `0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`

/**
 * POOL() and aTokenOf(asset) of the router against the aTokens Aave's registry lists
 * (Pool.getReserveData(asset).aTokenAddress, the 9th word). A contract without these views reverts.
 */
export async function routerWiring(router) {
  const pool = addrAt(await polygon('eth_call', [{ to: router, data: '0x7535d246' }, 'latest']), 0)
  const reserves = []
  for (const r of RESERVES) {
    const aToken = addrAt(await polygon('eth_call', [{ to: router, data: `0x144f4dce${word(r.asset)}` }, 'latest']), 0)
    const registered = addrAt(await polygon('eth_call', [{ to: AAVE_POOL, data: `0x35ea6a75${word(r.asset)}` }, 'latest']), 8)
    reserves.push({ ...r, routerATokenOf: aToken, registered, ok: same(aToken, r.aToken) && same(aToken, registered) })
  }
  return { pool, poolOk: same(pool, AAVE_POOL), reserves, ok: same(pool, AAVE_POOL) && reserves.every((r) => r.ok) }
}

/** A recorded transaction read back: block, time, sender, and the router's events with their owners. */
export async function readTx(tx, router) {
  const receipt = await polygon('eth_getTransactionReceipt', [tx.hash])
  if (!receipt) return { ...tx, found: false }
  const block = await polygon('eth_getBlockByNumber', [receipt.blockNumber, false])
  const events = receipt.logs
    .filter((l) => same(l.address, router) && ROUTER_EVENTS[l.topics[0]])
    .map((l) => ({ name: ROUTER_EVENTS[l.topics[0]], owner: `0x${l.topics[1].slice(26)}` }))
  return {
    ...tx,
    found: true,
    ok: receipt.status === '0x1',
    block: Number(BigInt(receipt.blockNumber)),
    time: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    from: receipt.from.toLowerCase(),
    created: receipt.contractAddress ? receipt.contractAddress.toLowerCase() : null,
    events,
  }
}
