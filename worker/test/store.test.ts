import { describe, expect, it } from 'vitest'
import { aggregate, delegationOracle, payoutRecipients } from '../src/indexer/aggregate'
import { bind, cursorWrite, hourUpsert, hourUpserts, stakerDayUpsert, stakerDayUpserts, type Guard, type Stmt } from '../src/indexer/store'
import { freshCursor } from '../src/indexer/scan'
import { load } from './chain'
import { FakeD1 } from './d1'

const garuda = load('garuda-2026-11-07.json')
const POOL = garuda.address
const oracle = delegationOracle(new Map([...payoutRecipients(garuda.txs, POOL)].map((a) => [a, POOL])), POOL)
// two overlapping slices, so the second one adds onto rows the first wrote
const first = aggregate(garuda.txs.slice(0, 4_000), { rewardAddress: POOL }, oracle)
const second = aggregate(garuda.txs.slice(3_000), { rewardAddress: POOL }, oracle)
const dump = (db: FakeD1) => ({
  hours: db.query('SELECT * FROM pool_hour ORDER BY pool, hour'),
  days: db.query('SELECT * FROM staker_day ORDER BY pool, staker, day'),
})

describe('multi-row upserts', () => {
  it('leave exactly the rows one statement per row leaves, in far fewer statements, each under 100 bound parameters', async () => {
    const one = new FakeD1()
    const many = new FakeD1()
    let single = 0
    let multi = 0
    for (const agg of [first, second]) {
      const a: Stmt[] = [...agg.hours.map((h) => hourUpsert(POOL, h, null)), ...agg.stakerDays.map((s) => stakerDayUpsert(POOL, s, null))]
      const b: Stmt[] = [...hourUpserts(POOL, agg.hours, null), ...stakerDayUpserts(POOL, agg.stakerDays, null)]
      single += a.length
      multi += b.length
      for (const s of b) expect(s.params.length).toBeLessThanOrEqual(100)
      await one.batch(bind(one as never, a) as never)
      await many.batch(bind(many as never, b) as never)
    }
    expect(dump(many)).toEqual(dump(one))
    expect(dump(one).days.length).toBeGreaterThan(1_000)
    expect(multi * 10).toBeLessThan(single)
  })

  it('write nothing when the cursor moved since the tick read it', async () => {
    const db = new FakeD1()
    const c = { ...freshCursor(), newestBlock: 5, newestHash: 'h', backfillDone: true }
    await db.batch(bind(db as never, [cursorWrite(POOL, c, null)]) as never)
    const stale: Guard = { pool: POOL, newestBlock: 4, resumeHash: null }
    await db.batch(bind(db as never, [...hourUpserts(POOL, first.hours, stale), ...stakerDayUpserts(POOL, first.stakerDays, stale)]) as never)
    expect(dump(db)).toEqual({ hours: [], days: [] })
    const current: Guard = { pool: POOL, newestBlock: 5, resumeHash: null }
    await db.batch(bind(db as never, [...hourUpserts(POOL, first.hours, current), ...stakerDayUpserts(POOL, first.stakerDays, current)]) as never)
    expect(dump(db).days.length).toBe(first.stakerDays.length)
    expect(stakerDayUpserts(POOL, [], current)).toEqual([])
  })
})
