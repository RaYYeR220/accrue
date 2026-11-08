// Seven-day backfill of every listed pool, run locally with the worker's own scan/aggregate code.
//
//   pnpm backfill -- --out <file.sql> [--cache <dir>] [--pools "Siam Pool,Garuda Pool"] [--refresh] [--recheck-non-stakers]
//   pnpm exec wrangler d1 execute accrue --remote --file <file.sql>
//
// Fetched pages and delegation lookups are cached in --cache, so a re-run only re-renders the SQL.
// The SQL replaces pool_hour / staker_day / pool_cursor for the scanned pools. Logos are left to the
// first cron sync (they exceed D1's 100 kB statement limit when inlined).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildPoolWindow, poolVerdict } from '@accrue/shared'
import { HOUR_MS, aggregate, canonicalAddress, delegationOracle, payoutRecipients, poolWindowFromAggregates } from '../src/indexer/aggregate.ts'
import { fetchValidators, payoutTypeOf, poolStatements, rewardStatement, scheduleMsOf } from '../src/indexer/pools.ts'
import { BACKFILL_BLOCKS, Budget, rpcSource, scanPool } from '../src/indexer/scan.ts'
import { cursorWrite, delegationUpsert, hourUpsert, metaSet, stakerDayUpsert, toSql } from '../src/indexer/store.ts'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const out = resolve(opt('out', '.wrangler/backfill.sql'))
const cacheDir = resolve(opt('cache', '.wrangler/backfill-cache'))
const only = opt('pools', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const refresh = args.includes('--refresh')
const recheckNonStakers = args.includes('--recheck-non-stakers')
const env = { NIM_RPCS: process.env.NIM_RPCS ?? 'https://rpc.nimiqwatch.com' }
const WINDOW_MS = 7 * 24 * HOUR_MS
mkdirSync(cacheDir, { recursive: true })

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The public RPC hands out 20 tokens per 10 s per IP (a 500-tx page costs 5) and reports what is
// left in x-ratelimit-remaining / x-ratelimit-reset. Requests go out one at a time, wait for the
// window to roll over when the next one would not fit, and a 429 is waited out, not counted as a try.
const realFetch = globalThis.fetch
const rpcUrls = env.NIM_RPCS.split(',').map((s) => s.trim())
let chain = Promise.resolve()
let remaining = 20
let resetAt = 0
const tokensOf = (init) => {
  try {
    const { method, params } = JSON.parse(String(init?.body ?? '{}'))
    return method === 'getTransactionsByAddress' ? Math.ceil((params?.[1] ?? 500) / 100) : 1
  } catch {
    return 1
  }
}
globalThis.fetch = (input, init) => {
  if (!rpcUrls.some((u) => String(input).startsWith(u))) return realFetch(input, init)
  const run = async () => {
    const cost = tokensOf(init)
    for (let tries = 0; ; tries++) {
      if (remaining < cost && Date.now() < resetAt) await sleep(resetAt - Date.now() + 300)
      if (Date.now() >= resetAt) remaining = Math.max(remaining, 20)
      // the caller's timeout started while this request was queued; time the send itself
      const res = await realFetch(input, { ...init, signal: AbortSignal.timeout(20_000) })
      const rem = res.headers.get('x-ratelimit-remaining')
      const reset = res.headers.get('x-ratelimit-reset')
      if (reset) resetAt = Number(reset) * 1000
      if (rem !== null) remaining = Number(rem)
      if (res.status !== 429 || tries > 20) return res
      remaining = 0
      if (resetAt <= Date.now()) resetAt = Date.now() + 2000
    }
  }
  const p = chain.then(run, run)
  chain = p.then(
    () => undefined,
    () => undefined,
  )
  return p
}
const budget = new Budget(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
const rpc = rpcSource(env, budget, { attempts: 6, backoffMs: 1500, sleep })
const src = {
  txPage: (a, s) => rpc.txPage(a, s).then(strip),
  delegation: (a) => rpc.delegation(a),
  rewardAddress: (v) => rpc.rewardAddress(v),
}
const KEEP = ['hash', 'blockNumber', 'timestamp', 'confirmations', 'from', 'fromType', 'to', 'toType', 'value', 'fee', 'senderData', 'recipientData', 'executionResult']
function strip(page) {
  return page.map((t) => {
    const o = { relatedAddresses: [] }
    for (const k of KEEP) o[k] = t[k]
    return o
  })
}

const readJson = (f, dflt) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt)

async function main() {
  log('validators API')
  const validators = await fetchValidators()
  const selected = validators.filter((v) => !only.length || only.includes(v.name))

  // reward addresses
  const rewards = new Map()
  for (const v of selected) {
    const address = canonicalAddress(v.address)
    rewards.set(address, await src.rewardAddress(address))
  }

  // one full descent per pool, three at a time behind the shared pacer
  const scans = new Map()
  const queue = selected.filter((v) => payoutTypeOf(v.payoutType) !== 'none' && rewards.get(canonicalAddress(v.address)))
  async function worker() {
    for (;;) {
      const v = queue.shift()
      if (!v) return
      const pool = canonicalAddress(v.address)
      const reward = rewards.get(pool)
      const file = join(cacheDir, `txs-${reward.replace(/ /g, '')}.json`)
      let s = refresh ? null : readJson(file, null)
      if (!s) {
        // the same resumable descent the cron runs, in chunks, so an RPC failure loses nothing
        const startedAt = Date.now()
        let cursor = null
        const txs = []
        let pages = 0
        for (let failures = 0; ; ) {
          const step = await scanPool(src, reward, cursor, { maxPages: 25, now: startedAt, canFetch: () => true })
          txs.push(...step.txs)
          pages += step.pages
          if (step.pages > 0) cursor = step.cursor
          if (step.error) {
            if (++failures > 8) throw new Error(`${v.name}: ${step.error}`)
            log(v.name, `retrying after: ${step.error}`)
            await sleep(15_000)
            continue
          }
          if (pages % 100 < 25) log(v.name, 'pages', pages)
          if (cursor && !cursor.resumeHash) break
        }
        s = { pool, reward, visitedAt: startedAt, pages, cursor, txs }
        writeFileSync(file, JSON.stringify(s))
      }
      log(v.name, `${s.txs.length} txs, ${s.pages} pages`)
      scans.set(pool, s)
    }
  }
  await Promise.all([worker(), worker(), worker()])

  // delegation of every payout recipient
  const delegFile = join(cacheDir, 'delegations.json')
  const deleg = new Map(Object.entries(readJson(delegFile, {})))
  const recipients = new Set()
  for (const s of scans.values()) for (const a of payoutRecipients(s.txs, s.reward)) recipients.add(a)
  // --recheck-non-stakers asks again for cached '' answers (useful after a change to what counts as one)
  const todo = [...recipients].filter((a) => !deleg.has(a) || (recheckNonStakers && deleg.get(a).delegation === ''))
  log(`recipients ${recipients.size}, to look up ${todo.length}`)
  let done = 0
  async function lookup() {
    for (;;) {
      const a = todo.shift()
      if (!a) return
      deleg.set(a, { delegation: await src.delegation(a), checkedAt: Date.now() })
      if (++done % 100 === 0) {
        log('lookups', done)
        writeFileSync(delegFile, JSON.stringify(Object.fromEntries(deleg)))
      }
    }
  }
  await Promise.all([lookup(), lookup(), lookup()])
  writeFileSync(delegFile, JSON.stringify(Object.fromEntries(deleg)))
  const delegations = new Map([...deleg].map(([a, e]) => [a, e.delegation]))

  // SQL + the 7-day table
  const now = Date.now()
  const sql = []
  const scanned = [...scans.keys()]
  const inList = scanned.map((p) => `'${p}'`).join(', ')
  if (scanned.length) {
    for (const t of ['pool_hour', 'staker_day', 'pool_cursor']) sql.push(`DELETE FROM ${t} WHERE pool IN (${inList});`)
  }
  for (const s of poolStatements(selected, now, { withLogo: false })) {
    if (!s.sql.startsWith('UPDATE pools SET listed = 0') || !only.length) sql.push(toSql(s))
  }
  for (const [pool, reward] of rewards) sql.push(toSql(rewardStatement(pool, reward, now)))
  for (const a of recipients) {
    const e = deleg.get(a)
    if (e) sql.push(toSql(delegationUpsert(a, e.delegation, e.checkedAt)))
  }

  const counts = { pool_hour: 0, staker_day: 0, pool_cursor: 0, recipient_delegation: recipients.size, pools: selected.length }
  const table = []
  for (const v of selected) {
    const pool = canonicalAddress(v.address)
    const payoutType = payoutTypeOf(v.payoutType)
    const scheduleMs = scheduleMsOf(v.payoutSchedule)
    const cfg = { fee: v.fee ?? 0, payoutType, scheduleMs }
    const s = scans.get(pool)
    const row = { name: v.name, pool, reward: rewards.get(pool), payoutType, fee: v.fee, schedule: v.payoutSchedule, scheduleMs }
    if (!s) {
      const verdict = poolVerdict({ earned: 0n, paidRestake: 0n, paidDirect: 0n, paidUnverified: 0n, otherOut: 0n, cycles: 0, lastPayoutTs: null, windowStartTs: 0, windowEndTs: 0 }, cfg, now)
      table.push({ ...row, scanned: false, verdict: verdict.verdict, reasons: verdict.reasons })
      continue
    }
    const oracle = delegationOracle(delegations, pool)
    const agg = aggregate(s.txs, { rewardAddress: s.reward }, oracle)
    // the time of newest_block: from the cursor, or (caches written before reach_ts existed) dated
    // from the newest tx at one block per second
    const newestTx = s.txs.reduce((m, t) => (t.blockNumber > (m?.blockNumber ?? -1) ? t : m), null)
    const near = newestTx && s.cursor.newestBlock - newestTx.blockNumber <= 3_600
    const reachTs =
      s.cursor.reachTs ?? Math.min(s.visitedAt, near ? newestTx.timestamp + (s.cursor.newestBlock - newestTx.blockNumber) * 1000 : s.visitedAt)
    const cursor = { ...s.cursor, lastPayoutBlock: agg.lastPayoutBlock, reachTs, holeFromTs: null, holeToTs: null }
    const spanH = (s.visitedAt - s.txs.reduce((m, t) => Math.min(m, t.timestamp), s.visitedAt)) / HOUR_MS
    cursor.txsPerHour = spanH > 0 ? s.txs.length / spanH : null
    for (const h of agg.hours) sql.push(toSql(hourUpsert(pool, h, null)))
    for (const d of agg.stakerDays) sql.push(toSql(stakerDayUpsert(pool, d, null)))
    sql.push(toSql(cursorWrite(pool, cursor, null)))
    counts.pool_hour += agg.hours.length
    counts.staker_day += agg.stakerDays.length
    counts.pool_cursor++

    // windows end where the data reaches, never at the wall clock
    const range = { fromTs: reachTs - WINDOW_MS, toTs: reachTs }
    const w = poolWindowFromAggregates(agg.hours, agg.stakerDays, range)
    const verdict = poolVerdict(w, cfg, reachTs)
    // tx-level cross-check with shared buildPoolWindow; its oracle has no leg, so use the leg the
    // address was paid through
    const restaked = payoutRecipients(s.txs.filter((t) => t.toType === 3), s.reward)
    const inWindow = s.txs.filter((t) => t.timestamp >= range.fromTs && t.timestamp <= range.toTs)
    const exact = buildPoolWindow(
      inWindow,
      { rewardAddress: s.reward },
      (addr) => oracle(addr, restaked.has(canonicalAddress(addr)) ? 'restake' : 'direct'),
      { reachBlock: s.cursor.newestBlock },
    )
    const exactVerdict = poolVerdict(exact, cfg, reachTs)
    const sum = (k) => agg.hours.filter((h) => h.hour * HOUR_MS >= range.fromTs).reduce((a, h) => a + h[k], 0n)
    table.push({
      ...row,
      scanned: true,
      txs: s.txs.length,
      pages: s.pages,
      earned: w.earned.toString(),
      paid: (w.paidRestake + w.paidDirect).toString(),
      paidRestake: w.paidRestake.toString(),
      paidDirect: w.paidDirect.toString(),
      unverified: w.paidUnverified.toString(),
      otherOut: w.otherOut.toString(),
      earned7d: sum('earned').toString(),
      ratio: verdict.ratio ?? (w.earned > 0n ? Number(((w.paidRestake + w.paidDirect) * 1_000_000n) / w.earned) / 1e6 : null),
      expectedRatio: verdict.expectedRatio,
      cycles: w.cycles,
      windowStartTs: w.windowStartTs,
      windowEndTs: w.windowEndTs,
      lastPayoutTs: w.lastPayoutTs,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      exact: {
        ratio: exact.earned > 0n ? Number(((exact.paidRestake + exact.paidDirect) * 1_000_000n) / exact.earned) / 1e6 : null,
        cycles: exact.cycles,
        verdict: exactVerdict.verdict,
        earned: exact.earned.toString(),
      },
    })
  }
  sql.push(toSql(metaSet('backfill_at', JSON.stringify(counts), now)))

  writeFileSync(out, sql.join('\n') + '\n')
  writeFileSync(join(cacheDir, 'table.json'), JSON.stringify(table, null, 1))
  log(`wrote ${sql.length} statements to ${out}`, JSON.stringify(counts))

  const pct = (x) => (x === null || x === undefined ? '-' : (x * 100).toFixed(2) + '%')
  const nim = (l) => (l === undefined ? '-' : (Number(BigInt(l) / 1000n) / 100).toFixed(0))
  console.log(['pool', 'type', 'fee', 'earned NIM', 'paid NIM', 'ratio', 'promised', 'cycles', 'verdict', 'tx-level ratio/verdict', 'reasons'].join(' | '))
  for (const r of table) {
    console.log(
      [r.name, r.payoutType, r.fee ?? '-', nim(r.earned), nim(r.paid), pct(r.ratio), pct(r.expectedRatio ?? (r.fee === null ? null : 1 - r.fee)), r.cycles ?? '-', r.verdict,
        r.exact ? `${pct(r.exact.ratio)} ${r.exact.verdict}` : '-', (r.reasons ?? []).join(' ')].join(' | '),
    )
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
