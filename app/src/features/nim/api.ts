import { normalizeAddress, VERDICTS, type Staker, type Verdict } from '@accrue/shared'
import { HttpError } from '../../providers/errors'
import type { StakingPolicy } from './unstake'

export type Network = 'mainnet' | 'testnet'
export type PayoutType = 'restake' | 'direct' | 'none'

export interface PoolRow {
  address: string
  name: string
  fee: number
  payoutType: PayoutType
  schedule: string | null
  balanceLuna: bigint
  stakers: number
  accent: string | null
  logo: string | null
  verdict: Verdict
  ratio: number | null
  expectedRatio: number
  lastPayoutTs: number | null
  reasons: string[]
}

export interface PoolsResponse {
  asOf: number
  windowDays: number
  pools: PoolRow[]
}

export interface CheckResponse {
  staker: Staker | null
  pool: PoolRow | null
  expectedLuna: bigint | null
  receivedLuna: bigint | null
  verdict: Verdict | null
  pct: number | null
  windowDays: number
}

export const TESTNET_VALIDATORS_URL = 'https://validators-api-test.je-cf9.workers.dev/api/v1/validators'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const isPayoutType = (v: unknown): v is PayoutType => v === 'restake' || v === 'direct' || v === 'none'
const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)

function luna(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  return null
}

// A malformed row is dropped rather than shown with made-up numbers; an unknown verdict
// becomes NOT_ENOUGH_DATA, never a judgement the API did not make.
function parsePoolRow(r: unknown): PoolRow | null {
  if (!isRecord(r) || typeof r.address !== 'string' || typeof r.name !== 'string') return null
  if (!finite(r.fee) || !isPayoutType(r.payoutType)) return null
  const balanceLuna = luna(r.balanceLuna)
  if (balanceLuna === null) return null
  return {
    address: r.address,
    name: r.name,
    fee: r.fee,
    payoutType: r.payoutType,
    schedule: str(r.schedule),
    balanceLuna,
    stakers: finite(r.stakers) ? r.stakers : 0,
    accent: str(r.accent),
    logo: str(r.logo),
    verdict: isVerdict(r.verdict) ? r.verdict : 'NOT_ENOUGH_DATA',
    ratio: finite(r.ratio) ? r.ratio : null,
    expectedRatio: finite(r.expectedRatio) ? r.expectedRatio : 1 - r.fee,
    lastPayoutTs: finite(r.lastPayoutTs) ? r.lastPayoutTs : null,
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : [],
  }
}

export function parsePools(body: unknown): PoolsResponse {
  if (!isRecord(body) || !Array.isArray(body.pools)) throw new Error('pools: unexpected body')
  return {
    asOf: finite(body.asOf) ? body.asOf : 0,
    windowDays: finite(body.windowDays) ? body.windowDays : 7,
    pools: body.pools.map(parsePoolRow).filter((p): p is PoolRow => p !== null),
  }
}

export function parseCheck(body: unknown, address: string): CheckResponse {
  if (!isRecord(body)) throw new Error('check: unexpected body')
  const s = body.staker
  let staker: Staker | null = null
  if (isRecord(s)) {
    const active = luna(s.activeLuna)
    const inactive = luna(s.inactiveLuna)
    const retired = luna(s.retiredLuna)
    // no pool: null on the wire, '' in Staker (as in providers/nimiq parseStaker)
    const delegation = s.delegation === null ? '' : s.delegation
    if (active === null || inactive === null || retired === null || typeof delegation !== 'string') {
      throw new Error('check: unexpected staker')
    }
    staker = {
      address,
      delegation,
      activeLuna: active,
      inactiveLuna: inactive,
      inactiveFrom: finite(s.inactiveFrom) ? s.inactiveFrom : null,
      retiredLuna: retired,
    }
  }
  return {
    staker,
    pool: parsePoolRow(body.pool),
    expectedLuna: luna(body.expectedLuna),
    receivedLuna: luna(body.receivedLuna),
    verdict: isVerdict(body.verdict) ? body.verdict : null,
    pct: finite(body.pct) ? body.pct : null,
    windowDays: finite(body.windowDays) ? body.windowDays : 7,
  }
}

// Testnet has no indexer behind it: rows come straight from the testnet validators API and
// carry no payout verdict beyond what the pool itself declares.
function testnetRow(r: unknown): PoolRow | null {
  if (!isRecord(r) || r.isListed === false) return null
  return parsePoolRow({
    address: r.address,
    name: r.name,
    fee: r.fee,
    payoutType: r.payoutType,
    schedule: r.payoutSchedule,
    balanceLuna: r.balance,
    stakers: r.stakers,
    accent: r.accentColor,
    logo: r.logo,
    verdict: r.payoutType === 'none' ? 'NO_PAYOUTS_BY_DESIGN' : 'NOT_ENOUGH_DATA',
    ratio: null,
    lastPayoutTs: null,
    reasons: [],
  })
}

async function getJson(url: string, f: typeof fetch): Promise<unknown> {
  const res = await f(url, { signal: AbortSignal.timeout(10_000) })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, body)
  return body
}

export async function fetchPools(network: Network, f: typeof fetch = fetch): Promise<PoolsResponse> {
  if (network === 'mainnet') return parsePools(await getJson('/api/pools', f))
  const body = await getJson(TESTNET_VALIDATORS_URL, f)
  if (!Array.isArray(body)) throw new Error('testnet validators: unexpected body')
  const pools = body.map(testnetRow).filter((p): p is PoolRow => p !== null)
  return { asOf: Date.now(), windowDays: 7, pools }
}

export async function fetchCheck(address: string, f: typeof fetch = fetch): Promise<CheckResponse> {
  return parseCheck(await getJson(`/api/check/${normalizeAddress(address)}`, f), address)
}

// The pool's net yield for this staker, from Payout Check's own numbers: what the stake should
// have earned over the window, per active NIM, scaled to a year.
export function poolApr(check: CheckResponse): number | null {
  const active = check.staker?.activeLuna ?? 0n
  if (check.expectedLuna === null || active === 0n || check.windowDays <= 0) return null
  return (Number(check.expectedLuna) / Number(active)) * (365 / check.windowDays)
}

const DEFAULTS = { blocksPerEpoch: 43_200, blockSeparationTimeMs: 1_000, genesisBlockNumber: 0, jailEpochs: 8 }

export function parsePolicy(raw: unknown): Required<StakingPolicy> {
  if (!isRecord(raw)) throw new Error('policy: unexpected body')
  const pick = (v: unknown, d: number) => (finite(v) ? v : d)
  const p = {
    blocksPerEpoch: pick(raw.blocksPerEpoch, DEFAULTS.blocksPerEpoch),
    blockSeparationTimeMs: pick(raw.blockSeparationTime, DEFAULTS.blockSeparationTimeMs),
    genesisBlockNumber: pick(raw.genesisBlockNumber, DEFAULTS.genesisBlockNumber),
    jailEpochs: pick(raw.jailEpochs, DEFAULTS.jailEpochs),
  }
  if (p.blocksPerEpoch <= 0 || p.blockSeparationTimeMs <= 0) throw new Error('policy: bad constants')
  return p
}

export type TxStatus = 'confirmed' | 'failed' | 'pending'

// The RPC puts the reason in `data` ({code:-32603, message:"Internal error", data:"Transaction not
// found: ..."}), so both fields are read.
function errorText(e: unknown): string {
  if (!isRecord(e)) return String(e)
  return [e.message, e.data].filter(v => typeof v === 'string').join(' ')
}

// Only a host that cannot look transactions up at all stops the wait early.
const lookupUnsupported = (e: unknown) => (isRecord(e) && e.code === -32601) || /method not found/i.test(errorText(e))

// A sent staking transaction can still fail on chain (included with executionResult false) or be
// dropped and never appear; only a lookup tells. Fail-closed: only an explicit executionResult
// true is "confirmed". Not-mined-yet and transient errors keep polling until the timeout;
// "pending" means we could not tell.
export async function waitForNimTx(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  hash: string,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TxStatus> {
  const intervalMs = opts.intervalMs ?? 2_000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (let waited = 0; ; waited += intervalMs) {
    try {
      const tx = await rpc('getTransactionByHash', [hash])
      if (isRecord(tx) && finite(tx.blockNumber)) {
        if (tx.executionResult === true) return 'confirmed'
        if (tx.executionResult === false) return 'failed'
      }
    } catch (e) {
      if (lookupUnsupported(e)) return 'pending'
    }
    if (waited + intervalMs > timeoutMs) return 'pending'
    await sleep(intervalMs)
  }
}
