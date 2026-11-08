import type { NimTx } from '@accrue/shared'
import { aggregate, type Oracle } from '../src/indexer/aggregate'
import { bind, cursorWrite, hourUpsert, stakerDayUpsert } from '../src/indexer/store'
import { freshCursor } from '../src/indexer/scan'
import type { FakeD1 } from './d1'

// The 21 listed pools as the validators API described them on Nov 8, 2026 (logos left out).
// [address, name, fee, payoutType, schedule, balance (luna), stakers, accent]
export const POOLS: [string, string, number | null, string, string, number, number, string][] = [
  ['NQ05 U1RF QJNH JCS1 RDQX 4M3Y 60KR K6CN 5LKC', 'NimiqHub Staking', 0.05, 'restake', 'Every minute', 71320774083382, 415, '#e19d3e'],
  ['NQ29 FBVT B4GM S27H UBP4 1MTC GNKQ VPBT 099M', '$NIM_pool', 0, 'restake', 'Every 4 hours', 63232652152940, 332, '#FFC107'],
  ['NQ15 5JNS U7CE RAH5 3T02 F8A9 JCT6 QMG9 7TSV', 'ObsidianStake', 0.05, 'direct', 'Every 12 hours', 57210862661095, 154, '#ad46ff'],
  ['NQ53 M1NT S3JD TAGM CBTK 01PX YD3U B1DE GYHB', 'Mint Pool', 0.05, 'restake', 'Every 3 hours', 47192701554168, 217, '#30cdb5'],
  ['NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH', 'Siam Pool', 0.03, 'restake', 'Every 3 hours', 46639086111650, 104, '#1f3047'],
  ['NQ02 31N6 3KM5 T6G5 22TN EPF5 5XPY RLHK RMB3', 'NimiqPocket', 0.01, 'restake', 'Payouts over 10 NIM are instant when NimiqPocket is elected .', 43942846568674, 195, '#F39C12'],
  ['NQ60 GH2T VEA2 CUR5 SXAD QU9B 7ELD YMG5 5T7U', 'Private Whalidator', null, 'none', '', 41433020894312, 33, '#3896a6'],
  ['NQ44 V95C ABVY RARR SBMC V8VE M6UH EJP0 RXYQ', 'nim.re Staking Pool', 0.0333, 'restake', 'Every 12 hours', 30419462180852, 283, '#F6E44D'],
  ['NQ83 4MVH 53Q4 AL3B Q097 55GJ LUQ3 GSF0 85B7', 'NimiqCafe Staking', 0.03, 'restake', 'Every 1 minute', 29611073156978, 64, '#754b47'],
  ['NQ08 LMAK 00XK YYN9 CDXV ADVG CL0U HUBM J670', 'Ritvars Staking', 0.02, 'restake', 'Every 12 hours', 29188360657089, 172, '#DCFDDD'],
  ['NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7', 'Garuda Pool', 0.05, 'restake', 'Every 12 hours', 25798184421741, 256, '#c08e2f'],
  ['NQ08 RS08 LTKL 62QL B954 S9YP 0G3R XVKM RU2Y', 'Nimiq Marketing Pool', 0, 'restake', '0 * * * *', 18275323530155, 72, '#D7A711'],
  ['NQ96 X97C 94M1 6MV3 KJ0G JA5U 6VB4 6Y63 EUH4', 'Keyring Staking', 0.05, 'restake', 'Every 12 hours', 15624063280906, 112, '#60b3f9'],
  ['NQ32 1U9X 7P3X B2H5 XA00 5LC2 5KFE VBQE X3BU', 'Nimiq.Fun', 0.025, 'direct', 'Every 12 hours', 9507291780125, 44, '#FFD233'],
  ['NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082', 'Nimiq Base Staking', 0, 'restake', '', 7917744996874, 15, '#F09008'],
  ['NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY', 'ImpactZero stake', 0, 'restake', '', 5088002311565, 24, '#07c1ff'],
  ['NQ51 SURF MCTM AQXM 15PA K9FX 8EEX 29BE VGH8', 'Nimiq Surf', 0, 'none', '', 2595117144962, 6, '#e19d3e'],
  ['NQ24 8V0E L24U TGQ6 KAGA 0KGY SR4F GVV1 SXNA', 'Synapse LN - Nimiq', 0.01, 'restake', '', 526317351774, 11, '#ffc107'],
  ['NQ40 FC4D HAT6 9N1H P52H P4FX QL8P CE6Y 10VT', 'NODENIMIQ1.NIMIQ-JU.FR by @Ju', 0.01, 'restake', '', 74303996209, 12, '#0582CA'],
  ['NQ51 7BS3 0HVH 9R5M TUDH C5PG 490G S7XT KD4D', 'NODENIMIQ2.NIMIQ-JU.FR by @Ju', 0.01, 'restake', '', 47903764097, 11, '#0582CA'],
  ['NQ32 V144 LJDN FJND NLCQ PKBU HTPF KD8G J664', 'CHIPMUNK POOL', 0.05, 'direct', '0 */6 * * *', 10319900000, 4, '#bd802f'],
]

export const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
export const GARUDA = 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7'

export function seedPools(db: FakeD1, now: number, logos: Record<string, string> = {}) {
  const stmt = db.db.prepare(
    'INSERT INTO pools (address, name, reward_address, fee, payout_type, schedule, balance, stakers, accent, logo, listed, updated_at, reward_checked_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)',
  )
  for (const [address, name, fee, type, schedule, balance, stakers, accent] of POOLS) {
    stmt.run(address, name, type === 'none' ? null : address, fee, type, schedule, balance, stakers, accent, logos[address] ?? null, now, now)
  }
}

/** Folds a pool's history into pool_hour / staker_day and leaves a cursor whose data reaches `reachTs`. */
export async function seedHistory(db: FakeD1, pool: string, txs: NimTx[], opts: { reachTs?: number; oracle?: Oracle } = {}) {
  const agg = aggregate(txs, { rewardAddress: pool }, opts.oracle ?? (() => true))
  const top = txs.reduce((m, t) => (t.blockNumber > m.blockNumber ? t : m), txs[0]!)
  const reachTs = opts.reachTs ?? top.timestamp
  const cursor = {
    ...freshCursor(), newestHash: top.hash, newestBlock: top.blockNumber, oldestBlock: Math.min(...txs.map((t) => t.blockNumber)),
    backfillDone: true, lastPayoutBlock: agg.lastPayoutBlock, visitedAt: reachTs, txsPerHour: 100, reachTs,
  }
  await db.batch(
    bind(db as never, [
      ...agg.hours.map((h) => hourUpsert(pool, h, null)),
      ...agg.stakerDays.map((s) => stakerDayUpsert(pool, s, null)),
      cursorWrite(pool, cursor, null),
    ]) as never,
  )
  return { agg, reachTs }
}

/**
 * A week of history from a 12 h recording: the recording repeated every `periodS` seconds (blocks and
 * time move together, one block per second), so payout cadence and stake shares stay the recorded ones.
 */
export function tile(txs: NimTx[], copies: number, periodS = 45_000, scalePayouts = 1, pool = SIAM): NimTx[] {
  const out: NimTx[] = []
  for (let k = 0; k < copies; k++) {
    for (const t of txs) {
      const value = t.from === pool && scalePayouts !== 1 ? Math.round(t.value * scalePayouts) : t.value
      out.push({ ...t, hash: `${t.hash}-${k}`, blockNumber: t.blockNumber + k * periodS, timestamp: t.timestamp + k * periodS * 1000, value })
    }
  }
  return out
}
