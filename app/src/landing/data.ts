import { isValidNimAddress, VERDICTS, type AssetKey, type Verdict } from '@accrue/shared'
import { fetchJson } from '../lib/api'
import { isRecord } from '../lib/util'
import type { PayoutType } from './schedule'

export interface PoolRow {
  address: string
  name: string
  fee: number | null
  payoutType: PayoutType
  schedule: string
  balanceLuna: bigint
  stakers: number
  accent: string | null
  verdict: Verdict | null
  ratio: number | null
  expectedRatio: number | null
  lastPayoutTs: number | null
  reasons: string[]
}

export interface PoolsData {
  source: 'live' | 'snapshot'
  asOf: number
  windowDays: number
  pools: PoolRow[]
}

export interface StakerInfo {
  activeLuna: bigint
  inactiveLuna: bigint
  inactiveFrom: number | null
  retiredLuna: bigint
  delegation: string | null
}

export interface CheckResult {
  staker: StakerInfo | null
  pool: PoolRow | null
  expectedLuna: bigint | null
  receivedLuna: bigint | null
  verdict: Verdict | null
  pct: number | null
  windowDays: number
}

export interface AssetPosition {
  aTokenBalance: bigint
  scaledFromAccrue: bigint
  principal: bigint
  earned: bigint
}

export interface PositionResult {
  assets: Partial<Record<AssetKey, AssetPosition>>
}

const ASSET_KEYS: readonly AssetKey[] = ['USDT0', 'USDC']
const PAYOUT_TYPES: readonly PayoutType[] = ['restake', 'direct', 'none']

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const finiteOrNull = (v: unknown): number | null => (finite(v) ? v : null)
const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)

// Amounts travel as decimal strings; small ones may come as safe integers.
function toBig(v: unknown, what: string, signed = false): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && (signed || v >= 0)) return BigInt(v)
  if (typeof v === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(v)) return BigInt(v)
  throw new Error(`bad amount: ${what}`)
}

const optBig = (v: unknown, what: string): bigint | null => (v === undefined || v === null ? null : toBig(v, what))

function parsePoolRow(v: unknown): PoolRow {
  if (!isRecord(v)) throw new Error('pool: not an object')
  const { address, name, fee, payoutType, schedule, stakers, accent, reasons } = v
  if (typeof address !== 'string' || !isValidNimAddress(address)) throw new Error('pool: bad address')
  if (typeof name !== 'string' || !name.trim()) throw new Error('pool: bad name')
  if (fee !== null && !(finite(fee) && fee >= 0 && fee <= 1)) throw new Error('pool: bad fee')
  if (typeof payoutType !== 'string' || !(PAYOUT_TYPES as readonly string[]).includes(payoutType)) throw new Error('pool: bad payoutType')
  if (!(Number.isSafeInteger(stakers) && (stakers as number) >= 0)) throw new Error('pool: bad stakers')
  return {
    address,
    name: name.trim(),
    fee,
    payoutType: payoutType as PayoutType,
    schedule: typeof schedule === 'string' ? schedule : '',
    balanceLuna: toBig(v.balanceLuna, 'balanceLuna'),
    stakers: stakers as number,
    accent: typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : null,
    verdict: isVerdict(v.verdict) ? v.verdict : null,
    ratio: finiteOrNull(v.ratio),
    expectedRatio: finiteOrNull(v.expectedRatio),
    lastPayoutTs: finiteOrNull(v.lastPayoutTs),
    reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [],
  }
}

const tryRow = (v: unknown): PoolRow | null => {
  try {
    return parsePoolRow(v)
  } catch {
    return null
  }
}

export const byStake = (a: PoolRow, b: PoolRow) => (a.balanceLuna > b.balanceLuna ? -1 : a.balanceLuna < b.balanceLuna ? 1 : 0)

// A broken envelope throws (the landing then shows the dated snapshot); a single broken row is
// dropped so one bad pool can't take the whole scoreboard down.
export function parsePools(body: unknown): PoolsData {
  if (!isRecord(body) || !finite(body.asOf) || !Array.isArray(body.pools)) throw new Error('pools: bad envelope')
  const pools = body.pools.map(tryRow).filter((p): p is PoolRow => p !== null)
  if (!pools.length) throw new Error('pools: no usable rows')
  return { source: 'live', asOf: body.asOf, windowDays: finite(body.windowDays) ? body.windowDays : 7, pools: pools.sort(byStake) }
}

export function parseCheck(body: unknown): CheckResult {
  if (!isRecord(body) || !('staker' in body)) throw new Error('check: bad envelope')
  let staker: StakerInfo | null = null
  if (body.staker !== null) {
    const s = body.staker
    if (!isRecord(s)) throw new Error('check: bad staker')
    staker = {
      activeLuna: toBig(s.activeLuna, 'activeLuna'),
      inactiveLuna: toBig(s.inactiveLuna ?? 0, 'inactiveLuna'),
      inactiveFrom: finiteOrNull(s.inactiveFrom),
      retiredLuna: toBig(s.retiredLuna ?? 0, 'retiredLuna'),
      delegation: typeof s.delegation === 'string' && s.delegation.trim() ? s.delegation : null,
    }
  }
  return {
    staker,
    pool: body.pool === undefined || body.pool === null ? null : parsePoolRow(body.pool),
    expectedLuna: optBig(body.expectedLuna, 'expectedLuna'),
    receivedLuna: optBig(body.receivedLuna, 'receivedLuna'),
    verdict: isVerdict(body.verdict) ? body.verdict : null,
    pct: finiteOrNull(body.pct),
    windowDays: finite(body.windowDays) ? body.windowDays : 7,
  }
}

export function parsePosition(body: unknown): PositionResult {
  if (!isRecord(body) || !isRecord(body.assets)) throw new Error('position: bad envelope')
  const assets: PositionResult['assets'] = {}
  for (const key of ASSET_KEYS) {
    const a = body.assets[key]
    if (a === undefined) continue
    if (!isRecord(a)) throw new Error(`position: bad ${key}`)
    assets[key] = {
      aTokenBalance: toBig(a.aTokenBalance, 'aTokenBalance'),
      scaledFromAccrue: toBig(a.scaledFromAccrue ?? 0, 'scaledFromAccrue'),
      principal: toBig(a.principal ?? 0, 'principal'),
      earned: toBig(a.earned ?? 0, 'earned', true),
    }
  }
  return { assets }
}

export type CheckView =
  | { kind: 'notStaking' }
  | { kind: 'unlisted'; delegation: string | null; activeLuna: bigint }
  | {
      kind: 'verdict'
      pool: PoolRow
      staker: StakerInfo
      verdict: Verdict
      expectedLuna: bigint | null
      receivedLuna: bigint | null
      pct: number | null
      windowDays: number
    }

// A staker in a listed pool always gets a verdict; when the API has none yet that is
// "Not enough data", which is what the API itself answers below three cycles.
export function describeCheck(r: CheckResult): CheckView {
  if (!r.staker) return { kind: 'notStaking' }
  if (!r.pool) return { kind: 'unlisted', delegation: r.staker.delegation, activeLuna: r.staker.activeLuna }
  return {
    kind: 'verdict',
    pool: r.pool,
    staker: r.staker,
    verdict: r.verdict ?? 'NOT_ENOUGH_DATA',
    expectedLuna: r.expectedLuna,
    receivedLuna: r.receivedLuna,
    pct: r.pct,
    windowDays: r.windowDays,
  }
}

export type PositionView =
  | { kind: 'empty' }
  | { kind: 'position'; rows: { asset: AssetKey; aTokenBalance: bigint; principal: bigint; earned: bigint }[] }

export function describePosition(p: PositionResult): PositionView {
  const rows = ASSET_KEYS.flatMap(asset => {
    const a = p.assets[asset]
    return a && (a.aTokenBalance > 0n || a.principal > 0n) ? [{ asset, aTokenBalance: a.aTokenBalance, principal: a.principal, earned: a.earned }] : []
  })
  return rows.length ? { kind: 'position', rows } : { kind: 'empty' }
}

// NIM addresses go in compact form so the path has no spaces.
const compact = (nim: string) => nim.replace(/\s+/g, '')

export const fetchPools = async (): Promise<PoolsData> => parsePools(await fetchJson('/api/pools', {}, 10_000))
export const fetchCheck = async (nim: string): Promise<CheckResult> => parseCheck(await fetchJson(`/api/check/${compact(nim)}`, {}, 15_000))
export const fetchPosition = async (evm: string): Promise<PositionResult> => parsePosition(await fetchJson(`/api/position/${evm}`, {}, 15_000))
