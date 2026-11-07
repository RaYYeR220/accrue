export const RAY = 10n ** 27n

// Aave v3's SECONDS_PER_YEAR (365 days), in ms
const YEAR_MS = 31_536_000_000n
const YEAR_SEC = 31_536_000n
// fractional digits of a token unit kept before leaving bigint (the ticker shows up to 9 decimals of a dollar)
const FRACTION = 10n ** 12n

// Aave's lastUpdateTimestamp is in seconds; tolerate an API that already gives ms.
const toMs = (t: number) => (t > 1e12 ? t : t * 1000)

const toNumber = (num: bigint, den: bigint, decimals: number) => Number((num * FRACTION) / den) / Number(FRACTION) / 10 ** decimals

// Aave's linear interest between reserve updates: balance = scaled × index × (1 + rate × Δt / year).
// Returns whole tokens (USD for USDT0/USDC). The device clock running behind never makes it go backwards.
export function accrue(scaled: bigint, indexRay: bigint, rateRay: bigint, lastUpdate: number, nowMs: number, decimals = 6): number {
  const dt = BigInt(Math.max(0, Math.floor(nowMs - toMs(lastUpdate))))
  return toNumber(scaled * indexRay * (RAY * YEAR_MS + rateRay * dt), RAY * RAY * YEAR_MS, decimals)
}

// Growth per second in whole tokens; feed it to adaptiveDecimals.
export function perSecond(scaled: bigint, indexRay: bigint, rateRay: bigint, decimals = 6): number {
  return toNumber(scaled * indexRay * rateRay, RAY * RAY * YEAR_SEC, decimals)
}

// The scaled balance behind a live aToken balance read at `atMs` (aToken balanceOf already includes interest).
export function scaledFromBalance(balance: bigint, indexRay: bigint, rateRay: bigint, lastUpdate: number, atMs: number): bigint {
  const dt = BigInt(Math.max(0, Math.floor(atMs - toMs(lastUpdate))))
  return (balance * RAY * RAY * YEAR_MS) / (indexRay * (RAY * YEAR_MS + rateRay * dt))
}
