import type { AssetKey, Job } from '@accrue/shared'
import { ASSETS, normalizeAddress, STAKING_CONTRACT } from '@accrue/shared'
import { keccak256, maxUint256, numberToHex, padHex, type Address, type Hex } from 'viem'
import { isRecord, sleep } from '../lib/util'
import { POLYGON_RPCS } from '../providers/evm'
import { mockAave, mockCheck, mockPools, mockTestnetValidators, TESTNET_VALIDATORS_PREFIX } from './fixtures'
import { isScenarioName, MOCK_RATES, SCENARIO_NAMES, SCENARIOS, type RelayOutcome, type Scenario, type ScenarioName, type StakerRpc } from './scenarios'

// Dev-only stand-in for Nimiq Pay: window.nimiqPay, window.nimiq, window.ethereum, plus the
// /api/relay*, /api/rates, /api/health, /api/aave, /api/position, /api/pools, /api/check endpoints,
// the testnet validators API and Polygon RPC reads. What a server or a chain would remember (relay
// jobs, balances, the staker) lives in sessionStorage, so a reload finds it again.
// Query: ?mock=<scenario>[&lang=de][&fiat=EUR][&network=testnet][&chain=0x89][&delay=0][&rates=down|stale|fxstale]
// Loaded only through the `import.meta.env.DEV` guard in main.tsx.

export interface MockCall {
  api: 'nimiq' | 'ethereum' | 'nimiqPay'
  method: string
  params: unknown[]
  at: number
}

export interface MockHandle {
  scenario: ScenarioName
  // stands in for the router until one is deployed, so the flows can be driven end to end
  router: Address
  calls: MockCall[]
  // e2e: provider calls made before the first pointerdown/keydown must be 0
  callsBeforeFirstInteraction(): number
  emitAccountsChanged(accounts: string[]): void
}

declare global {
  interface Window {
    __accrueMock?: MockHandle
  }
}

interface Installed {
  fetch: typeof fetch
  onInteract: () => void
}

const installed = new WeakMap<Window, Installed>()

const MOCK_ROUTER = '0x00000000000000000000000000000000000acc01' as Address
const STATE_KEY = 'accrue.mock.v1:'
const NIM_GENESIS = { mainnet: 3_456_000, testnet: 3_032_010 }
const NIM_BLOCK = 41_000_000
const EPOCH = 43_200

interface MockNimTx {
  hash: string
  from: string
  to: string
  value: number
  recipientData: string
  timestamp: number
}

// What a reload must not forget: the relay's jobs and what the chains hold.
interface Persisted {
  jobs: [string, { job: Job; polls: number }][]
  balances: [string, string][]
  nonces: [string, string][]
  principal: [string, string][]
  nim: { luna: Record<string, number>; staker: StakerRpc | null; txs: MockNimTx[] }
}

function loadState(name: string, w: Window): Persisted | null {
  try {
    const raw: unknown = JSON.parse(w.sessionStorage.getItem(STATE_KEY + name) ?? 'null')
    return isRecord(raw) && Array.isArray(raw.jobs) && isRecord(raw.nim) ? (raw as unknown as Persisted) : null
  } catch {
    return null
  }
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const providerError = (message: string, fields: { type?: string; code?: number; data?: unknown }) =>
  Object.assign(new Error(message), fields)

// What the Albatross RPC really answers for unknown stakers and unmined transactions:
// a generic message with the reason in `data`.
const rpcNotFound = (data: string) => providerError('Internal error', { code: -32603, data })

function requestUrl(input: RequestInfo | URL, base: string): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(raw, base)
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body
  if (input instanceof Request) return input.clone().text()
  return ''
}

export function installMock(search: string, w: Window = window): MockHandle {
  const q = new URLSearchParams(search)
  const name = q.get('mock') ?? ''
  if (!isScenarioName(name)) throw new Error(`unknown mock scenario "${name}"; use one of: ${SCENARIO_NAMES.join(', ')}`)
  uninstallMock(w)

  const sc: Scenario = SCENARIOS[name]
  const delay = Number(q.get('delay') ?? 250) || 0
  const saved = loadState(name, w)
  const calls: MockCall[] = []
  let firstInteraction: number | null = null

  function recorded<A extends unknown[], R>(api: MockCall['api'], method: string, fn: (...a: A) => Promise<R>) {
    return async (...a: A): Promise<R> => {
      calls.push({ api, method, params: a, at: Date.now() })
      await sleep(delay)
      return fn(...a)
    }
  }

  // host context
  w.nimiqPay = Object.freeze({
    language: q.get('lang') ?? sc.host.language,
    userFiat: (q.get('fiat') ?? sc.host.userFiat) as NonNullable<Window['nimiqPay']>['userFiat'],
    network: (q.get('network') as 'mainnet' | 'testnet' | null) ?? sc.host.network,
    requestFullscreen: recorded('nimiqPay', 'requestFullscreen', async () => {}),
    exitFullscreen: recorded('nimiqPay', 'exitFullscreen', async () => {}),
    getFullscreen: recorded('nimiqPay', 'getFullscreen', async () => false),
    onFullscreenChange: () => () => {},
    requestDeviceIdentifier: recorded('nimiqPay', 'requestDeviceIdentifier', async () => randomHex(32)),
  })

  // EVM state shared by window.ethereum, the public-RPC stand-in and the read API
  const big = (e: [string, string][]) => new Map<string, bigint>(e.map(([k, v]) => [k, BigInt(v)]))
  const balances = saved ? big(saved.balances) : new Map<string, bigint>(Object.entries(sc.evm.tokens).map(([k, v]) => [k.toLowerCase(), v]))
  const nonces = saved ? big(saved.nonces) : new Map<string, bigint>()
  // what went into Aave through Accrue, per aToken; the starting position is mostly principal
  const principal = saved
    ? big(saved.principal)
    : new Map<string, bigint>(Object.values(ASSETS).map(a => [a.aToken.toLowerCase(), ((sc.evm.tokens[a.aToken] ?? 0n) * 984n) / 1000n]))
  const jobs = new Map<string, { job: Job; polls: number }>(saved?.jobs ?? [])

  // NIM state
  const testnet = w.nimiqPay?.network === 'testnet'
  const nim: Persisted['nim'] = saved?.nim ?? { luna: { ...sc.nim.luna }, staker: sc.nim.staker ? { ...sc.nim.staker } : null, txs: [] }
  // hashes the mock handed out look up as included one block later
  const nimSentTxs = new Set<string>(nim.txs.map(t => t.hash))
  const lunaOf = (a: string) => nim.luna[a] ?? 0

  function save(): void {
    const str = (m: Map<string, bigint>): [string, string][] => [...m].map(([k, v]) => [k, v.toString()])
    const state: Persisted = { jobs: [...jobs], balances: str(balances), nonces: str(nonces), principal: str(principal), nim }
    try {
      w.sessionStorage.setItem(STATE_KEY + name, JSON.stringify(state))
    } catch {
      // the mock still works within one page
    }
  }

  const electionAfter = (block: number) => {
    const g = testnet ? NIM_GENESIS.testnet : NIM_GENESIS.mainnet
    return (Math.floor((block - g) / EPOCH) + 1) * EPOCH + g
  }

  // The chain's side of a staking transaction. The app refuses what the protocol would reject,
  // so the mock does not check the rules again.
  function applyStaking(method: string, tx: Record<string, unknown>): Omit<MockNimTx, 'hash' | 'timestamp'> {
    const wallet = sc.nim.wallet
    const value = typeof tx.value === 'number' ? tx.value : 0
    const fund = sc.nim.htlc && lunaOf(sc.nim.htlc) >= value ? sc.nim.htlc : wallet
    const st = nim.staker
    const staking = (recipientData: string, v = value) => ({ from: wallet, to: STAKING_CONTRACT, value: v, recipientData })
    switch (method) {
      case 'sendNewStakerTransaction':
        nim.luna[fund] = lunaOf(fund) - value
        nim.staker = { balance: value, delegation: String(tx.delegation), inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0 }
        return staking('05')
      case 'sendStakeTransaction':
        nim.luna[fund] = lunaOf(fund) - value
        if (st) st.balance += value
        return staking('06')
      case 'sendSetActiveStakeTransaction':
        if (st) {
          const total = st.balance + st.inactiveBalance
          st.balance = Number(tx.newActiveBalance)
          st.inactiveBalance = total - st.balance
          st.inactiveFrom = st.inactiveBalance > 0 ? electionAfter(NIM_BLOCK) : null
        }
        return staking('08', 0)
      case 'sendUpdateStakerTransaction':
        if (st) {
          st.delegation = String(tx.newDelegation)
          if (tx.reactivateAllStake) {
            st.balance += st.inactiveBalance
            st.inactiveBalance = 0
            st.inactiveFrom = null
          }
        }
        return staking('07', 0)
      case 'sendRetireStakeTransaction': {
        const n = Number(tx.retireStake)
        if (st) {
          st.inactiveBalance -= n
          st.retiredBalance += n
        }
        return staking('09', n)
      }
      case 'sendRemoveStakeTransaction':
        nim.luna[wallet] = lunaOf(wallet) + value
        if (st) {
          st.retiredBalance -= value
          if (st.balance + st.inactiveBalance + st.retiredBalance === 0) nim.staker = null
        }
        return { from: STAKING_CONTRACT, to: wallet, value, recipientData: '' }
      default:
        return { from: wallet, to: String(tx.recipient ?? ''), value, recipientData: '' }
    }
  }

  // NIM provider
  const accountListeners = new Set<(a: string[]) => void>()
  const nimTx = (method: string) =>
    recorded('nimiq', method, async (tx: object): Promise<string> => {
      switch (sc.nim.tx) {
        case 'reject':
          throw providerError('User rejected the request', { type: 'PERMISSION_DENIED', code: 4001 })
        case 'insufficient':
          throw providerError('Insufficient funds', { type: 'INVALID_TRANSACTION', code: -32602 })
        case 'unknown-outcome':
          throw providerError('Transaction sent, outcome unknown', { type: 'TRANSACTION_OUTCOME_UNKNOWN' })
        default: {
          const hash = randomHex(32)
          nim.txs.unshift({ hash, timestamp: Date.now(), ...applyStaking(method, tx as Record<string, unknown>) })
          nimSentTxs.add(hash)
          save()
          return hash
        }
      }
    })

  const nimRead = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    const arg = params?.[0]
    switch (method) {
      case 'getStakerByAddress':
        if (arg === sc.nim.wallet && nim.staker) return { data: { address: sc.nim.wallet, ...nim.staker }, metadata: null }
        throw rpcNotFound(`No staker with address: ${String(arg)}`)
      case 'getAccountByAddress':
        return { data: { address: arg, balance: lunaOf(String(arg)), type: 'basic' }, metadata: null }
      case 'getBlockNumber':
        return { data: NIM_BLOCK, metadata: null }
      case 'getTransactionByHash':
        if (typeof arg === 'string' && nimSentTxs.has(arg)) {
          return { data: { hash: arg, blockNumber: NIM_BLOCK + 1, executionResult: true }, metadata: null }
        }
        throw rpcNotFound(`Transaction not found: ${String(arg)}`)
      case 'getTransactionsByAddress': {
        const a = normalizeAddress(String(arg))
        const mine = nim.txs.filter(t => normalizeAddress(t.from) === a || normalizeAddress(t.to) === a)
        return {
          data: mine.map(t => ({
            hash: t.hash,
            blockNumber: NIM_BLOCK + 1,
            timestamp: t.timestamp,
            from: t.from,
            to: t.to,
            fromType: 0,
            toType: 0,
            value: t.value,
            fee: 0,
            senderData: '',
            recipientData: t.recipientData,
            relatedAddresses: [],
            executionResult: true,
          })),
          metadata: null,
        }
      }
      case 'getValidatorByAddress':
        return { data: { address: arg, jailedFrom: null, retired: false }, metadata: null }
      case 'getPolicyConstants':
        return {
          data: {
            blocksPerBatch: 60,
            batchesPerEpoch: 720,
            blocksPerEpoch: EPOCH,
            minimumStake: 10_000_000,
            blockSeparationTime: 1_000,
            jailEpochs: 8,
            genesisBlockNumber: testnet ? NIM_GENESIS.testnet : NIM_GENESIS.mainnet,
          },
          metadata: null,
        }
      default:
        throw providerError(`Method not found: ${method}`, { code: -32601 })
    }
  }

  const nimiqFake = {
    listAccounts: recorded('nimiq', 'listAccounts', async () => (sc.nim.htlc ? [sc.nim.wallet, sc.nim.htlc] : [sc.nim.wallet])),
    getBalance: recorded('nimiq', 'getBalance', async (address: string) => lunaOf(address)),
    request: recorded('nimiq', 'request', nimRead),
    isConsensusEstablished: recorded('nimiq', 'isConsensusEstablished', async () => true),
    getBlockNumber: recorded('nimiq', 'getBlockNumber', async () => NIM_BLOCK),
    sendNewStakerTransaction: nimTx('sendNewStakerTransaction'),
    sendStakeTransaction: nimTx('sendStakeTransaction'),
    sendSetActiveStakeTransaction: nimTx('sendSetActiveStakeTransaction'),
    sendUpdateStakerTransaction: nimTx('sendUpdateStakerTransaction'),
    sendRetireStakeTransaction: nimTx('sendRetireStakeTransaction'),
    sendRemoveStakeTransaction: nimTx('sendRemoveStakeTransaction'),
    sendBasicTransaction: nimTx('sendBasicTransaction'),
    sendBasicTransactionWithData: nimTx('sendBasicTransactionWithData'),
    // listener plumbing is not a wallet call, so it is not recorded
    on(event: string, l: (a: string[]) => void) {
      if (event === 'accountsChanged') accountListeners.add(l)
      return nimiqFake
    },
    removeListener(_event: string, l: (a: string[]) => void) {
      accountListeners.delete(l)
      return nimiqFake
    },
  }
  w.nimiq = nimiqFake as unknown as Window['nimiq']

  // Nimiq Pay starts on Ethereum (0x1); ?chain=0x89 starts on Polygon to skip the switch step
  let chainId = q.get('chain') ?? '0x1'
  // hashes the wallet "sent", so the public-RPC stand-in can hand back their receipts
  const evmSentTxs = new Set<string>()

  function evmRead(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return '0x89'
      case 'eth_blockNumber':
        return numberToHex(80_000_000)
      case 'eth_getBalance':
        return numberToHex(sc.evm.polWei)
      case 'eth_gasPrice':
        return numberToHex(100n * 10n ** 9n)
      case 'eth_getTransactionReceipt': {
        const hash = String(params[0] ?? '').toLowerCase()
        return evmSentTxs.has(hash) ? { transactionHash: hash, status: '0x1', blockNumber: numberToHex(80_000_001) } : null
      }
      case 'eth_call': {
        const { to, data } = (params[0] ?? {}) as { to?: string; data?: string }
        const token = (to ?? '').toLowerCase()
        const selector = (data ?? '').slice(0, 10)
        if (selector === '0x70a08231') return padHex(numberToHex(balances.get(token) ?? 0n), { size: 32 })
        if (selector === '0x7ecebe00') return padHex(numberToHex(nonces.get(token) ?? 0n), { size: 32 })
        throw providerError('execution reverted', { code: 3 })
      }
      default:
        throw providerError(`method ${method} not supported`, { code: -32601 })
    }
  }

  const ethRequest = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [sc.evm.address]
      case 'eth_chainId':
        return chainId
      case 'wallet_switchEthereumChain':
        chainId = String((params[0] as { chainId?: string } | undefined)?.chainId ?? chainId)
        return null
      case 'wallet_addEthereumChain':
        return null
      case 'eth_signTypedData_v4': {
        if (sc.evm.sign === 'reject') throw providerError('User rejected the request.', { code: 4001 })
        const typed = JSON.parse(String(params[1])) as { domain?: { chainId?: number | string } }
        // the host compares domain.chainId with the active chain only when the domain has one
        if (typed.domain?.chainId !== undefined && numberToHex(BigInt(typed.domain.chainId)) !== chainId) {
          throw providerError('chainId mismatch', { code: -32602 })
        }
        return `0x${randomHex(65)}`
      }
      case 'eth_sendTransaction': {
        if (sc.evm.send === 'reject') throw providerError('User rejected the request.', { code: 4001 })
        if (sc.evm.polWei === 0n) throw providerError('insufficient funds for gas * price + value', { code: -32000 })
        const hash = `0x${randomHex(32)}`
        evmSentTxs.add(hash)
        return hash
      }
      default:
        return evmRead(method, params)
    }
  }

  w.ethereum = {
    async request(args) {
      const params = (args.params ?? []) as unknown[]
      calls.push({ api: 'ethereum', method: args.method, params, at: Date.now() })
      await sleep(delay)
      return ethRequest(args.method, params)
    },
  }

  // relay + read API
  const failedOnce = new Set<string>()
  // lostAnswers: once the first job is in, the connection to the relay is gone for this page
  let relayCut = false

  function relayOutcome(kind: 'supply' | 'withdraw'): RelayOutcome {
    const o = sc.relay[kind]
    if (o.kind === 'error' && o.once) {
      if (failedOnce.has(kind)) return { kind: 'ok' }
      failedOnce.add(kind)
    }
    return o
  }

  // What a confirmed job does on chain: tokens move between the wallet and Aave.
  function settle(job: Job): void {
    const a = ASSETS[job.asset]
    if (!a) return
    const under = a.address.toLowerCase()
    const at = a.aToken.toLowerCase()
    const get = (k: string) => balances.get(k) ?? 0n
    let amount = BigInt(job.amount)
    if (job.kind === 'supply') {
      balances.set(under, get(under) - amount)
      balances.set(at, get(at) + amount)
      principal.set(at, (principal.get(at) ?? 0n) + amount)
      return
    }
    if (amount === maxUint256 || amount > get(at)) amount = get(at)
    balances.set(at, get(at) - amount)
    balances.set(under, get(under) + amount)
    const p = principal.get(at) ?? 0n
    principal.set(at, p > amount ? p - amount : 0n)
  }

  function position(): unknown {
    const assets: Record<string, unknown> = {}
    for (const [k, a] of Object.entries(ASSETS)) {
      const bal = balances.get(a.aToken.toLowerCase()) ?? 0n
      const p = principal.get(a.aToken.toLowerCase()) ?? 0n
      assets[k] = { aTokenBalance: bal.toString(), scaledFromAccrue: p.toString(), principal: p.toString(), earned: (bal - p).toString() }
    }
    return { assets }
  }

  async function api(url: URL, method: string, body: string): Promise<Response | null> {
    const path = url.pathname
    if (path === '/api/rates') {
      const r = q.get('rates')
      if (r === 'down') return json(503, { error: 'RPC_UNAVAILABLE', detail: { reason: 'price_unavailable' } })
      // the sources stopped answering 40 minutes ago: the API serves its last good copy
      const at = Date.now() - (r === 'stale' ? 40 * 60_000 : 0)
      // fxstale: the price is fresh, only the exchange rate is an old copy
      if (r === 'fxstale') return json(200, { ...MOCK_RATES, asOf: at, priceAsOf: at, fxAsOf: at - 40 * 60_000, stale: true, fxStale: true })
      return json(200, { ...MOCK_RATES, asOf: at, priceAsOf: at, fxAsOf: at, ...(r === 'stale' ? { stale: true, priceStale: true, fxStale: true } : {}) })
    }
    if (path === '/api/aave') {
      const illiquid = sc.relay.withdraw.kind === 'error' && sc.relay.withdraw.error === 'AAVE_LIQUIDITY'
      return json(200, mockAave(Date.now(), illiquid))
    }
    if (path.startsWith('/api/position/')) return json(200, position())
    if (path === '/api/pools') return json(200, mockPools(Date.now()))
    if (path.startsWith('/api/check/')) {
      const who = normalizeAddress(decodeURIComponent(path.slice('/api/check/'.length)))
      return json(200, mockCheck(who === normalizeAddress(sc.nim.wallet) ? nim.staker : null, Date.now()))
    }
    if (path === '/api/health') {
      const down = sc.relay.supply.kind === 'down'
      return json(down ? 503 : 200, {
        ok: !down,
        relayer: down ? null : { address: '0x000000000000000000000000000000000000dEaD', polBalance: '5000000000000000000', low: false },
        indexer: { lagMinutes: 3, lastError: null },
        version: 'mock',
      })
    }
    if (!path.startsWith('/api/relay')) return null
    if (relayCut) throw new TypeError('Failed to fetch')
    // what the worker answers when its relayer Durable Object cannot be reached
    if (sc.relay.supply.kind === 'down') return json(503, { error: 'RPC_UNAVAILABLE', detail: { reason: 'relayer_unavailable' } })

    if (path === '/api/relay' && method === 'POST') {
      const req = JSON.parse(body || '{}') as { kind: 'supply' | 'withdraw'; asset: AssetKey; owner: Address; amount: string; signature: Hex }
      const jobId = keccak256(req.signature ?? '0x')
      const existing = jobs.get(jobId)
      if (existing) return json(202, { jobId, status: existing.job.status })
      const outcome = relayOutcome(req.kind)
      if (outcome.kind === 'error') {
        return json(outcome.status, outcome.detail ? { error: outcome.error, detail: outcome.detail } : { error: outcome.error })
      }
      const token = req.kind === 'supply' ? ASSETS[req.asset]?.address : ASSETS[req.asset]?.aToken
      if (token) nonces.set(token.toLowerCase(), (nonces.get(token.toLowerCase()) ?? 0n) + 1n)
      const job: Job = { jobId, owner: req.owner, kind: req.kind, asset: req.asset, amount: req.amount, status: 'queued', createdAt: Date.now() }
      jobs.set(jobId, { job, polls: 0 })
      save()
      if (sc.relay.lostAnswers) {
        relayCut = true
        throw new TypeError('Failed to fetch')
      }
      return json(202, { jobId, status: job.status })
    }

    const byOwner = /^\/api\/relay\/by-owner\/([^/]+)$/.exec(path)
    if (byOwner) {
      const owner = decodeURIComponent(byOwner[1]!).toLowerCase()
      return json(200, { jobs: [...jobs.values()].map(j => j.job).filter(j => j.owner.toLowerCase() === owner) })
    }

    const one = /^\/api\/relay\/(0x[0-9a-fA-F]+)$/.exec(path)
    if (one) {
      const entry = jobs.get(one[1]!)
      if (!entry) return json(404, { error: 'INTERNAL' })
      entry.polls += 1
      if (entry.job.status === 'queued') entry.job = { ...entry.job, status: 'submitted', txHash: `0x${randomHex(32)}` }
      else if (entry.job.status === 'submitted' && sc.relay.confirms) {
        entry.job = { ...entry.job, status: 'confirmed' }
        settle(entry.job)
      }
      save()
      return json(200, entry.job)
    }
    return null
  }

  async function polygonRpc(body: string): Promise<Response> {
    const one = (r: { id?: unknown; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: '2.0', id: r.id ?? null, result: evmRead(r.method, r.params ?? []) }
      } catch (e) {
        const err = e as { code?: number; message?: string }
        return { jsonrpc: '2.0', id: r.id ?? null, error: { code: err.code ?? -32603, message: err.message ?? 'error' } }
      }
    }
    const parsed = JSON.parse(body) as Parameters<typeof one>[0] | Parameters<typeof one>[0][]
    return json(200, Array.isArray(parsed) ? parsed.map(one) : one(parsed))
  }

  const realFetch = w.fetch
  const mockFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input, w.location.href)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (POLYGON_RPCS.some(r => url.href.startsWith(r))) return polygonRpc(await requestBody(input, init))
    if (url.href.startsWith(TESTNET_VALIDATORS_PREFIX)) {
      await sleep(delay)
      return json(200, mockTestnetValidators())
    }
    if (url.origin === w.location.origin && url.pathname.startsWith('/api/')) {
      const body = await requestBody(input, init)
      await sleep(delay)
      const res = await api(url, method, body)
      if (res) return res
    }
    return realFetch.call(w, input, init)
  }
  w.fetch = mockFetch

  const onInteract = () => {
    firstInteraction ??= calls.length
  }
  w.document.addEventListener('pointerdown', onInteract, { capture: true })
  w.document.addEventListener('keydown', onInteract, { capture: true })

  const handle: MockHandle = {
    scenario: name,
    router: MOCK_ROUTER,
    calls,
    callsBeforeFirstInteraction: () => firstInteraction ?? calls.length,
    emitAccountsChanged(accounts) {
      for (const l of accountListeners) l(accounts)
    },
  }
  w.__accrueMock = handle
  installed.set(w, { fetch: realFetch, onInteract })
  return handle
}

export function uninstallMock(w: Window = window): void {
  const prev = installed.get(w)
  if (!prev) return
  w.fetch = prev.fetch
  w.document.removeEventListener('pointerdown', prev.onInteract, { capture: true })
  w.document.removeEventListener('keydown', prev.onInteract, { capture: true })
  delete w.nimiqPay
  delete w.nimiq
  delete w.ethereum
  delete w.__accrueMock
  installed.delete(w)
}
