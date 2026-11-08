import { ASSETS, type RelayErrorCode } from '@accrue/shared'
import type { Address } from 'viem'

export const SCENARIO_NAMES = [
  'happy',
  'reject-sign',
  'insufficient',
  'relay-down',
  'stale-nonce',
  'unknown-outcome',
  'htlc-only-balance',
  'aave-illiquid',
  'testnet',
] as const
export type ScenarioName = (typeof SCENARIO_NAMES)[number]

export type NimTxOutcome = 'ok' | 'reject' | 'insufficient' | 'unknown-outcome'

export type RelayOutcome =
  | { kind: 'ok' }
  | { kind: 'down' }
  // `once`: only the first request of this kind fails (a re-signed permit then goes through)
  | { kind: 'error'; status: number; error: RelayErrorCode; detail?: Record<string, string>; once?: boolean }

// Albatross getStakerByAddress `data` shape, luna as numbers
export interface StakerRpc {
  balance: number
  delegation: string
  inactiveBalance: number
  inactiveFrom: number | null
  retiredBalance: number
}

export interface Scenario {
  host: { language: string; userFiat: string; network: 'mainnet' | 'testnet' }
  nim: { wallet: string; htlc?: string; luna: Record<string, number>; staker: StakerRpc | null; tx: NimTxOutcome }
  evm: {
    address: Address
    // token or aToken address -> balance in token units
    tokens: Record<Address, bigint>
    polWei: bigint
    sign: 'ok' | 'reject'
    send: 'ok' | 'reject'
  }
  // lostAnswers: the relay takes the first job, then nothing it says arrives until the app is reopened
  relay: { supply: RelayOutcome; withdraw: RelayOutcome; confirms: boolean; lostAnswers?: boolean }
}

// Valid-checksum fixture addresses (repeated bytes), never real accounts.
const WALLET = 'NQ68 L6GS 38D1 L6GS 38D1 L6GS 38D1 L6GS 38D1'
const HTLC = 'NQ03 NARB 5CMJ NARB 5CMJ NARB 5CMJ NARB 5CMJ'
const TESTNET_WALLET = 'NQ08 QF1U 7GX3 QF1U 7GX3 QF1U 7GX3 QF1U 7GX3'
const TESTNET_HTLC = 'NQ61 SKAD 9M6L SKAD 9M6L SKAD 9M6L SKAD 9M6L'
const TESTNET_VALIDATOR = 'NQ10 UPJX BRF5 UPJX BRF5 UPJX BRF5 UPJX BRF5'
// Siam Pool, a real mainnet validator, so pool lookups have something to match
const SIAM = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'

const EVM_OWNER = '0xa11ce00000000000000000000000000000000a11' as Address

const NIM = 100_000
const USD = 1_000_000n
const POL = 10n ** 18n

const tokens = (t: { USDT0?: bigint; USDC?: bigint; aUSDT0?: bigint; aUSDC?: bigint }): Record<Address, bigint> => ({
  [ASSETS.USDT0.address]: t.USDT0 ?? 0n,
  [ASSETS.USDC.address]: t.USDC ?? 0n,
  [ASSETS.USDT0.aToken]: t.aUSDT0 ?? 0n,
  [ASSETS.USDC.aToken]: t.aUSDC ?? 0n,
})

const OK: RelayOutcome = { kind: 'ok' }

const happy: Scenario = {
  host: { language: 'en', userFiat: 'USD', network: 'mainnet' },
  nim: {
    wallet: WALLET,
    htlc: HTLC,
    luna: { [WALLET]: 300 * NIM, [HTLC]: 950 * NIM },
    staker: { balance: 1_000 * NIM, delegation: SIAM, inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0 },
    tx: 'ok',
  },
  evm: {
    address: EVM_OWNER,
    tokens: tokens({ USDT0: 25n * USD, USDC: 10n * USD, aUSDT0: 100n * USD }),
    polWei: (3n * POL) / 10n,
    sign: 'ok',
    send: 'ok',
  },
  relay: { supply: OK, withdraw: OK, confirms: true },
}

const DOWN: RelayOutcome = { kind: 'down' }

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  happy,
  'reject-sign': {
    ...happy,
    nim: { ...happy.nim, tx: 'reject' },
    evm: { ...happy.evm, sign: 'reject', send: 'reject' },
  },
  insufficient: {
    ...happy,
    nim: { wallet: WALLET, htlc: HTLC, luna: { [WALLET]: 20 * NIM, [HTLC]: 0 }, staker: null, tx: 'insufficient' },
    evm: { ...happy.evm, tokens: tokens({ USDT0: USD / 2n }), polWei: 0n },
    relay: {
      supply: { kind: 'error', status: 422, error: 'INSUFFICIENT_BALANCE' },
      withdraw: { kind: 'error', status: 422, error: 'INSUFFICIENT_BALANCE' },
      confirms: true,
    },
  },
  'relay-down': { ...happy, relay: { supply: DOWN, withdraw: DOWN, confirms: false } },
  'stale-nonce': {
    ...happy,
    relay: {
      supply: { kind: 'error', status: 409, error: 'PERMIT_NONCE_STALE', once: true },
      withdraw: { kind: 'error', status: 409, error: 'PERMIT_NONCE_STALE', once: true },
      confirms: true,
    },
  },
  'unknown-outcome': {
    ...happy,
    nim: { ...happy.nim, tx: 'unknown-outcome' },
    relay: { supply: OK, withdraw: OK, confirms: true, lostAnswers: true },
  },
  'htlc-only-balance': {
    ...happy,
    nim: { wallet: WALLET, htlc: HTLC, luna: { [WALLET]: 0, [HTLC]: 1_250 * NIM }, staker: null, tx: 'ok' },
  },
  'aave-illiquid': {
    ...happy,
    relay: {
      supply: OK,
      withdraw: { kind: 'error', status: 422, error: 'AAVE_LIQUIDITY', detail: { available: '3000000' } },
      confirms: true,
    },
  },
  testnet: {
    ...happy,
    host: { ...happy.host, network: 'testnet' },
    nim: {
      wallet: TESTNET_WALLET,
      htlc: TESTNET_HTLC,
      luna: { [TESTNET_WALLET]: 500 * NIM, [TESTNET_HTLC]: 2_000 * NIM },
      staker: { balance: 300 * NIM, delegation: TESTNET_VALIDATOR, inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0 },
      tx: 'ok',
    },
  },
}

export const isScenarioName = (s: string): s is ScenarioName => (SCENARIO_NAMES as readonly string[]).includes(s)

// Shape of GET /api/rates (Task 9); fixed numbers so screens are reproducible.
export const MOCK_RATES = {
  asOf: 1_762_500_000_000,
  nimUsd: 0.0003,
  fx: { USD: 1, EUR: 0.86, CRC: 502, GMD: 72 },
  source: ['mock'],
}
