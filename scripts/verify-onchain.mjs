#!/usr/bin/env node
// Checks the public claims that live outside this repository against the chains and the live app,
// and prints one PASS / FAIL / PENDING line per check:
//
//   Polygon   the router in packages/shared/src/deployments.json: code at the address (and its hash
//             against the recorded codeHash), the same runtime code as contracts/src builds to, wired
//             to Aave's own registry, source verified on Sourcify, and the deployment and the
//             transactions recorded in contracts/deployments/polygon.json (format: scripts/lib/deployment.mjs)
//   app       the live pool scoreboard and the indexer's lag at <origin>/api/*
//   Nimiq     the testnet staking transactions in evidence/nimiq-testnet-staking.json
//
// PENDING means there is nothing to check yet (the router is not deployed); it is not a failure.
// Exit code 1 on any FAIL.
//
//   pnpm install && node scripts/verify-onchain.mjs
//   POLYGON_RPC=<url> ACCRUE_ORIGIN=<url> node scripts/verify-onchain.mjs

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AAVE_POOL,
  POLYGON_RPCS,
  SOURCIFY_VERIFIED,
  loadViem,
  maskedCode,
  polygon,
  readDeployment,
  readTx,
  routerArtifact,
  routerWiring,
  rpc,
  same,
  sourcifyMatch,
} from './lib/deployment.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

let viem
try {
  viem = await loadViem(ROOT)
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const { keccak256, getAddress, isAddress } = viem

const ORIGIN = (process.env.ACCRUE_ORIGIN || 'https://accrue.pages.dev').replace(/\/+$/, '')
const MAX_LAG_MIN = 60
const VERDICTS = new Set(['PAID_AS_PROMISED', 'BEHIND_SCHEDULE', 'SHORT', 'NOT_ENOUGH_DATA', 'NO_PAYOUTS_BY_DESIGN', 'CANT_VERIFY_ROUTED'])

const counts = { PASS: 0, FAIL: 0, PENDING: 0, SKIP: 0 }
function line(status, text) {
  counts[status]++
  console.log(`${status.padEnd(7)} ${text}`)
}
const pass = (t) => line('PASS', t)
const fail = (t) => line('FAIL', t)
const pending = (t) => line('PENDING', t)
const skip = (t) => line('SKIP', t)

async function guard(label, fn) {
  try {
    await fn()
  } catch (e) {
    fail(`${label}: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------------------------

async function checkRouter() {
  console.log(`\nPolygon: router (RPC ${POLYGON_RPCS.join(', ')})`)
  let dep
  try {
    dep = readDeployment(ROOT)
  } catch (e) {
    fail(`deployment record unreadable: ${e.message}`)
    return
  }
  for (const p of dep.problems) fail(p)
  if (!dep.router) {
    if (!dep.record) pending('router not deployed yet: packages/shared/src/deployments.json has router null, so there is nothing on Polygon to check')
    return
  }
  // a string that is not an address shape is already among the problems; this also catches a bad checksum
  if (!isAddress(String(dep.router))) {
    if (/^0x[0-9a-fA-F]{40}$/.test(String(dep.router))) fail(`deployments.json router ${dep.router} has a wrong checksum`)
    return
  }
  const router = getAddress(dep.router)

  await guard('router code', async () => {
    const code = await polygon('eth_getCode', [router, 'latest'])
    if (!code || code === '0x') return fail(`no code at ${router}`)
    const hash = keccak256(code)
    pass(`code at ${router}: ${(code.length - 2) / 2} bytes, keccak256 ${hash}`)
    if (dep.codeHash) {
      if (same(dep.codeHash, hash)) pass(`code hash equals codeHash in ${dep.recordPath}`)
      else fail(`code hash ${hash} differs from codeHash ${dep.codeHash} in ${dep.recordPath}`)
    }
    const built = routerArtifact(ROOT)
    if (!built) return skip('no local build to compare: run `forge build` in contracts/ first')
    if (maskedCode(built.object, built.immutableReferences).equals(maskedCode(code, built.immutableReferences))) {
      pass('runtime code equals the local build of contracts/src (immutable slots aside)')
    } else {
      fail('runtime code differs from the local build of contracts/src')
    }
  })

  await guard('router wiring', async () => {
    const w = await routerWiring(router)
    if (w.poolOk) pass(`POOL() is the Aave v3 pool ${AAVE_POOL}`)
    else fail(`POOL() is ${w.pool}, expected ${AAVE_POOL}`)
    for (const r of w.reserves) {
      if (r.ok) pass(`aTokenOf(${r.symbol}) is ${getAddress(r.routerATokenOf)}, the aToken Aave's registry lists for it`)
      else fail(`aTokenOf(${r.symbol}) is ${r.routerATokenOf}; expected ${r.aToken}, registry lists ${r.registered}`)
    }
  })

  await guard('Sourcify', async () => {
    const match = await sourcifyMatch(router)
    if (SOURCIFY_VERIFIED.includes(match)) pass(`source verified on Sourcify: ${match}`)
    else fail(`source not verified on Sourcify (chain 137, ${router}): ${match}`)
  })

  if (!dep.record) return pending(`no transactions recorded yet in ${dep.recordPath}`)
  if (!dep.txs.length) pending(`${dep.recordPath} lists no transactions yet`)
  for (const tx of dep.txs) {
    await guard(`${tx.label} ${tx.hash}`, async () => {
      const t = await readTx(tx, router)
      if (!t.found) return fail(`${tx.label}: no receipt for ${tx.hash}`)
      if (!t.ok) return fail(`${tx.label}: ${tx.hash} reverted (block ${t.block})`)
      if (tx.deployment) {
        const atBlock = !dep.deployBlock || Number(dep.deployBlock) === t.block
        if (same(t.created, router) && atBlock) pass(`deployment ${tx.hash} created ${router} in block ${t.block}, ${t.time} UTC`)
        else fail(`deployment ${tx.hash}: created ${t.created} in block ${t.block}; expected ${router} in block ${dep.deployBlock}`)
        return
      }
      if (!t.events.length) return fail(`${tx.label}: ${tx.hash} succeeded but carries no Supplied/Withdrawn event from the router`)
      const what = t.events.map((e) => `${e.name} for ${getAddress(e.owner)}${same(e.owner, t.from) ? ' (sent by the owner)' : ''}`).join('; ')
      pass(`${tx.label}: ${tx.hash} emitted ${what}, sent by ${getAddress(t.from)}, block ${t.block}, ${t.time} UTC`)
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
    pass(`GET /api/pools: ${body.pools.length} pools over a ${body.windowDays}-day window, verdicts computed at ${asOf}; ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}`)
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
