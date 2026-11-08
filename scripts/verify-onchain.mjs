#!/usr/bin/env node
// Checks the public claims that live outside this repository against the chains and the live app,
// and prints one PASS / FAIL / PENDING line per check:
//
//   Polygon   the router in packages/shared/src/deployments.json: code at the address, the same
//             runtime code as contracts/src builds to, wired to Aave's own registry, source
//             verified on Sourcify, and every transaction recorded in contracts/deployments/polygon.json
//   app       the live pool scoreboard and the indexer's lag at <origin>/api/*
//   Nimiq     the testnet staking transactions in evidence/nimiq-testnet-staking.json
//
// PENDING means there is nothing to check yet (the router is not deployed); it is not a failure.
// Exit code 1 on any FAIL.
//
//   pnpm install && node scripts/verify-onchain.mjs
//   POLYGON_RPC=<url> ACCRUE_ORIGIN=<url> node scripts/verify-onchain.mjs

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

// viem comes from the workspace (packages/shared depends on it); only its hashing and ABI helpers are used
let viem
try {
  const req = createRequire(join(ROOT, 'packages/shared/package.json'))
  viem = await import(pathToFileURL(req.resolve('viem')).href)
} catch {
  console.error('viem not found: run `pnpm install` first')
  process.exit(2)
}
const { keccak256, encodeFunctionData, decodeFunctionResult, getAddress, toEventSelector } = viem

const ORIGIN = (process.env.ACCRUE_ORIGIN || 'https://accrue.pages.dev').replace(/\/+$/, '')
const POLYGON_RPCS = process.env.POLYGON_RPC
  ? [process.env.POLYGON_RPC]
  : ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic']
const MAX_LAG_MIN = 60

// Polygon mainnet constants, the same as contracts/script/Polygon.sol
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const RESERVES = [
  { symbol: 'USDT0', asset: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', aToken: '0x6ab707Aca953eDAeFBc4fD23bA73294241490620' },
  { symbol: 'USDC', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', aToken: '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD' },
]
const VERDICTS = new Set(['PAID_AS_PROMISED', 'BEHIND_SCHEDULE', 'SHORT', 'NOT_ENOUGH_DATA', 'NO_PAYOUTS_BY_DESIGN', 'CANT_VERIFY_ROUTED'])

const ROUTER_ABI = [
  { type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'aTokenOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
]
const SUPPLIED = toEventSelector('Supplied(address,address,uint256,uint256)')
const WITHDRAWN = toEventSelector('Withdrawn(address,address,uint256,uint256)')

const counts = { PASS: 0, FAIL: 0, PENDING: 0, SKIP: 0 }
function line(status, text) {
  counts[status]++
  console.log(`${status.padEnd(7)} ${text}`)
}
const pass = (t) => line('PASS', t)
const fail = (t) => line('FAIL', t)
const pending = (t) => line('PENDING', t)
const skip = (t) => line('SKIP', t)
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const utc = (sec) => new Date(Number(sec) * 1000).toISOString().replace('.000Z', 'Z')

async function rpc(urls, method, params) {
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
      // an answer from the node is final; only transport problems move on to the next node
      if (e.rpc) throw e
    }
  }
  throw last
}
const polygon = (method, params) => rpc(POLYGON_RPCS, method, params)

async function call(to, abi, name, args = []) {
  const data = encodeFunctionData({ abi, functionName: name, args })
  const out = await polygon('eth_call', [{ to, data }, 'latest'])
  return decodeFunctionResult({ abi, functionName: name, data: out })
}

// Runtime code with the immutable slots blanked, so a local build compares to deployed code.
function masked(hex, immutableReferences) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length)
  }
  return bytes
}

// Every 32-byte hash in polygon.json, keyed by where it sits (txHash = the deployment).
function recordedTxs(node, path = []) {
  if (typeof node === 'string') return /^0x[0-9a-fA-F]{64}$/.test(node) ? [{ label: path.join('.'), hash: node }] : []
  if (Array.isArray(node)) return node.flatMap((v, i) => recordedTxs(v, [...path, node[i]?.label ?? String(i)]))
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => (k === 'label' ? [] : recordedTxs(v, [...path, k])))
  }
  return []
}

async function guard(label, fn) {
  try {
    await fn()
  } catch (e) {
    fail(`${label}: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------------------------

async function checkRouter() {
  console.log('\nPolygon: router')
  const dep = readJson('packages/shared/src/deployments.json')
  if (!dep.router) {
    pending('router not deployed yet: packages/shared/src/deployments.json has router null, so there is nothing on Polygon to check')
    return
  }
  const router = getAddress(dep.router)
  const recordPath = 'contracts/deployments/polygon.json'
  const record = existsSync(join(ROOT, recordPath)) ? readJson(recordPath) : null

  await guard('router code', async () => {
    const code = await polygon('eth_getCode', [router, 'latest'])
    if (!code || code === '0x') return fail(`no code at ${router}`)
    const hash = keccak256(code)
    pass(`code at ${router}: ${(code.length - 2) / 2} bytes, keccak256 ${hash}`)
    if (record?.codeHash) {
      if (same(record.codeHash, hash)) pass(`code hash equals the one recorded in ${recordPath}`)
      else fail(`code hash ${hash} differs from ${record.codeHash} recorded in ${recordPath}`)
    }
    const artifactPath = join(ROOT, 'contracts/out/AccrueRouter.sol/AccrueRouter.json')
    if (!existsSync(artifactPath)) {
      skip('no local build to compare: run `forge build` in contracts/ first')
      return
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
    const refs = artifact.deployedBytecode?.immutableReferences
    const local = masked(artifact.deployedBytecode.object, refs)
    const live = masked(code, refs)
    if (local.equals(live)) pass('runtime code equals the local build of contracts/src (immutable slots aside)')
    else fail('runtime code differs from the local build of contracts/src')
  })

  await guard('router wiring', async () => {
    const pool = await call(router, ROUTER_ABI, 'POOL')
    if (same(pool, AAVE_POOL)) pass(`POOL() is the Aave v3 pool ${AAVE_POOL}`)
    else fail(`POOL() is ${pool}, expected ${AAVE_POOL}`)
    for (const r of RESERVES) {
      const aToken = await call(router, ROUTER_ABI, 'aTokenOf', [r.asset])
      // Pool.getReserveData(asset): aTokenAddress is the 9th word of the returned struct
      const data = await polygon('eth_call', [{ to: AAVE_POOL, data: `0x35ea6a75${r.asset.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'])
      const registered = getAddress(`0x${data.slice(2 + 8 * 64 + 24, 2 + 9 * 64)}`)
      if (same(aToken, r.aToken) && same(aToken, registered)) pass(`aTokenOf(${r.symbol}) is ${aToken}, the aToken Aave's registry lists for it`)
      else fail(`aTokenOf(${r.symbol}) is ${aToken}; expected ${r.aToken}, registry lists ${registered}`)
    }
  })

  await guard('Sourcify', async () => {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/137/${router}`, { signal: AbortSignal.timeout(20_000) })
    if (res.status === 404) return fail(`source not verified on Sourcify (chain 137, ${router})`)
    if (!res.ok) throw new Error(`Sourcify answered HTTP ${res.status}`)
    const body = await res.json()
    const match = body.match ?? body.runtimeMatch ?? body.status
    if (match === 'exact_match' || match === 'match' || match === 'perfect' || match === 'partial') pass(`source verified on Sourcify: ${match}`)
    else fail(`Sourcify has no match for ${router} (${JSON.stringify(match)})`)
  })

  if (!record) {
    pending(`no transactions recorded yet in ${recordPath}`)
    return
  }
  for (const { label, hash } of recordedTxs(record)) {
    await guard(`${label} ${hash}`, async () => {
      const receipt = await polygon('eth_getTransactionReceipt', [hash])
      if (!receipt) return fail(`${label}: no receipt for ${hash}`)
      const block = await polygon('eth_getBlockByNumber', [receipt.blockNumber, false])
      const when = utc(BigInt(block.timestamp))
      const blockNo = Number(BigInt(receipt.blockNumber))
      if (receipt.status !== '0x1') return fail(`${label}: ${hash} reverted (block ${blockNo})`)
      if (label === 'txHash') {
        const created = same(receipt.contractAddress, router)
        const atBlock = !dep.deployBlock || Number(dep.deployBlock) === blockNo
        if (created && atBlock) pass(`deployment ${hash} created ${router} in block ${blockNo}, ${when}`)
        else fail(`deployment ${hash}: created ${receipt.contractAddress} in block ${blockNo}; expected ${router} in block ${dep.deployBlock}`)
        return
      }
      // Supplied / Withdrawn carry the owner as their first indexed topic
      const events = receipt.logs
        .filter((l) => same(l.address, router) && (l.topics[0] === SUPPLIED || l.topics[0] === WITHDRAWN))
        .map((l) => {
          const owner = getAddress(`0x${l.topics[1].slice(26)}`)
          return `${l.topics[0] === SUPPLIED ? 'Supplied' : 'Withdrawn'} for ${owner}${same(owner, receipt.from) ? ' (sent by the owner)' : ''}`
        })
      if (events.length) pass(`${label}: ${hash} emitted ${events.join('; ')}, sent by ${getAddress(receipt.from)}, block ${blockNo}, ${when}`)
      else fail(`${label}: ${hash} succeeded but carries no Supplied/Withdrawn event from the router`)
    })
  }
}

async function checkScoreboard() {
  console.log(`\nApp: ${ORIGIN}`)
  await guard('scoreboard', async () => {
    const res = await fetch(`${ORIGIN}/api/pools`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return fail(`GET /api/pools answered HTTP ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body.pools) || !body.pools.length) return fail('GET /api/pools has no pools')
    const tally = {}
    let odd = 0
    for (const p of body.pools) {
      const v = p.verdict ?? 'none yet'
      tally[v] = (tally[v] ?? 0) + 1
      if (p.verdict !== null && p.verdict !== undefined && !VERDICTS.has(p.verdict)) odd++
    }
    const asOf = typeof body.asOf === 'number' ? new Date(body.asOf).toISOString() : 'unknown'
    pass(`GET /api/pools: ${body.pools.length} pools over a ${body.windowDays}-day window, as of ${asOf}; ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}`)
    if (odd) fail(`${odd} pool rows carry a verdict outside the six documented codes`)
    else pass('every verdict is one of the six documented codes or not given yet')
  })
  await guard('health', async () => {
    const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(30_000) })
    const body = await res.json()
    const lag = body?.indexer?.lagMinutes
    if (typeof lag !== 'number') return fail('GET /api/health reports no indexer lag')
    if (lag <= MAX_LAG_MIN) pass(`indexer lag ${lag} min (limit ${MAX_LAG_MIN})${body.indexer.lastError ? `, last error ${body.indexer.lastError}` : ''}`)
    else fail(`indexer lag ${lag} min, over the ${MAX_LAG_MIN} min limit`)
  })
}

async function checkTestnet() {
  const ev = readJson('evidence/nimiq-testnet-staking.json')
  console.log(`\nNimiq testnet: ${ev.steps.length} staking transactions from evidence/nimiq-testnet-staking.json`)
  for (const s of ev.steps) {
    await guard(`${s.id} ${s.hash}`, async () => {
      let tx = null
      try {
        tx = (await rpc([ev.rpc], 'getTransactionByHash', [s.hash]))?.data ?? null
      } catch (e) {
        if (!/Transaction not found/i.test(String(e.rpc?.data ?? e.message))) throw e
      }
      const outcome = (included, ok) => (!included ? 'never included' : ok ? 'succeeded' : 'included but failed')
      const want = outcome(s.block !== null, s.executionResult)
      const got = outcome(tx !== null, tx?.executionResult)
      const blockOk = s.block === null || tx?.blockNumber === s.block
      if (want === got && blockOk) pass(`${s.id} ${want}${s.block ? ` in block ${s.block}` : ''}, as recorded: ${s.action}`)
      else fail(`${s.id} ${s.hash}: recorded ${want}${s.block ? ` in block ${s.block}` : ''}, chain says ${got}${tx ? ` in block ${tx.blockNumber}` : ''}`)
    })
  }
}

await checkRouter()
await checkScoreboard()
await checkTestnet()

console.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.PENDING} PENDING${counts.SKIP ? `, ${counts.SKIP} SKIP` : ''}`)
// exitCode rather than exit(): on Windows a hard exit while fetch sockets close aborts in libuv
process.exitCode = counts.FAIL ? 1 : 0
