import { parseSchedule } from '@accrue/shared'
import { canonicalAddress } from './aggregate'
import type { Stmt } from './store'

export const VALIDATORS_API = 'https://validators-api-main.je-cf9.workers.dev/api/v1/validators'

export interface ApiValidator {
  address: string
  name: string
  fee: number | null
  payoutType: string
  payoutSchedule: string
  accentColor: string | null
  logo: string | null
  isListed: boolean
  balance: number
  stakers: number
}

export interface PoolRow {
  address: string
  name: string
  reward_address: string | null
  fee: number | null
  payout_type: string | null
  schedule: string | null
  listed: number
  reward_checked_at: number | null
}

export type PayoutType = 'restake' | 'direct' | 'none'

export function payoutTypeOf(s: string | null | undefined): PayoutType {
  return s === 'restake' || s === 'direct' ? s : 'none'
}

/** Pools whose reward address is worth scanning: listed, paying out, address known. */
export function scannable(p: PoolRow): p is PoolRow & { reward_address: string } {
  return p.listed === 1 && payoutTypeOf(p.payout_type) !== 'none' && !!p.reward_address
}

const MINUTE = 60_000

// Payout interval from the pool's published schedule: the shared "Every N hours" labels plus the
// plain cron forms some pools publish ("0 */6 * * *", "0 * * * *", "*/15 * * * *").
// null when the text is free-form or empty.
export function scheduleMsOf(text: string | null | undefined): number | null {
  if (!text) return null
  const label = parseSchedule(text)
  if (label !== null) return label
  const f = text.trim().split(/\s+/)
  if (f.length !== 5 || f.slice(2).some((x) => x !== '*')) return null
  const [min, hour] = f as [string, string]
  const step = (x: string) => (/^\*\/\d+$/.test(x) ? Number(x.slice(2)) : null)
  if (hour === '*') {
    if (min === '*') return MINUTE
    if (step(min)) return step(min)! * MINUTE
    return /^\d+$/.test(min) ? 60 * MINUTE : null
  }
  if (!/^\d+$/.test(min)) return null
  if (step(hour)) return step(hour)! * 60 * MINUTE
  return /^\d+$/.test(hour) ? 24 * 60 * MINUTE : null
}

export async function fetchValidators(fetchFn: typeof fetch = fetch, url = VALIDATORS_API): Promise<ApiValidator[]> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`validators API HTTP ${res.status}`)
  const list = (await res.json()) as ApiValidator[]
  if (!Array.isArray(list) || list.length === 0) throw new Error('validators API returned no pools')
  return list
}

/** Upserts pool metadata (never touches reward_address) and delists pools the API dropped. */
export function poolStatements(list: ApiValidator[], now: number, opts: { withLogo?: boolean } = {}): Stmt[] {
  const withLogo = opts.withLogo ?? true
  const cols = ['address', 'name', 'fee', 'payout_type', 'schedule', 'balance', 'stakers', 'accent', ...(withLogo ? ['logo'] : []), 'listed', 'updated_at']
  const sets = cols.filter((c) => c !== 'address').map((c) => `${c} = excluded.${c}`).join(', ')
  const stmts: Stmt[] = list.map((v) => ({
    sql: `INSERT INTO pools (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(address) DO UPDATE SET ${sets}`,
    params: [
      canonicalAddress(v.address), v.name, v.fee, payoutTypeOf(v.payoutType), v.payoutSchedule ?? '',
      Math.round(v.balance ?? 0), v.stakers ?? 0, v.accentColor ?? null, ...(withLogo ? [v.logo ?? null] : []),
      v.isListed === false ? 0 : 1, now,
    ],
  }))
  const keep = list.map((v) => canonicalAddress(v.address))
  stmts.push({
    sql: `UPDATE pools SET listed = 0, updated_at = ? WHERE listed = 1 AND address NOT IN (${keep.map(() => '?').join(', ')})`,
    params: [now, ...keep],
  })
  return stmts
}

export function rewardStatement(pool: string, reward: string | null, now: number): Stmt {
  return { sql: 'UPDATE pools SET reward_address = ?, reward_checked_at = ? WHERE address = ?', params: [reward, now, pool] }
}

/** A changed reward address has its own history; index it from the head on, not backwards. */
export function cursorResetStatement(pool: string): Stmt {
  return {
    sql:
      'UPDATE pool_cursor SET newest_hash = NULL, newest_block = NULL, resume_hash = NULL, floor_block = NULL, ' +
      'last_payout_block = NULL, backfill_done = 1 WHERE pool = ?',
    params: [pool],
  }
}
