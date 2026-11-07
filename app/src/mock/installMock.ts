import type { AssetKey, Job } from '@accrue/shared'
import { ASSETS } from '@accrue/shared'
import { keccak256, numberToHex, padHex, type Address, type Hex } from 'viem'
import { POLYGON_RPCS } from '../providers/evm'
import { isScenarioName, MOCK_RATES, SCENARIO_NAMES, SCENARIOS, type RelayOutcome, type Scenario, type ScenarioName } from './scenarios'

// Dev-only stand-in for Nimiq Pay: window.nimiqPay, window.nimiq, window.ethereum,
// plus the /api/relay*, /api/rates, /api/health endpoints and Polygon RPC reads.
// Query: ?mock=<scenario>[&lang=de][&fiat=EUR][&network=testnet][&chain=0x89][&delay=0]
// Loaded only through the `import.meta.env.DEV` guard in main.tsx.

export interface MockCall {
  api: 'nimiq' | 'ethereum' | 'nimiqPay'
  method: string
  params: unknown[]
  at: number
}

export interface MockHandle {
  scenario: ScenarioName
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

const sleep = (ms: number) => (ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve())

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const providerError = (message: string, fields: { type?: string; code?: number }) => Object.assign(new Error(message), fields)

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

  // NIM provider
  const accountListeners = new Set<(a: string[]) => void>()
  const nimTx = (method: string) =>
    recorded('nimiq', method, async (_tx: object): Promise<string> => {
      switch (sc.nim.tx) {
        case 'reject':
          throw providerError('User rejected the request', { type: 'PERMISSION_DENIED', code: 4001 })
        case 'insufficient':
          throw providerError('Insufficient funds', { type: 'INVALID_TRANSACTION', code: -32602 })
        case 'unknown-outcome':
          throw providerError('Transaction sent, outcome unknown', { type: 'TRANSACTION_OUTCOME_UNKNOWN' })
        default:
          return randomHex(32)
      }
    })

  const nimRead = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    const arg = params?.[0]
    switch (method) {
      case 'getStakerByAddress':
        if (arg === sc.nim.wallet && sc.nim.staker) return { data: { address: sc.nim.wallet, ...sc.nim.staker }, metadata: null }
        throw providerError(`Staker not found: ${String(arg)}`, { code: -32603 })
      case 'getAccountByAddress':
        return { data: { address: arg, balance: sc.nim.luna[String(arg)] ?? 0, type: 'basic' }, metadata: null }
      case 'getBlockNumber':
        return { data: 41_000_000, metadata: null }
      case 'getPolicyConstants':
        return {
          data: { blocksPerBatch: 60, batchesPerEpoch: 720, blocksPerEpoch: 43_200, minimumStake: 10_000_000 },
          metadata: null,
        }
      default:
        throw providerError(`Method not found: ${method}`, { code: -32601 })
    }
  }

  const nimiqFake = {
    listAccounts: recorded('nimiq', 'listAccounts', async () => (sc.nim.htlc ? [sc.nim.wallet, sc.nim.htlc] : [sc.nim.wallet])),
    getBalance: recorded('nimiq', 'getBalance', async (address: string) => sc.nim.luna[address] ?? 0),
    request: recorded('nimiq', 'request', nimRead),
    isConsensusEstablished: recorded('nimiq', 'isConsensusEstablished', async () => true),
    getBlockNumber: recorded('nimiq', 'getBlockNumber', async () => 41_000_000),
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

  // EVM state shared by window.ethereum and the public-RPC stand-in
  // Nimiq Pay starts on Ethereum (0x1); ?chain=0x89 starts on Polygon to skip the switch step
  let chainId = q.get('chain') ?? '0x1'
  const balances = new Map<string, bigint>(Object.entries(sc.evm.tokens).map(([k, v]) => [k.toLowerCase(), v]))
  const nonces = new Map<string, bigint>()
  // hashes the wallet "sent", so the public-RPC stand-in can hand back their receipts
  const sentTxs = new Set<string>()

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
        return sentTxs.has(hash) ? { transactionHash: hash, status: '0x1', blockNumber: numberToHex(80_000_001) } : null
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
        sentTxs.add(hash)
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
  const jobs = new Map<string, { job: Job; polls: number }>()
  const failedOnce = new Set<string>()

  function relayOutcome(kind: 'supply' | 'withdraw'): RelayOutcome {
    const o = sc.relay[kind]
    if (o.kind === 'error' && o.once) {
      if (failedOnce.has(kind)) return { kind: 'ok' }
      failedOnce.add(kind)
    }
    return o
  }

  async function api(url: URL, method: string, body: string): Promise<Response | null> {
    const path = url.pathname
    if (path === '/api/rates') return json(200, { ...MOCK_RATES, asOf: Date.now() })
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
    if (sc.relay.supply.kind === 'down') return new Response('Service Unavailable', { status: 503 })

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
      else if (entry.job.status === 'submitted' && sc.relay.confirms) entry.job = { ...entry.job, status: 'confirmed' }
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
