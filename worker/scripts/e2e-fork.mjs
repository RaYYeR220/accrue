// Fork e2e for the gasless relayer: anvil Polygon fork + fresh router + `wrangler dev`, signing permits the way
// the app does and checking the relayer's answers and the owner's balances. Prints one PASS/FAIL line per check.
//
//   node scripts/e2e-fork.mjs            (from worker/; FORK_RPC defaults to https://polygon.drpc.org)
//
// Needs anvil, a built router artifact (contracts/out, `forge build` in contracts/), and Node 22+.
// Writes a throwaway worker/.dev.vars (dev keys only) and restores any existing one on exit.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  maxUint256,
  parseAbi,
  parseSignature,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS_DIR = resolve(WORKER_DIR, '../contracts')
const ARTIFACT = join(CONTRACTS_DIR, 'out/AccrueRouter.sol/AccrueRouter.json')
const FORK_RPC = process.env.FORK_RPC ?? 'https://polygon.drpc.org'
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545)
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8799)
const ANVIL = `http://127.0.0.1:${ANVIL_PORT}`
const API = `http://127.0.0.1:${WORKER_PORT}/api`
const CPU_BATCH = 30

const POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD'
const USDT0 = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const A_USDT0 = '0x6ab707Aca953eDAeFBc4fD23bA73294241490620'
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const A_USDC = '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD'
// Written out independently of @accrue/shared so a wrong domain there would show up here as BAD_SIGNATURE.
const DOMAIN = {
  USDT0: { name: 'USDT0', version: '1', verifyingContract: USDT0, salt: `0x${'0'.repeat(62)}89` },
  aUSDT0: { name: 'Aave Polygon USDT', version: '1', chainId: 137, verifyingContract: A_USDT0 },
  USDC: { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC },
}
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
])
const routerAbi = parseAbi([
  'function supplyWithPermit(address asset, address owner, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
])

const results = []
function check(name, ok, info = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const usd = n => BigInt(Math.round(n * 1e6))

const children = []
let devVarsBackup = null
const devVars = join(WORKER_DIR, '.dev.vars')
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const c of children.reverse()) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGTERM')
    } catch {}
  }
  try {
    if (devVarsBackup) renameSync(devVarsBackup, devVars)
    else rmSync(devVars, { force: true })
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

async function rpcAlive(url) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    return (await r.json()).result === '0x89'
  } catch {
    return false
  }
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Summed CPU ms of the given processes (every workerd that wrangler dev started). */
function cpuMs(pids) {
  if (!pids?.length) return null
  try {
    if (process.platform === 'win32') {
      const ps = `(Get-Process -Id ${pids.join(',')} | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum`
      return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().replace(',', '.'))
    }
    let ms = 0
    for (const pid of pids) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
      ms += ((Number(stat[11]) + Number(stat[12])) * 1000) / 100
    }
    return ms
  } catch {
    return null
  }
}

/** workerd processes anywhere below `rootPid` (wrangler's bin re-spawns node, which spawns workerd). */
function workerdPids(rootPid) {
  try {
    let rows
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
        { encoding: 'utf8' },
      )
      rows = out.split(/\r?\n/).filter(Boolean).map(l => l.trim().split(' '))
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      rows = out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/))
    }
    const tree = new Set([String(rootPid)])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true))
    }
    return rows.filter(([pid, , name]) => tree.has(pid) && /^workerd/.test(name ?? '')).map(([pid]) => Number(pid))
  } catch {
    return []
  }
}

async function post(body) {
  const r = await fetch(`${API}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { http: r.status, ...(await r.json()) }
}
const getJob = async id => (await fetch(`${API}/relay/${id}`)).json()
async function settled(jobId, ms = 90_000) {
  return waitFor(async () => {
    const j = await getJob(jobId)
    return j.status === 'confirmed' || j.status === 'failed' ? j : null
  }, ms, `job ${jobId}`)
}

async function main() {
  // 1. Fork
  if (await rpcAlive(ANVIL)) console.log(`# reusing the Polygon fork already on ${ANVIL}`)
  else {
    console.log(`# starting anvil --fork-url ${FORK_RPC}`)
    children.push(spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' }))
    await waitFor(() => rpcAlive(ANVIL), 60_000, 'anvil')
  }
  const transport = http(ANVIL, { timeout: 60_000 })
  const pub = createPublicClient({ chain: polygon, transport })
  const test = createTestClient({ chain: polygon, mode: 'anvil', transport })
  console.log(`# fork block ${await pub.getBlockNumber()}`)

  // 2. Router
  if (!existsSync(ARTIFACT)) {
    console.log('# forge build')
    execFileSync('forge', ['build', '--skip', 'test', '--skip', 'script'], { cwd: CONTRACTS_DIR, stdio: 'inherit' })
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  const deployer = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: deployer.address, value: 10n ** 19n })
  const deployerWallet = createWalletClient({ account: deployer, chain: polygon, transport })
  const deployHash = await deployerWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [POOL, [USDT0, USDC], [A_USDT0, A_USDC]],
  })
  const router = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress
  console.log(`# router ${router}`)

  // 3. Accounts: fresh relayer (5 POL), fresh owner with 10 USDT0 and no POL at all
  const relayerKey = generatePrivateKey()
  const relayer = privateKeyToAccount(relayerKey)
  await test.setBalance({ address: relayer.address, value: 5n * 10n ** 18n })
  const ownerAcct = privateKeyToAccount(generatePrivateKey())
  const owner = ownerAcct.address
  await test.setBalance({ address: owner, value: 0n })
  await test.setBalance({ address: A_USDT0, value: 10n ** 18n })
  await test.impersonateAccount({ address: A_USDT0 })
  const aTokenWallet = createWalletClient({ account: A_USDT0, chain: polygon, transport })
  await pub.waitForTransactionReceipt({
    hash: await aTokenWallet.writeContract({ address: USDT0, abi: erc20, functionName: 'transfer', args: [owner, usd(10)] }),
  })
  await test.stopImpersonatingAccount({ address: A_USDT0 })
  const bal = (token, who = owner) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] })
  const nonceOf = token => pub.readContract({ address: token, abi: erc20, functionName: 'nonces', args: [owner] })
  console.log(`# relayer ${relayer.address}  owner ${owner}  owner USDT0 ${await bal(USDT0)}`)

  // 4. Worker
  const busy = await fetch(`${API}/health`).then(() => true, () => false)
  if (busy) throw new Error(`something already listens on :${WORKER_PORT}; stop it or set WORKER_PORT`)
  if (existsSync(devVars)) {
    devVarsBackup = `${devVars}.e2e-backup`
    renameSync(devVars, devVarsBackup)
  }
  writeFileSync(
    devVars,
    [
      `RELAYER_KEY=${relayerKey}`,
      `RELAYER_ADDRESS=${relayer.address}`,
      `ROUTER_ADDRESS=${router}`,
      `POLYGON_RPCS=${ANVIL}`,
      '',
    ].join('\n'),
  )
  const persist = mkdtempSync(join(tmpdir(), 'accrue-e2e-'))
  const wranglerJs = join(WORKER_DIR, 'node_modules/wrangler/bin/wrangler.js')
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_D1_WARNING: 'true' }
  execFileSync(process.execPath, [wranglerJs, 'd1', 'migrations', 'apply', 'accrue', '--local', '--persist-to', persist], {
    cwd: WORKER_DIR,
    env,
    stdio: 'ignore',
  })
  const dev = spawn(
    process.execPath,
    [wranglerJs, 'dev', '--ip', '127.0.0.1', '--port', String(WORKER_PORT), '--persist-to', persist, '--show-interactive-dev-session=false'],
    { cwd: WORKER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.push(dev)
  const devLog = []
  const onLine = buf => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) devLog.push(line)
  }
  dev.stdout.on('data', onLine)
  dev.stderr.on('data', onLine)
  await waitFor(async () => {
    try {
      return (await fetch(`${API}/health`)).ok
    } catch {
      return false
    }
  }, 90_000, 'wrangler dev')
  const wpid = workerdPids(dev.pid)
  console.log(`# wrangler dev on :${WORKER_PORT} (workerd pids ${wpid.join(",") || "unknown"})`)
  const health = await (await fetch(`${API}/health`)).json()
  check('health sees the relayer key funded', health.relayer?.address === relayer.address && health.relayer?.polBalance === (5n * 10n ** 18n).toString(), JSON.stringify(health.relayer))

  const now = () => Math.floor(Date.now() / 1000)
  const signSupply = async ({ amount, nonce, deadline = now() + 1200, asset = 'USDT0', signer = ownerAcct, who = owner }) => {
    const message = { owner: who, spender: router, value: amount, nonce, deadline: BigInt(deadline) }
    const signature = await signer.signTypedData({ domain: DOMAIN[asset], types: PERMIT_TYPES, primaryType: 'Permit', message })
    return { kind: 'supply', asset, owner: who, amount: amount.toString(), deadline: String(deadline), nonce: nonce.toString(), signature }
  }
  const relayerTxCount = () => pub.getTransactionCount({ address: relayer.address })
  const cpu = {}
  const measure = async (label, fn, n = 1) => {
    const before = cpuMs(wpid)
    const t0 = Date.now()
    let out
    for (let i = 0; i < n; i++) out = await fn()
    const after = cpuMs(wpid)
    cpu[label] = { n, cpuMsPerReq: before !== null && after !== null ? (after - before) / n : null, wallMsPerReq: (Date.now() - t0) / n }
    return out
  }

  // supply $5 -> confirmed, owner aToken >= 5e6 - 1
  const s1 = await signSupply({ amount: usd(5), nonce: await nonceOf(USDT0) })
  const r1 = await measure('supply submit (first DO request, cold)', () => post(s1))
  check('supply $5 accepted', r1.http === 202 && r1.status === 'submitted' && /^0x[0-9a-f]{64}$/.test(r1.jobId), JSON.stringify(r1))
  const j1 = await settled(r1.jobId)
  const a1 = await bal(A_USDT0)
  check('supply $5 -> confirmed, owner aToken >= 5e6-1', j1.status === 'confirmed' && a1 >= usd(5) - 1n, `status ${j1.status}, aUSDT0 ${a1}, tx ${j1.txHash}`)
  check('owner paid no gas (POL balance still 0)', (await pub.getBalance({ address: owner })) === 0n)

  // same signature again -> same jobId, no second tx
  const txsBefore = await relayerTxCount()
  const r2 = await post(s1)
  await sleep(6_000)
  const a2 = await bal(A_USDT0)
  check(
    'same signature re-POSTed -> same jobId, no second tx',
    r2.jobId === r1.jobId && r2.status === 'confirmed' && a2 === a1 && (await relayerTxCount()) === txsBefore,
    `jobId ${r2.jobId === r1.jobId ? 'same' : 'DIFFERENT'}, status ${r2.status}, aUSDT0 ${a2}, relayer txs ${txsBefore} -> ${await relayerTxCount()}`,
  )
  await measure('idempotent re-POST', () => post(s1), CPU_BATCH)

  // a new permit on the already-used nonce -> PERMIT_NONCE_STALE
  const s3 = await signSupply({ amount: usd(5), nonce: 0n, deadline: now() + 1500 })
  const r3 = await post(s3)
  check('second permit with the used nonce -> PERMIT_NONCE_STALE', r3.http === 409 && r3.error === 'PERMIT_NONCE_STALE', JSON.stringify(r3))

  // $50 while holding $5 -> INSUFFICIENT_BALANCE
  const held = await bal(USDT0)
  const s4 = await signSupply({ amount: usd(50), nonce: await nonceOf(USDT0) })
  const r4 = await measure('rejected after full validation (INSUFFICIENT_BALANCE)', () => post(s4), CPU_BATCH)
  check('permit for $50 while owner holds $5 -> INSUFFICIENT_BALANCE', held === usd(5) && r4.http === 422 && r4.error === 'INSUFFICIENT_BALANCE', `${JSON.stringify(r4)}, held ${held}`)

  // extra: wrong signer -> BAD_SIGNATURE
  const s5 = await signSupply({ amount: usd(2), nonce: await nonceOf(USDT0), signer: privateKeyToAccount(generatePrivateKey()) })
  const r5 = await post(s5)
  check('extra: permit signed by someone else -> BAD_SIGNATURE', r5.error === 'BAD_SIGNATURE' && r5.detail?.reason === 'signer_mismatch', JSON.stringify(r5))
  const r5b = await post({ ...s5, nonce: 'abc' })
  check('extra: malformed nonce -> 400 INTERNAL bad_request', r5b.http === 400 && r5b.error === 'INTERNAL' && r5b.detail?.reason === 'bad_request' && r5b.detail?.field === 'nonce', JSON.stringify(r5b))

  // extra: USDC from an address with code (EIP-7702 delegation) -> BAD_SIGNATURE owner_has_code
  const delegated = privateKeyToAccount(generatePrivateKey())
  await test.setCode({ address: delegated.address, bytecode: `0xef0100${POOL.slice(2).toLowerCase()}` })
  const s6 = await signSupply({ amount: usd(2), nonce: 0n, asset: 'USDC', signer: delegated, who: delegated.address })
  const r6 = await post(s6)
  check('extra: USDC owner with code -> BAD_SIGNATURE owner_has_code', r6.error === 'BAD_SIGNATURE' && r6.detail?.reason === 'owner_has_code', JSON.stringify(r6))

  // extra: someone relays the signature before us -> job reported confirmed with their tx
  const s7 = await signSupply({ amount: usd(2), nonce: await nonceOf(USDT0) })
  const sig7 = parseSignature(s7.signature)
  const thirdParty = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: thirdParty.address, value: 10n ** 18n })
  const frontHash = await createWalletClient({ account: thirdParty, chain: polygon, transport }).sendTransaction({
    to: router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'supplyWithPermit',
      args: [USDT0, owner, usd(2), BigInt(s7.deadline), Number(sig7.v), sig7.r, sig7.s],
    }),
  })
  await pub.waitForTransactionReceipt({ hash: frontHash })
  const r7 = await post(s7)
  check('extra: signature already relayed by a third party -> confirmed with their tx', r7.http === 202 && r7.status === 'confirmed' && r7.txHash === frontHash, JSON.stringify(r7))

  // extra: a stuck tx is re-signed with +25 % tip after 45 s
  await test.setAutomine(false)
  const s8 = await signSupply({ amount: usd(1), nonce: await nonceOf(USDT0) })
  const r8 = await post(s8)
  const orig = await pub.getTransaction({ hash: r8.txHash })
  const bumped = await waitFor(async () => {
    const j = await getJob(r8.jobId)
    const line = devLog.find(l => l.includes('"evt":"bump"') && l.includes(r8.jobId))
    return line ? { j, line } : null
  }, 90_000, 'bump')
  await test.mine({ blocks: 1 })
  await test.setAutomine(true)
  const j8 = await settled(r8.jobId)
  const mined = j8.txHash ? await pub.getTransaction({ hash: j8.txHash }) : null
  check(
    'extra: no receipt for 45 s -> replaced with +25 % tip, replacement confirmed',
    j8.status === 'confirmed' && j8.txHash !== r8.txHash && mined && mined.nonce === orig.nonce &&
      mined.maxPriorityFeePerGas === (orig.maxPriorityFeePerGas * 125n + 99n) / 100n,
    `tip ${orig.maxPriorityFeePerGas} -> ${mined?.maxPriorityFeePerGas}, nonce ${orig.nonce}, ${bumped.line.trim().slice(-60)}`,
  )

  // withdraw all -> confirmed, USDT0 back at owner
  const aBefore = await bal(A_USDT0)
  const uBefore = await bal(USDT0)
  const permitValue = (aBefore * 101n) / 100n + 10n
  const deadline = now() + 1200
  const wNonce = await nonceOf(A_USDT0)
  const wSig = await ownerAcct.signTypedData({
    domain: DOMAIN.aUSDT0,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner, spender: router, value: permitValue, nonce: wNonce, deadline: BigInt(deadline) },
  })
  const w = {
    kind: 'withdraw',
    asset: 'USDT0',
    owner,
    amount: maxUint256.toString(),
    permitValue: permitValue.toString(),
    deadline: String(deadline),
    nonce: wNonce.toString(),
    signature: wSig,
  }
  const rw = await measure('withdraw submit', () => post(w))
  check('withdraw all accepted', rw.http === 202 && rw.status === 'submitted', JSON.stringify(rw))
  const jw = await settled(rw.jobId)
  const uAfter = await bal(USDT0)
  const aAfter = await bal(A_USDT0)
  check(
    'withdraw all -> confirmed, USDT0 back at owner',
    jw.status === 'confirmed' && uAfter - uBefore >= aBefore - 2n && aAfter <= 2n && uAfter >= usd(10) - 10n,
    `aUSDT0 ${aBefore} -> ${aAfter}, USDT0 ${uBefore} -> ${uAfter}, withdrawn ${jw.detail?.withdrawn}`,
  )

  await measure('GET /api/relay/:jobId (Worker only)', () => getJob(rw.jobId), CPU_BATCH)
  await measure('baseline: unknown route, 404 (runtime + loopback only)', () => fetch(`${API}/nope`).then(r => r.text()), CPU_BATCH)
  const list = await (await fetch(`${API}/relay/by-owner/${owner}`)).json()
  check('extra: by-owner lists this owner\'s jobs newest first', list.jobs?.length === 4 && list.jobs[0].jobId === rw.jobId, `${list.jobs?.length} jobs`)

  // CPU
  for (const [label, m] of Object.entries(cpu))
    console.log(`CPU  ${label}: ${m.cpuMsPerReq === null ? 'n/a' : `${m.cpuMsPerReq.toFixed(2)} ms`} workerd CPU/req, ${m.wallMsPerReq.toFixed(0)} ms wall/req (n=${m.n})`)
  for (const line of devLog.filter(l => l.includes('"evt":"submit"')).slice(0, 4)) console.log(`LOG  ${line.trim()}`)

  const failed = results.filter(x => !x).length
  console.log(`\n${results.length - failed}/${results.length} PASS`)
  process.exitCode = failed ? 1 : 0
}

main()
  .catch(e => {
    console.log(`FAIL  e2e aborted: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
  .finally(() => {
    // wrangler's stdio pipes keep the event loop alive, so stop it explicitly.
    cleanup()
    process.exit(process.exitCode ?? 0)
  })
