#!/usr/bin/env node
// Runs every test suite with a machine-readable reporter, fetches the live pool scoreboard, and
// writes one compact summary per source to results/<name>.json. The numbers in README.md,
// CLAIMS.md, SECURITY.md and PROOF.md are rendered from these files only
// (scripts/render-readme-numbers.mjs); none of them is typed by hand.
//
//   node scripts/collect-results.mjs                      everything
//   node scripts/collect-results.mjs --only pools         just the live scoreboard
//   node scripts/collect-results.mjs --skip coverage,e2e  everything else
//   node scripts/collect-results.mjs --origin http://127.0.0.1:8787
//
// Sources: forge (contract tests), coverage (forge coverage), shared / worker / app (vitest),
// e2e (Playwright), pools (GET <origin>/api/pools), polygon (receipts of the transactions recorded in
// contracts/deployments/polygon.json for the router in packages/shared/src/deployments.json).
// The contract suites fork Polygon at a pinned block and need an archive RPC: POLYGON_RPC, default
// https://polygon.drpc.org. A source that fails or cannot run keeps its previous results file and
// makes the script exit 1.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RESULTS = join(ROOT, 'results')
const SOURCES = ['forge', 'coverage', 'shared', 'worker', 'app', 'e2e', 'pools', 'polygon']
const WIN = process.platform === 'win32'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const only = list(opt('only'))
const skip = list(opt('skip'))
for (const s of [...only, ...skip]) {
  if (!SOURCES.includes(s)) {
    console.error(`unknown source "${s}"; known: ${SOURCES.join(', ')}`)
    process.exit(2)
  }
}
const ORIGIN = (opt('origin') ?? process.env.ACCRUE_ORIGIN ?? 'https://accrue.pages.dev').replace(/\/+$/, '')
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon.drpc.org'
const POLYGON_READ_RPCS = process.env.POLYGON_RPC ? [process.env.POLYGON_RPC] : ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org']
const wanted = SOURCES.filter((s) => (only.length ? only.includes(s) : true) && !skip.includes(s))

const scratch = mkdtempSync(join(tmpdir(), 'accrue-results-'))
mkdirSync(RESULTS, { recursive: true })

// pnpm is a .cmd shim on Windows and only starts through a shell, which takes one command line
const quote = (a) => (/^[\w@./:=,+-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`)

function run(cmd, cmdArgs, { cwd = ROOT, env = {} } = {}) {
  const started = Date.now()
  const opts = { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }
  const r = WIN ? spawnSync([cmd, ...cmdArgs].map(quote).join(' '), { ...opts, shell: true }) : spawnSync(cmd, cmdArgs, opts)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, wallMs: Date.now() - started }
}

// "<name> <x.y.z>" from a tool's --version output
function version(name, cmd, cmdArgs) {
  const r = run(cmd, cmdArgs)
  const v = r.status === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] : null
  return `${name} ${v ?? 'unknown'}`
}

function git(...a) {
  const r = run('git', a)
  return r.status === 0 ? r.stdout.trim() : null
}

// The commit the tested code comes from, and whether the tested directories differ from it.
function provenance() {
  const changed = git('status', '--porcelain', '--', 'contracts', 'packages', 'worker', 'app')
  return { commit: git('rev-parse', 'HEAD'), testedCodeMatchesCommit: changed === '' }
}

const rel = (p) => relative(ROOT, p).replaceAll('\\', '/')

function write(name, data) {
  writeFileSync(join(RESULTS, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`)
  console.log(`results/${name}.json written`)
}

// ---------------------------------------------------------------------------------------------
// forge test

function forge() {
  const r = run('forge', ['test', '--json'], { cwd: join(ROOT, 'contracts'), env: { POLYGON_RPC } })
  let report
  try {
    report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    throw new Error(`forge test produced no JSON (exit ${r.status}): ${r.stderr.slice(-800)}`)
  }
  const suites = []
  const fuzz = []
  const invariant = []
  let forkBlock = null
  for (const [suite, body] of Object.entries(report)) {
    const s = { suite, tests: 0, passed: 0, failed: 0, skipped: 0 }
    for (const [test, t] of Object.entries(body.test_results ?? {})) {
      s.tests++
      if (t.status === 'Success') s.passed++
      else if (t.status === 'Skipped') s.skipped++
      else s.failed++
      if (t.fork_block_number) forkBlock = t.fork_block_number
      const kind = t.kind ?? {}
      if (kind.Fuzz) fuzz.push({ test: test.replace(/\(.*$/, ''), runs: kind.Fuzz.runs })
      if (kind.Invariant) {
        invariant.push({ test: test.replace(/\(.*$/, ''), runs: kind.Invariant.runs, calls: kind.Invariant.calls, reverts: kind.Invariant.reverts })
      }
    }
    suites.push(s)
  }
  const sum = (k) => suites.reduce((a, s) => a + s[k], 0)
  return {
    source: 'forge',
    tool: version('forge', 'forge', ['--version']),
    command: 'cd contracts && forge test --json',
    ranAt: new Date().toISOString(),
    ...provenance(),
    forkBlock,
    wallMs: r.wallMs,
    ok: r.status === 0 && sum('failed') === 0,
    suites,
    tests: sum('tests'),
    passed: sum('passed'),
    failed: sum('failed'),
    skipped: sum('skipped'),
    fuzz,
    invariant,
  }
}

// ---------------------------------------------------------------------------------------------
// forge coverage

function coverage() {
  const r = run('forge', ['coverage', '--report', 'summary'], { cwd: join(ROOT, 'contracts'), env: { POLYGON_RPC } })
  const files = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1)
    if (cells.length !== 5 || !/\.sol$|^Total$/.test(cells[0])) continue
    const part = (c) => {
      const m = /([\d.]+)% \((\d+)\/(\d+)\)/.exec(c)
      return m ? { pct: Number(m[1]), hit: Number(m[2]), of: Number(m[3]) } : null
    }
    files.push({ file: cells[0], lines: part(cells[1]), statements: part(cells[2]), branches: part(cells[3]), functions: part(cells[4]) })
  }
  if (!files.length) throw new Error(`forge coverage printed no summary table (exit ${r.status}): ${r.stderr.slice(-800)}`)
  return {
    source: 'coverage',
    tool: version('forge', 'forge', ['--version']),
    command: 'cd contracts && forge coverage --report summary',
    ranAt: new Date().toISOString(),
    ...provenance(),
    wallMs: r.wallMs,
    ok: r.status === 0,
    files,
  }
}

// ---------------------------------------------------------------------------------------------
// vitest

function vitest(name, filter) {
  const out = join(scratch, `${name}.json`)
  const r = run('pnpm', ['--filter', filter, 'exec', 'vitest', 'run', '--reporter=json', `--outputFile=${out}`])
  let report
  try {
    report = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    throw new Error(`vitest (${filter}) wrote no JSON report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`)
  }
  const files = report.testResults
    .map((f) => {
      const a = f.assertionResults ?? []
      const count = (st) => a.filter((t) => t.status === st).length
      return {
        file: rel(f.name),
        tests: a.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: a.length - count('passed') - count('failed'),
        ...(count('failed') ? { failures: a.filter((t) => t.status === 'failed').map((t) => t.fullName) } : {}),
      }
    })
    .sort((x, y) => x.file.localeCompare(y.file))
  return {
    source: name,
    tool: version('vitest', 'pnpm', ['--filter', filter, 'exec', 'vitest', '--version']),
    command: `pnpm --filter ${filter} test`,
    ranAt: new Date().toISOString(),
    ...provenance(),
    wallMs: r.wallMs,
    ok: r.status === 0 && report.numFailedTests === 0 && report.success !== false,
    files: files.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    byFile: files,
  }
}

// ---------------------------------------------------------------------------------------------
// Playwright

function e2e() {
  const out = join(scratch, 'e2e.json')
  const r = run('pnpm', ['--filter', '@accrue/app', 'exec', 'playwright', 'test', '--reporter=json'], {
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: out, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
  })
  let report
  try {
    report = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    throw new Error(`playwright wrote no JSON report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`)
  }
  const projects = new Map()
  const specs = new Map()
  const bump = (map, key, status) => {
    const e = map.get(key) ?? { tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }
    e.tests++
    if (status === 'expected') e.passed++
    else if (status === 'skipped') e.skipped++
    else if (status === 'flaky') e.flaky++
    else e.failed++
    map.set(key, e)
  }
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        bump(projects, t.projectName, t.status)
        bump(specs, spec.file ?? suite.file, t.status)
      }
    }
    for (const s of suite.suites ?? []) walk(s)
  }
  for (const s of report.suites ?? []) walk(s)
  const st = report.stats ?? {}
  const tests = (st.expected ?? 0) + (st.unexpected ?? 0) + (st.flaky ?? 0) + (st.skipped ?? 0)
  return {
    source: 'e2e',
    tool: version('playwright', 'pnpm', ['--filter', '@accrue/app', 'exec', 'playwright', '--version']),
    command: 'pnpm --filter @accrue/app e2e',
    ranAt: new Date().toISOString(),
    ...provenance(),
    wallMs: r.wallMs,
    ok: r.status === 0 && !st.unexpected,
    tests,
    passed: st.expected ?? 0,
    failed: st.unexpected ?? 0,
    flaky: st.flaky ?? 0,
    skipped: st.skipped ?? 0,
    byProject: [...projects].map(([project, c]) => ({ project, ...c })).sort((a, b) => a.project.localeCompare(b.project)),
    bySpec: [...specs].map(([file, c]) => ({ file: `app/e2e/${file}`, ...c })).sort((a, b) => a.file.localeCompare(b.file)),
  }
}

// ---------------------------------------------------------------------------------------------
// live scoreboard

async function pools() {
  const url = `${ORIGIN}/api/pools`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body.pools)) throw new Error(`${url} answered without a pools array`)
  return {
    source: 'pools',
    url,
    fetchedAt: new Date().toISOString(),
    asOf: body.asOf ?? null,
    windowDays: body.windowDays ?? null,
    pools: body.pools.map((p) => ({
      name: p.name,
      address: p.address,
      fee: p.fee ?? null,
      payoutType: p.payoutType ?? null,
      schedule: p.schedule ?? null,
      stakers: p.stakers ?? null,
      verdict: p.verdict ?? null,
      ratio: p.ratio ?? null,
      expectedRatio: p.expectedRatio ?? null,
      lastPayoutTs: p.lastPayoutTs ?? null,
      reachTs: p.reachTs ?? null,
      reasons: Array.isArray(p.reasons) ? p.reasons : [],
    })),
  }
}

// ---------------------------------------------------------------------------------------------
// router transactions on Polygon

async function polygonRpc(method, params) {
  let last
  for (const url of POLYGON_READ_RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json()
      if (body.error) throw new Error(body.error.message)
      return body.result
    } catch (e) {
      last = e
    }
  }
  throw last
}

// topic0 of AccrueRouter's events
const ROUTER_EVENTS = {
  '0x2b650c94fbe31b46ae7946bf007a115a23c6e4532d75ad025261819304334598': 'Supplied',
  '0x91fb9d98b786c57d74c099ccd2beca1739e9f6a81fb49001ca465c4b7591bbe2': 'Withdrawn',
}

function hashesIn(node, path = []) {
  if (typeof node === 'string') return /^0x[0-9a-fA-F]{64}$/.test(node) ? [{ key: path.join('.'), hash: node }] : []
  if (Array.isArray(node)) return node.flatMap((v, i) => hashesIn(v, [...path, v?.label ?? String(i)]))
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => (k === 'label' ? [] : hashesIn(v, [...path, k])))
  return []
}

const AAVE_POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad'
const RESERVES = { USDT0: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' }
const word = (addr) => addr.slice(2).toLowerCase().padStart(64, '0')
const addrAt = (data, i) => `0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`.toLowerCase()

// What the docs may claim about a deployed router: its code is this repository's, it is wired to the
// aTokens in Aave's registry, and its source is verified on Sourcify.
async function routerFacts(router) {
  const code = await polygonRpc('eth_getCode', [router, 'latest'])
  let codeMatchesBuild = null
  const artifact = join(ROOT, 'contracts/out/AccrueRouter.sol/AccrueRouter.json')
  if (code && code !== '0x' && existsSync(artifact)) {
    const built = JSON.parse(readFileSync(artifact, 'utf8')).deployedBytecode
    const mask = (hex) => {
      const b = Buffer.from(hex.replace(/^0x/, ''), 'hex')
      for (const refs of Object.values(built.immutableReferences ?? {})) for (const { start, length } of refs) b.fill(0, start, start + length)
      return b
    }
    codeMatchesBuild = mask(built.object).equals(mask(code))
  }
  let wired = false
  try {
    wired = addrAt(await polygonRpc('eth_call', [{ to: router, data: '0x7535d246' }, 'latest']), 0) === AAVE_POOL // POOL()
    for (const asset of Object.values(RESERVES)) {
      const aToken = addrAt(await polygonRpc('eth_call', [{ to: router, data: `0x144f4dce${word(asset)}` }, 'latest']), 0) // aTokenOf(asset)
      const registered = addrAt(await polygonRpc('eth_call', [{ to: AAVE_POOL, data: `0x35ea6a75${word(asset)}` }, 'latest']), 8) // getReserveData(asset).aTokenAddress
      wired &&= aToken === registered
    }
  } catch (e) {
    // a contract without these views is not wired as a router
    if (!/revert/i.test(e.message)) throw e
    wired = false
  }
  let sourcify = 'none'
  const res = await fetch(`https://sourcify.dev/server/v2/contract/137/${router}`, { signal: AbortSignal.timeout(20_000) })
  if (res.ok) sourcify = (await res.json()).match ?? 'none'
  return { hasCode: Boolean(code && code !== '0x'), codeMatchesBuild, wiredToAaveRegistry: wired, sourcify }
}

async function polygon() {
  const dep = JSON.parse(readFileSync(join(ROOT, 'packages/shared/src/deployments.json'), 'utf8'))
  const recordPath = join(ROOT, 'contracts/deployments/polygon.json')
  const base = { source: 'polygon', fetchedAt: new Date().toISOString(), router: dep.router ?? null, deployBlock: dep.deployBlock ?? null }
  if (!dep.router) return { ...base, txs: [] }
  base.facts = await routerFacts(dep.router)
  if (!existsSync(recordPath)) return { ...base, txs: [] }
  const txs = []
  for (const { key, hash } of hashesIn(JSON.parse(readFileSync(recordPath, 'utf8')))) {
    const receipt = await polygonRpc('eth_getTransactionReceipt', [hash])
    if (!receipt) throw new Error(`no receipt for ${hash} (${key})`)
    const block = await polygonRpc('eth_getBlockByNumber', [receipt.blockNumber, false])
    const deployment = key === 'txHash'
    const created = deployment && receipt.contractAddress?.toLowerCase() === dep.router.toLowerCase()
    // Supplied / Withdrawn carry the owner as their first indexed topic
    const events = receipt.logs
      .filter((l) => l.address.toLowerCase() === dep.router.toLowerCase() && ROUTER_EVENTS[l.topics[0]])
      .map((l) => ({ name: ROUTER_EVENTS[l.topics[0]], owner: `0x${l.topics[1].slice(26)}` }))
    const sender = receipt.from.toLowerCase()
    txs.push({
      label: deployment ? 'deployment' : key,
      hash,
      block: Number(BigInt(receipt.blockNumber)),
      time: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString().slice(0, 19).replace('T', ' '),
      from: sender,
      result:
        receipt.status !== '0x1'
          ? 'reverted'
          : deployment
            ? created ? 'created the router' : 'did not create the router'
            : events.length
              ? events.map((e) => `${e.name} for ${e.owner.slice(0, 8)}…, sent by ${e.owner === sender ? 'the owner' : `${sender.slice(0, 8)}…`}`).join('; ')
              : 'no router event',
      events,
    })
  }
  return { ...base, txs }
}

// ---------------------------------------------------------------------------------------------

const jobs = {
  forge,
  coverage,
  shared: () => vitest('shared', '@accrue/shared'),
  worker: () => vitest('worker', '@accrue/worker'),
  app: () => vitest('app', '@accrue/app'),
  e2e,
  pools,
  polygon,
}

let bad = 0
for (const name of wanted) {
  console.log(`\n== ${name}`)
  try {
    const data = await jobs[name]()
    write(name, data)
    if (data.ok === false) {
      bad++
      console.log(`${name}: FAILED (see results/${name}.json)`)
    } else if ('tests' in data) {
      console.log(`${name}: ${data.passed}/${data.tests} passed${data.skipped ? `, ${data.skipped} skipped` : ''}`)
    } else if (name === 'pools') {
      console.log(`pools: ${data.pools.length} pools from ${data.url}`)
    } else if (name === 'polygon') {
      console.log(data.router ? `polygon: ${data.txs.length} recorded transactions read back` : 'polygon: router not deployed yet, nothing to read')
    }
  } catch (e) {
    bad++
    console.log(`${name}: could not collect: ${e.message}`)
  }
}

rmSync(scratch, { recursive: true, force: true })
// exitCode rather than exit(): on Windows a hard exit while fetch sockets close aborts in libuv
process.exitCode = bad ? 1 : 0
