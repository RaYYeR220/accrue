import type { Page, Route } from '@playwright/test'

export const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
export const SIAM_STAKER = 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST'
export const EVM_OWNER = '0x4E9C5b1c7A9d3f2f0A6B8C1D2E3F4a5b6C7d8e9f'

const HOUR = 3_600_000
const now = Date.now()

const row = (o: Record<string, unknown>) => ({
  fee: 0.05,
  payoutType: 'restake',
  schedule: 'Every 12 hours',
  stakers: 100,
  accent: '#c08e2f',
  ratio: null,
  expectedRatio: 0.95,
  lastPayoutTs: now - 3 * HOUR,
  reasons: [],
  ...o,
})

// One row per verdict code, shaped like GET /api/pools.
export const LIVE_POOLS = {
  asOf: now - 10 * 60_000,
  windowDays: 7,
  pools: [
    row({ address: 'NQ05 U1RF QJNH JCS1 RDQX 4M3Y 60KR K6CN 5LKC', name: 'NimiqHub Staking', schedule: 'Every minute', balanceLuna: '71312376900000', stakers: 415, accent: '#e19d3e', verdict: 'NOT_ENOUGH_DATA', reasons: ['Paid ratio within the uncertainty band; not conclusive.'], ratio: 0.93 }),
    row({ address: 'NQ53 M1NT S3JD TAGM CBTK 01PX YD3U B1DE GYHB', name: 'Mint Pool', schedule: 'Every 3 hours', balanceLuna: '47185712800000', stakers: 217, accent: '#30cdb5', verdict: 'CANT_VERIFY_ROUTED', ratio: 0.61, reasons: ['34.0% of earnings leave the reward address to non-staker destinations.'] }),
    row({ address: SIAM, name: 'Siam Pool', fee: 0.03, schedule: 'Every 3 hours', balanceLuna: '46633342900000', stakers: 104, accent: '#1f3047', verdict: 'PAID_AS_PROMISED', ratio: 0.9748, expectedRatio: 0.97, reasons: ['Paid 97.5% of earnings against 97.0% promised.'] }),
    row({ address: 'NQ60 GH2T VEA2 CUR5 SXAD QU9B 7ELD YMG5 5T7U', name: 'Private Whalidator', fee: null, payoutType: 'none', schedule: '', balanceLuna: '41433020900000', stakers: 33, accent: '#3896a6', verdict: 'NO_PAYOUTS_BY_DESIGN', expectedRatio: 1, lastPayoutTs: null, reasons: ['Pool does not pay out; rewards are not distributed to stakers.'] }),
    row({ address: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7', name: 'Garuda Pool', balanceLuna: '25795603000000', stakers: 256, verdict: 'SHORT', ratio: 0.81, reasons: ['Paid 81.0% of earnings against 95.0% promised over 6 cycles.'] }),
    row({ address: 'NQ96 X97C 94M1 6MV3 KJ0G JA5U 6VB4 6Y63 EUH4', name: 'Keyring Staking', balanceLuna: '15621953300000', stakers: 112, accent: '#60b3f9', verdict: 'BEHIND_SCHEDULE', lastPayoutTs: now - 40 * HOUR, reasons: ['The last payout is more than twice the advertised interval ago.'] }),
  ],
}

export const CHECK_SIAM = {
  staker: { activeLuna: '120000000000', inactiveLuna: '0', inactiveFrom: null, retiredLuna: '0', delegation: SIAM },
  pool: LIVE_POOLS.pools[2],
  expectedLuna: '1250000',
  receivedLuna: '1240000',
  verdict: 'PAID_AS_PROMISED',
  pct: 0.992,
  windowDays: 7,
}

export const POSITION = {
  assets: {
    USDT0: { aTokenBalance: '12345678', scaledFromAccrue: '11900000', principal: '12000000', earned: '345678' },
    USDC: { aTokenBalance: '0', scaledFromAccrue: '0', principal: '0', earned: '0' },
  },
}

export const RATES = { asOf: now, nimUsd: 0.00027882, fx: { USD: 1, EUR: 0.897, CRC: 453.5, GMD: 72 }, source: ['test'] }

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

export interface ApiOptions {
  pools?: 'live' | 'down'
  check?: unknown
  checkStatus?: number
  position?: unknown
}

// Answers /api/* for one page and counts what was asked, so tests can prove nothing fires on load.
export async function mockApi(page: Page, o: ApiOptions = {}) {
  const calls: string[] = []
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    calls.push(url.pathname)
    if (url.pathname === '/api/pools') return o.pools === 'live' ? json(route, LIVE_POOLS) : json(route, { error: 'RPC_UNAVAILABLE' }, 503)
    if (url.pathname === '/api/rates') return json(route, RATES)
    if (url.pathname.startsWith('/api/check/')) return json(route, o.check ?? CHECK_SIAM, o.checkStatus ?? 200)
    if (url.pathname.startsWith('/api/position/')) return json(route, o.position ?? POSITION)
    return json(route, { error: 'INTERNAL' }, 404)
  })
  return calls
}
