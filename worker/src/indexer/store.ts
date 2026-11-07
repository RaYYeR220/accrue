import type { HourAgg, StakerDayAgg } from './aggregate'
import type { Cursor } from './scan'

export type SqlValue = string | number | null
export interface Stmt {
  sql: string
  params: SqlValue[]
}

/** luna sums stay far below 2^53 (total supply is ~2.1e15 luna), so D1 numbers are exact. */
export function num(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`luna value out of range: ${v}`)
  return Number(v)
}

/**
 * Optimistic lock on a pool's cursor: aggregate rows and the cursor move only if the cursor is
 * still what this tick read, so two overlapping invocations cannot fold the same txs twice.
 * 'new' = no cursor row yet; null = unconditional (backfill file, which replaces everything).
 */
export type Guard = { pool: string; newestBlock: number | null; resumeHash: string | null } | 'new' | null

function guardSql(g: Guard, pool: string): { sql: string; params: SqlValue[] } {
  if (g === null) return { sql: '1', params: [] }
  if (g === 'new') return { sql: 'NOT EXISTS (SELECT 1 FROM pool_cursor WHERE pool = ?)', params: [pool] }
  return {
    sql: 'EXISTS (SELECT 1 FROM pool_cursor WHERE pool = ? AND newest_block IS ? AND resume_hash IS ?)',
    params: [g.pool, g.newestBlock, g.resumeHash],
  }
}

const marks = (n: number) => Array(n).fill('?').join(', ')

export function hourUpsert(pool: string, h: HourAgg, g: Guard): Stmt {
  const w = guardSql(g, pool)
  return {
    sql:
      'INSERT INTO pool_hour (pool, hour, earned, paid_restake, paid_direct, paid_unverified, other_out, payout_batches, first_payout_ts, last_payout_ts) ' +
      `SELECT ${marks(10)} WHERE ${w.sql} ` +
      'ON CONFLICT(pool, hour) DO UPDATE SET earned = earned + excluded.earned, paid_restake = paid_restake + excluded.paid_restake, ' +
      'paid_direct = paid_direct + excluded.paid_direct, paid_unverified = paid_unverified + excluded.paid_unverified, ' +
      'other_out = other_out + excluded.other_out, payout_batches = payout_batches + excluded.payout_batches, ' +
      'first_payout_ts = CASE WHEN first_payout_ts IS NULL THEN excluded.first_payout_ts ' +
      'WHEN excluded.first_payout_ts IS NULL THEN first_payout_ts ELSE MIN(first_payout_ts, excluded.first_payout_ts) END, ' +
      'last_payout_ts = NULLIF(MAX(COALESCE(last_payout_ts, 0), COALESCE(excluded.last_payout_ts, 0)), 0)',
    params: [
      pool, h.hour, num(h.earned), num(h.paidRestake), num(h.paidDirect), num(h.paidUnverified), num(h.otherOut),
      h.payoutBatches, h.firstPayoutTs, h.lastPayoutTs, ...w.params,
    ],
  }
}

export function stakerDayUpsert(pool: string, s: StakerDayAgg, g: Guard): Stmt {
  const w = guardSql(g, pool)
  return {
    sql:
      `INSERT INTO staker_day (pool, staker, day, received, payouts) SELECT ${marks(5)} WHERE ${w.sql} ` +
      'ON CONFLICT(pool, staker, day) DO UPDATE SET received = received + excluded.received, payouts = payouts + excluded.payouts',
    params: [pool, s.staker, s.day, num(s.received), s.payouts, ...w.params],
  }
}

const CURSOR_COLS = [
  'newest_hash', 'newest_block', 'oldest_block', 'backfill_done', 'resume_hash', 'floor_block',
  'last_payout_block', 'visited_at', 'txs_per_hour', 'reach_ts', 'hole_from_ts', 'hole_to_ts',
] as const

const cursorValues = (c: Cursor): SqlValue[] => [
  c.newestHash, c.newestBlock, c.oldestBlock, c.backfillDone ? 1 : 0, c.resumeHash, c.floorBlock,
  c.lastPayoutBlock, c.visitedAt, c.txsPerHour, c.reachTs, c.holeFromTs, c.holeToTs,
]

/** Must come after the pool's aggregate statements in the same batch: it moves the guard. */
export function cursorWrite(pool: string, c: Cursor, g: Guard): Stmt {
  if (g === null) {
    return {
      sql: `INSERT OR REPLACE INTO pool_cursor (pool, ${CURSOR_COLS.join(', ')}) VALUES (${marks(CURSOR_COLS.length + 1)})`,
      params: [pool, ...cursorValues(c)],
    }
  }
  if (g === 'new') {
    return {
      sql:
        `INSERT INTO pool_cursor (pool, ${CURSOR_COLS.join(', ')}) SELECT ${marks(CURSOR_COLS.length + 1)} ` +
        'WHERE NOT EXISTS (SELECT 1 FROM pool_cursor WHERE pool = ?)',
      params: [pool, ...cursorValues(c), pool],
    }
  }
  return {
    sql:
      `UPDATE pool_cursor SET ${CURSOR_COLS.map((k) => `${k} = ?`).join(', ')} ` +
      'WHERE pool = ? AND newest_block IS ? AND resume_hash IS ?',
    params: [...cursorValues(c), pool, g.newestBlock, g.resumeHash],
  }
}

export function delegationUpsert(address: string, delegation: string, checkedAt: number): Stmt {
  return {
    sql:
      'INSERT INTO recipient_delegation (address, delegation, checked_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(address) DO UPDATE SET delegation = excluded.delegation, checked_at = excluded.checked_at',
    params: [address, delegation, checkedAt],
  }
}

export function metaSet(key: string, value: string, at: number): Stmt {
  return {
    sql:
      'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    params: [key, value, at],
  }
}

export function bind(db: D1Database, stmts: Stmt[]): D1PreparedStatement[] {
  return stmts.map((s) => db.prepare(s.sql).bind(...s.params))
}

const literal = (v: SqlValue) =>
  v === null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${v.replace(/'/g, "''")}'`

/** Inlines the parameters, for SQL files applied with `wrangler d1 execute --file`. */
export function toSql(s: Stmt): string {
  const parts = s.sql.split('?')
  if (parts.length - 1 !== s.params.length) throw new Error(`placeholder count mismatch in: ${s.sql}`)
  return parts.reduce((out, p, i) => out + p + (i < s.params.length ? literal(s.params[i]!) : ''), '') + ';'
}
