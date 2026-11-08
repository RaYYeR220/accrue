#!/usr/bin/env node
// Fills every <!-- numbers:NAME --> … <!-- /numbers:NAME --> block in the docs from recorded data:
// results/*.json (written by scripts/collect-results.mjs), packages/shared/src/deployments.json,
// contracts/deployments/polygon.json and evidence/nimiq-testnet-staking.json. No number in those
// blocks is typed by hand; re-run after collecting new results or after a deployment.
//
//   node scripts/render-readme-numbers.mjs           rewrite the docs
//   node scripts/render-readme-numbers.mjs --check   exit 1 if any doc is out of date

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DOCS = ['README.md', 'JUDGES.md', 'CLAIMS.md', 'METHODOLOGY.md', 'SECURITY.md', 'PROOF.md', 'MOCKS.md']
const CHECK = process.argv.includes('--check')

const load = (p) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), 'utf8')) : null)
const results = Object.fromEntries(['forge', 'coverage', 'shared', 'worker', 'app', 'e2e', 'pools', 'polygon'].map((k) => [k, load(`results/${k}.json`)]))
const deployments = load('packages/shared/src/deployments.json') ?? { router: null }
const polygonRecord = load('contracts/deployments/polygon.json')
const testnet = load('evidence/nimiq-testnet-staking.json')

const ROUTER = deployments.router
const APP = 'https://accrue.pages.dev'
const n = (x) => Number(x).toLocaleString('en-US')
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown date')
const minute = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const pct = (x, d = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)} %`)
// a fee as published: 5 %, 2.5 %, 3.33 %
const fee = (x) => `${Number((x * 100).toFixed(2))} %`
const plural = (k, one) => `${n(k)} ${k === 1 ? one : `${one}s`}`
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`
const polygonscanAddr = (a) => `[\`${a}\`](https://polygonscan.com/address/${a})`
const polygonscanTx = (h) => `[\`${short(h)}\`](https://polygonscan.com/tx/${h})`
const missing = (what, how) => `_${what} not collected yet: run \`${how}\`._`

const VERDICT_WORDS = {
  PAID_AS_PROMISED: 'Paid as promised',
  BEHIND_SCHEDULE: 'Behind schedule',
  SHORT: 'Short',
  NOT_ENOUGH_DATA: 'Not enough data',
  NO_PAYOUTS_BY_DESIGN: 'No payouts by design',
  CANT_VERIFY_ROUTED: "Can't verify (routed elsewhere)",
}

function outcome(r) {
  if (!r) return '–'
  const parts = [`${n(r.passed)} passed`]
  if (r.failed) parts.push(`**${n(r.failed)} failed**`)
  if (r.flaky) parts.push(`${n(r.flaky)} flaky`)
  if (r.skipped) parts.push(`${n(r.skipped)} skipped`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------------------------
// blocks

const blocks = {
  // one sentence: how many automated tests and whether they all pass
  'tests-total': () => {
    const rs = ['forge', 'shared', 'worker', 'app', 'e2e'].map((k) => results[k])
    if (rs.some((r) => !r)) return missing('Test results', 'node scripts/collect-results.mjs')
    const total = rs.reduce((a, r) => a + r.tests, 0)
    const passed = rs.reduce((a, r) => a + r.passed, 0)
    const skipped = rs.reduce((a, r) => a + (r.skipped ?? 0), 0)
    const failed = rs.reduce((a, r) => a + (r.failed ?? 0), 0)
    if (failed) return `${n(total)} automated tests, **${n(failed)} failing** in the last recorded run`
    return `${n(passed)} automated tests pass${skipped ? ` (${n(skipped)} skipped by design)` : ''}`
  },

  tests: () => {
    const f = results.forge
    const rows = [
      ['Router (Foundry, Polygon fork)', f, 'cd contracts && forge test', f && `${plural(f.suites.length, 'suite')}${f.fuzz.length ? `; ${plural(f.fuzz.length, 'fuzz test')} at ${n(f.fuzz[0].runs)} runs` : ''}${f.invariant.length ? `; invariant campaign ${n(f.invariant[0].runs)} runs × ${n(f.invariant[0].calls / f.invariant[0].runs)} calls` : ''}`],
      ['Shared logic: permits, payout math', results.shared, 'pnpm --filter @accrue/shared test', results.shared && `${results.shared.files} files`],
      ['Worker: relayer, indexer, API', results.worker, 'pnpm --filter @accrue/worker test', results.worker && `${results.worker.files} files`],
      ['App: flows, models, providers', results.app, 'pnpm --filter @accrue/app test', results.app && `${results.app.files} files`],
      ['App end to end (Playwright)', results.e2e, 'pnpm --filter @accrue/app e2e', results.e2e && results.e2e.byProject.map((p) => `${p.project} ${p.tests}`).join(', ')],
    ]
    const out = ['| Suite | Command | Tests | Result | Detail | Recorded |', '|---|---|---:|---|---|---|']
    for (const [name, r, cmd, scope] of rows) {
      out.push(r ? `| ${name} | \`${cmd}\` | ${n(r.tests)} | ${outcome(r)} | ${scope} | ${day(r.ranAt)}, ${r.tool} |` : `| ${name} | \`${cmd}\` | – | not collected yet | | |`)
    }
    const all = rows.map((r) => r[1]).filter(Boolean)
    if (all.length === rows.length) {
      const sum = (k) => all.reduce((a, r) => a + (r[k] ?? 0), 0)
      out.push(`| **Total** | | **${n(sum('tests'))}** | ${outcome({ passed: sum('passed'), failed: sum('failed'), flaky: sum('flaky'), skipped: sum('skipped') })} | | |`)
    }
    const commits = [...new Set(all.map((r) => r.commit).filter(Boolean))]
    const dirty = all.some((r) => r.testedCodeMatchesCommit === false)
    out.push('')
    out.push(`Recorded by \`node scripts/collect-results.mjs\` into [\`results/\`](results/)${commits.length === 1 ? `, testing the code at commit \`${commits[0]}\`` : ''}${dirty ? ' (with local changes to the tested code)' : ''}.` +
      (results.e2e?.skipped ? ' The skipped end-to-end cases are QR-code checks that apply only to a computer or only to a phone viewport.' : ''))
    return out.join('\n')
  },

  contracts: () => {
    const f = results.forge
    if (!f) return missing('Contract test results', 'node scripts/collect-results.mjs --only forge,coverage')
    const out = [
      `${plural(f.tests, 'test')} in ${plural(f.suites.length, 'suite')}, ${outcome(f)}, on a Polygon fork pinned to block ${n(f.forkBlock)} (${f.tool}, recorded ${day(f.ranAt)}):`,
      '',
    ]
    for (const s of f.suites) out.push(`- \`${s.suite.replace(/:.*/, '')}\`: ${plural(s.tests, 'test')}, ${outcome(s)}`)
    for (const z of f.fuzz) out.push(`- fuzz \`${z.test}\`: ${n(z.runs)} runs`)
    for (const v of f.invariant) out.push(`- invariant campaign (both invariants share it; forge reports it as \`${v.test}\`): ${n(v.runs)} runs, ${n(v.calls)} handler calls, ${n(v.reverts)} reverts`)
    const c = results.coverage
    if (c) {
      const router = c.files.find((x) => x.file === 'src/AccrueRouter.sol')
      const deploy = c.files.find((x) => x.file === 'script/Deploy.s.sol')
      const cell = (m) => (m ? `${m.pct} % (${m.hit}/${m.of})` : '–')
      out.push('', `\`forge coverage\` (recorded ${day(c.ranAt)}):`, '', '| File | Lines | Statements | Branches | Functions |', '|---|---|---|---|---|')
      for (const [name, m] of [['src/AccrueRouter.sol', router], ['script/Deploy.s.sol', deploy]]) {
        if (m) out.push(`| \`${name}\` | ${cell(m.lines)} | ${cell(m.statements)} | ${cell(m.branches)} | ${cell(m.functions)} |`)
      }
    } else {
      out.push('', missing('Coverage', 'node scripts/collect-results.mjs --only coverage'))
    }
    return out.join('\n')
  },

  router: () => (ROUTER ? `${polygonscanAddr(ROUTER)} on Polygon (chain 137), deployed in block ${n(deployments.deployBlock)}` : 'deployment pending: no address is published yet'),

  'router-status': () =>
    ROUTER
      ? `Deployed at ${polygonscanAddr(ROUTER)} ([Sourcify](https://repo.sourcify.dev/137/${ROUTER})).`
      : 'Not deployed yet. `packages/shared/src/deployments.json` holds `"router": null` until it is, and the app then says plainly that dollar deposits are not open yet.',

  architecture: () => {
    const live = Boolean(ROUTER)
    const e = (label) => (live ? `-->|"${label}"|` : `-.->|"${label}"|`)
    const plain = live ? '-->' : '-.->'
    return [
      '```mermaid',
      'flowchart LR',
      '  subgraph pay["Nimiq Pay (phone)"]',
      '    app["Accrue Mini App"]',
      '    nimprov["NIM provider"]',
      '    evmprov["window.ethereum"]',
      '  end',
      '  subgraph cf["Cloudflare, same origin as the app"]',
      '    api["/api read API"]',
      '    relay["Relayer (Durable Object)"]',
      '    idx["Indexer (cron, every 5 min)"]',
      '    db[("D1")]',
      '  end',
      '  subgraph nimiq["Nimiq chain"]',
      '    staking["Staking contract"]',
      '    pools["Pool reward addresses"]',
      '  end',
      '  subgraph polygon["Polygon"]',
      '    router["AccrueRouter"]',
      '    aave["Aave v3 Pool"]',
      '  end',
      '  app -- "staking transactions" --> nimprov --> staking',
      '  app -- "EIP-712 permit signature" --> evmprov',
      '  app -- "signed permit" --> relay',
      `  relay ${e('supplyWithPermit / withdrawWithPermit, gas paid')} router`,
      `  router ${plain} aave`,
      '  app -- "verdicts, rates, positions" --> api --> db',
      '  idx -- "rewards in, payouts out" --> pools',
      '  idx --> db',
      `  idx ${e('Supplied / Withdrawn logs')} router`,
      '```',
      '',
      live
        ? 'Solid lines are live.'
        : 'Solid lines are live. Dotted lines wait for the router deployment: until `packages/shared/src/deployments.json` names the router, the relayer has nothing to call and the app says dollar deposits are not open yet.',
    ].join('\n')
  },

  pools: () => {
    const p = results.pools
    if (!p) return missing('The live scoreboard', 'node scripts/collect-results.mjs --only pools')
    const out = [
      `From [\`${p.url.replace(/^https?:\/\//, '')}\`](${p.url}), fetched ${minute(Date.parse(p.fetchedAt))}; pool data as of ${p.asOf ? minute(p.asOf) : 'unknown'}, ${p.windowDays}-day window. The app shows the same rows, live.`,
      '',
      '| Pool | Pays | Fee | Verdict | Paid of earnings | Promised |',
      '|---|---|---:|---|---:|---:|',
    ]
    const order = (x) => (x.verdict ? Object.keys(VERDICT_WORDS).indexOf(x.verdict) : 99)
    for (const x of [...p.pools].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))) {
      const pays = x.payoutType === 'restake' ? 'restakes' : x.payoutType === 'direct' ? 'to wallet' : x.payoutType === 'none' ? 'no payouts' : '–'
      out.push(`| ${x.name.replace(/\|/g, '\\|')} | ${pays} | ${x.fee === null ? 'not listed' : fee(x.fee)} | ${x.verdict ? VERDICT_WORDS[x.verdict] ?? x.verdict : 'no verdict yet'} | ${pct(x.ratio, 2)} | ${pct(x.expectedRatio, 2)} |`)
    }
    const none = p.pools.filter((x) => !x.verdict)
    if (none.length) {
      const why = [...new Set(none.flatMap((x) => x.reasons))].map((r) => `"${r}"`).join(', ')
      out.push('', `${none.length} of ${p.pools.length} pools had no verdict yet when this was fetched${why ? `; the API's reason: ${why}` : ''}`)
    }
    return out.join('\n')
  },

  'pools-summary': () => {
    const p = results.pools
    if (!p) return missing('The live scoreboard', 'node scripts/collect-results.mjs --only pools')
    const tally = {}
    for (const x of p.pools) tally[x.verdict ?? 'none'] = (tally[x.verdict ?? 'none'] ?? 0) + 1
    const parts = Object.keys(VERDICT_WORDS).filter((k) => tally[k]).map((k) => `${tally[k]} ${VERDICT_WORDS[k].toLowerCase()}`)
    if (tally.none) parts.push(`${tally.none} without a verdict yet`)
    return `${p.pools.length} listed pools as of ${minute(Date.parse(p.fetchedAt))}: ${parts.join(', ')}`
  },

  'polygon-proof': () => {
    if (!ROUTER) return 'Deployment pending. Once the router is deployed, this section lists its deployment transaction and the first real deposit and withdrawal, each with its block and date, read back by `scripts/verify-onchain.mjs`.'
    const pr = results.polygon?.router?.toLowerCase() === ROUTER.toLowerCase() ? results.polygon : null
    const out = [`Router: ${polygonscanAddr(ROUTER)}, source on [Sourcify](https://repo.sourcify.dev/137/${ROUTER}).`, '']
    if (!polygonRecord) {
      out.push('No transactions recorded yet in `contracts/deployments/polygon.json`.')
      return out.join('\n')
    }
    if (!pr?.txs?.length) {
      out.push(missing('Transaction details', 'node scripts/collect-results.mjs --only polygon'))
      return out.join('\n')
    }
    out.push('| What | Transaction | Block | Date (UTC) | Result |', '|---|---|---:|---|---|')
    for (const t of pr.txs) out.push(`| ${t.label} | ${polygonscanTx(t.hash)} | ${n(t.block)} | ${t.time} | ${t.result} |`)
    return out.join('\n')
  },

  testnet: () => {
    if (!testnet) return '_No testnet evidence file._'
    const answer = (s) => (s.block === null ? 'never included' : s.executionResult ? 'succeeded' : 'included, failed')
    const out = ['| Step | Sent | Network\'s answer | Block | What it shows |', '|---|---|---|---:|---|']
    for (const s of testnet.steps) {
      out.push(`| [${s.id}](${testnet.explorer}${s.hash}) | ${s.action} | ${answer(s)} | ${s.block === null ? '–' : n(s.block)} | ${s.shows} |`)
    }
    out.push('', `Stakers ${Object.entries(testnet.stakers).map(([k, v]) => `${k} \`${v}\``).join(', ')}; pools ${Object.entries(testnet.pools).map(([k, v]) => `${k} ${v.name} \`${v.address}\``).join(', ')}. Every transaction was sent with fee 0 on ${testnet.sentOn}.`)
    return out.join('\n')
  },

  'claims-polygon': () => {
    // each row is claimed only once results/polygon.json, read back from the chain for this router, shows it
    const pr = ROUTER && results.polygon?.router?.toLowerCase() === ROUTER.toLowerCase() ? results.polygon : null
    const facts = pr?.facts ?? null
    const why = !ROUTER ? 'deployment pending' : !facts ? 'not read back yet: `node scripts/collect-results.mjs --only polygon`' : null
    // a deposit and a withdrawal, each sent (and paid for) by an address other than the owner it served
    const relayed = new Set((pr?.txs ?? []).flatMap((t) => (t.events ?? []).filter((e) => e.owner !== t.from).map((e) => e.name)))
    const hasProofs = relayed.has('Supplied') && relayed.has('Withdrawn')
    const verified = ['exact_match', 'match'].includes(facts?.sourcify)
    const row = (claim, ok, proof, failed, how) => [claim, ok ? 'VERIFIED-LIVE' : 'NOT-CLAIMED', ok ? proof : why ?? failed, how]
    const rows = [
      row('AccrueRouter is live on Polygon mainnet, with its source verified.', facts?.hasCode && verified, `${ROUTER && polygonscanAddr(ROUTER)}, [Sourcify](https://repo.sourcify.dev/137/${ROUTER})`, facts?.hasCode ? 'source not verified on Sourcify yet' : 'no code at the address', '`node scripts/verify-onchain.mjs`'),
      row('The deployed code is the code in `contracts/src`.', facts?.codeMatchesBuild === true, 'runtime code equals a local `forge build` (immutable slots aside)', facts?.codeMatchesBuild === false ? 'runtime code differs from the local build' : 'not compared yet: `forge build` first', '`forge build` in `contracts/`, then `node scripts/verify-onchain.mjs`'),
      row("The deployed router is wired to the aTokens in Aave's own registry.", facts?.wiredToAaveRegistry === true, '`POOL()` and `aTokenOf()` against `Pool.getReserveData`', 'wiring does not match the registry', '`node scripts/verify-onchain.mjs`'),
      row('A real deposit and a real withdrawal went through the router on mainnet, each sent and paid for by an address other than the owner.', hasProofs, '[PROOF.md](PROOF.md#polygon-mainnet)', 'no such mainnet transactions recorded yet', '`node scripts/verify-onchain.mjs`'),
    ]
    const out = ['| Claim | Tier | Proof | Reproduce |', '|---|---|---|---|']
    for (const r of rows) out.push(`| ${r.join(' | ')} |`)
    return out.join('\n')
  },
}

// ---------------------------------------------------------------------------------------------

const MARK = /<!-- numbers:([a-z-]+) -->([\s\S]*?)<!-- \/numbers:\1 -->/g
let stale = 0
const unknown = new Set()
for (const doc of DOCS) {
  const path = join(ROOT, doc)
  if (!existsSync(path)) continue
  const before = readFileSync(path, 'utf8')
  // keep the file's own line endings (a Windows checkout may have CRLF)
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const after = before.replace(MARK, (whole, name, inner) => {
    if (!blocks[name]) {
      unknown.add(`${doc}: ${name}`)
      return whole
    }
    const body = blocks[name]().replace(/\r?\n/g, eol)
    // a block written on one line stays inline; any other is set off by blank lines
    return inner.includes('\n') ? `<!-- numbers:${name} -->${eol}${eol}${body}${eol}${eol}<!-- /numbers:${name} -->` : `<!-- numbers:${name} -->${body}<!-- /numbers:${name} -->`
  })
  if (after !== before) {
    stale++
    if (CHECK) console.log(`${doc}: out of date`)
    else {
      writeFileSync(path, after)
      console.log(`${doc}: updated`)
    }
  } else {
    console.log(`${doc}: up to date`)
  }
}
for (const u of unknown) console.error(`unknown block ${u}`)
if (unknown.size || (CHECK && stale)) process.exitCode = 1
