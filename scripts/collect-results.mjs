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
// e2e (Playwright), pools (GET <origin>/api/pools), polygon (the router in
// packages/shared/src/deployments.json and the transactions in contracts/deployments/polygon.json, read
// back from the chain; see scripts/lib/deployment.mjs). The contract suites fork Polygon at a pinned
// block and need an archive RPC: forge gets POLYGON_RPC, or https://polygon.drpc.org when it is unset;
// the polygon source reads from POLYGON_RPC, or from the list in scripts/lib/deployment.mjs.
// A source that fails or cannot run keeps its previous results file and makes the script exit 1.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCIFY_VERIFIED, loadViem, maskedCode, polygon, readDeployment, readTx, routerArtifact, routerWiring, same, sourcifyMatch } from './lib/deployment.mjs'

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
// the fork tests need an archive node
const FORGE_RPC = process.env.POLYGON_RPC || 'https://polygon.drpc.org'
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
  const r = run('forge', ['test', '--json'], { cwd: join(ROOT, 'contracts'), env: { POLYGON_RPC: FORGE_RPC } })
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
  const r = run('forge', ['coverage', '--report', 'summary'], { cwd: join(ROOT, 'contracts'), env: { POLYGON_RPC: FORGE_RPC } })
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
// the router on Polygon

// What the docs may claim about the deployed router, read back from the chain: the code is this
// repository's, it is wired to the aTokens in Aave's registry, its source is verified, and what each
// recorded transaction did. The record format and the rules live in scripts/lib/deployment.mjs.
async function polygonSource() {
  const dep = readDeployment(ROOT)
  const base = { source: 'polygon', fetchedAt: new Date().toISOString(), router: dep.router, deployBlock: dep.deployBlock, problems: dep.problems }
  if (!dep.router || dep.problems.length) return { ...base, txs: [] }
  const { keccak256, isAddress } = await loadViem(ROOT)
  if (!isAddress(dep.router)) return { ...base, problems: [`deployments.json router ${dep.router} has a wrong checksum`], txs: [] }
  const code = await polygon('eth_getCode', [dep.router, 'latest'])
  const hasCode = Boolean(code && code !== '0x')
  const built = routerArtifact(ROOT)
  let wired = false
  try {
    wired = hasCode && (await routerWiring(dep.router)).ok
  } catch (e) {
    // a contract without the router's views reverts: not wired as a router
    if (!/revert/i.test(e.message)) throw e
  }
  const sourcify = await sourcifyMatch(dep.router)
  const facts = {
    hasCode,
    codeHash: hasCode ? keccak256(code) : null,
    codeHashMatchesRecord: dep.codeHash && hasCode ? same(dep.codeHash, keccak256(code)) : null,
    codeMatchesBuild: hasCode && built ? maskedCode(built.object, built.immutableReferences).equals(maskedCode(code, built.immutableReferences)) : null,
    wiredToAaveRegistry: wired,
    sourcify,
    sourceVerified: SOURCIFY_VERIFIED.includes(sourcify),
  }
  const txs = []
  for (const tx of dep.txs) {
    const t = await readTx(tx, dep.router)
    if (!t.found) throw new Error(`no receipt for ${tx.hash} (${tx.label})`)
    const by = (owner) => (same(owner, t.from) ? 'the owner' : `${t.from.slice(0, 8)}…`)
    txs.push({
      label: tx.label,
      deployment: tx.deployment,
      hash: tx.hash,
      block: t.block,
      time: t.time,
      from: t.from,
      created: t.created,
      events: t.events,
      result: !t.ok
        ? 'reverted'
        : tx.deployment
          ? same(t.created, dep.router) ? 'created the router' : 'did not create the router'
          : t.events.length
            ? t.events.map((e) => `${e.name} for ${e.owner.slice(0, 8)}…, sent by ${by(e.owner)}`).join('; ')
            : 'no router event',
    })
  }
  return { ...base, facts, txs }
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
  polygon: polygonSource,
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
