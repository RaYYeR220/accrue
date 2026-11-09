// Read-API answers for the dev mock. Pool names other than Siam (the mock staker's real pool) are
// made up, so no real pool is shown with a verdict it never got.

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
export const TESTNET_VALIDATOR = 'NQ10 UPJX BRF5 UPJX BRF5 UPJX BRF5 UPJX BRF5'
export const TESTNET_VALIDATORS_PREFIX = 'https://validators-api-test.je-cf9.workers.dev/'

interface MockPool {
  address: string
  name: string
  balanceLuna: string
  verdict?: string
  [k: string]: unknown
}

const row = (now: number, o: MockPool): MockPool => ({
  fee: 0.05,
  payoutType: 'restake',
  schedule: 'Every 12 hours',
  stakers: 100,
  accent: '#8a7fd0',
  logo: null,
  ratio: null,
  expectedRatio: 0.95,
  lastPayoutTs: now - 3 * HOUR,
  reasons: [],
  state: 'checked',
  ...o,
})

// GET /api/pools: one pool per verdict code, plus one the API has no verdict for yet.
export function mockPools(now: number) {
  return {
    asOf: now - 10 * 60_000,
    windowDays: 7,
    pools: [
      row(now, { address: SIAM, name: 'Siam Pool', fee: 0.03, schedule: 'Every 3 hours', balanceLuna: '46633342900000', stakers: 104, accent: '#1f3047', verdict: 'PAID_AS_PROMISED', ratio: 0.9748, expectedRatio: 0.97, lastPayoutTs: now - HOUR, reasons: ['Paid 97.5% of earnings against 97.0% promised over 56 cycles.'] }),
      row(now, { address: 'NQ20 HARB 0R00 HARB 0R00 HARB 0R00 HARB 0R00', name: 'Harbor Pool', fee: 0.04, schedule: 'Every minute', balanceLuna: '71312376900000', stakers: 415, accent: '#e19d3e', verdict: 'NOT_ENOUGH_DATA', ratio: 0.93, lastPayoutTs: now - 60_000, reasons: ['Paid ratio within the uncertainty band; not conclusive.'] }),
      row(now, { address: 'NQ98 LANT 3RN0 LANT 3RN0 LANT 3RN0 LANT 3RN0', name: 'Lantern Staking', fee: 0.08, schedule: 'Every 3 hours', balanceLuna: '47185712800000', stakers: 217, accent: '#30cdb5', verdict: 'CANT_VERIFY_ROUTED', ratio: 0.61, expectedRatio: 0.92, reasons: ['34.0% of earnings leave the reward address to non-staker destinations.'] }),
      row(now, { address: 'NQ86 QUAR RY00 QUAR RY00 QUAR RY00 QUAR RY00', name: 'Quarry Pool', fee: null, payoutType: 'none', schedule: null, balanceLuna: '41433020900000', stakers: 33, accent: '#3896a6', verdict: 'NO_PAYOUTS_BY_DESIGN', expectedRatio: null, lastPayoutTs: null, reasons: ['Pool does not pay out; rewards are not distributed to stakers.'] }),
      row(now, { address: 'NQ60 KEST REL0 KEST REL0 KEST REL0 KEST REL0', name: 'Kestrel Pool', balanceLuna: '25795603000000', stakers: 256, accent: '#c08e2f', verdict: 'SHORT', ratio: 0.81, reasons: ['Paid 81.0% of earnings against 95.0% promised over 6 cycles.'] }),
      row(now, { address: 'NQ05 0RCH ARD0 0RCH ARD0 0RCH ARD0 0RCH ARD0', name: 'Orchard Staking', fee: 0.09, payoutType: 'direct', schedule: 'Every day', balanceLuna: '15621953300000', stakers: 112, accent: '#60b3f9', verdict: 'BEHIND_SCHEDULE', expectedRatio: 0.91, lastPayoutTs: now - 52 * HOUR, reasons: ['The last payout is more than twice the advertised interval ago.'] }),
      row(now, { address: 'NQ72 FJ0R D000 FJ0R D000 FJ0R D000 FJ0R D000', name: 'Fjord Pool', fee: 0.06, schedule: 'Payouts over 10 NIM are instant when Fjord Pool is elected .', balanceLuna: '3120000000000', stakers: 14, accent: '#7b9a52', lastPayoutTs: now - 2 * HOUR, state: 'unchecked', reasons: ['Payout Check has not looked at this pool yet.'] }),
      row(now, { address: 'NQ11 B1RC H000 B1RC H000 B1RC H000 B1RC H000', name: 'Birch Pool', fee: null, schedule: 'Every 12 hours', balanceLuna: '1840000000000', stakers: 9, accent: '#9a7b52', expectedRatio: null, lastPayoutTs: null, state: 'no_fee', reasons: ['The pool does not publish a fee, so there is no promised share to check its payouts against.'] }),
    ],
  }
}

// What the testnet validators API lists (its own field names).
export function mockTestnetValidators() {
  return [
    { address: TESTNET_VALIDATOR, name: 'Puddle Testnet Pool', fee: 0.1, payoutType: 'restake', payoutSchedule: 'Every 6 hours', accentColor: '#3aa6a6', logo: null, balance: 1_566_446_162_765, stakers: 12, isListed: true },
    { address: 'NQ16 TEST P00L TEST P00L TEST P00L TEST P00L', name: 'Shallows Testnet Pool', fee: 0.05, payoutType: 'direct', payoutSchedule: 'Every day', accentColor: '#9b7fd0', logo: null, balance: 845_000_000_000, stakers: 5, isListed: true },
    { address: 'NQ87 T1DE 00T1 DE00 T1DE 00T1 DE00 T1DE 00XY', name: 'Unlisted', fee: 0.1, payoutType: 'none', payoutSchedule: '', balance: 1, stakers: 0, isListed: false },
  ]
}

// GET /api/aave: Aave v3 Polygon reserves (rates are realistic, not live).
export function mockAave(now: number, illiquid: boolean) {
  const reserve = (apy: number, rateRay: string, available: string, utilization: number) => ({
    supplyApy: apy,
    liquidityRateRay: rateRay,
    liquidityIndexRay: '1132400000000000000000000000',
    lastUpdate: Math.floor(now / 1000) - 90,
    availableLiquidity: available,
    utilization,
  })
  return {
    asOf: now,
    reserves: {
      USDT0: illiquid ? reserve(0.0366, '35950000000000000000000000', '3000000', 0.9999) : reserve(0.0366, '35950000000000000000000000', '12400000000000', 0.91),
      USDC: reserve(0.0412, '40370000000000000000000000', '8210000000000', 0.89),
    },
  }
}

// GET /api/check/:nim for the mock staker: paid as promised at Siam over the window the worker
// measures (whole UTC days between two midnights, usually 6).
const WINDOW_DAYS = 6
export function mockCheck(staker: { balance: number; delegation: string; inactiveBalance: number; inactiveFrom: number | null; retiredBalance: number } | null, now: number) {
  if (!staker) return { staker: null, pool: null, expectedLuna: null, receivedLuna: null, verdict: null, pct: null, windowDays: 7 }
  const pool = mockPools(now).pools.find(p => p.address === staker.delegation) ?? null
  // Siam's net yield is about 6.7 % a year: what this stake earns over the window
  const expected = Math.round((staker.balance * 0.067 * WINDOW_DAYS) / 365)
  const received = Math.round(expected * 0.992)
  const known = pool !== null && staker.balance > 0
  return {
    staker: {
      activeLuna: String(staker.balance),
      inactiveLuna: String(staker.inactiveBalance),
      inactiveFrom: staker.inactiveFrom,
      retiredLuna: String(staker.retiredBalance),
      delegation: staker.delegation,
    },
    pool,
    expectedLuna: known ? String(expected) : null,
    receivedLuna: known ? String(received) : null,
    // this staker's own verdict follows the pool's in the mock
    verdict: known ? (pool.verdict ?? null) : null,
    pct: known ? 0.992 : null,
    ...(known ? { windowDays: WINDOW_DAYS, fromTs: Math.floor(now / DAY) * DAY - WINDOW_DAYS * DAY, toTs: Math.floor(now / DAY) * DAY } : { windowDays: 7 }),
  }
}
