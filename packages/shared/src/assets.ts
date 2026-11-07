import type { Address, TypedDataDomain } from 'viem'

export type AssetKey = 'USDT0' | 'USDC'

export interface AssetInfo {
  address: Address
  aToken: Address
  decimals: 6
  domain: TypedDataDomain
  aDomain: TypedDataDomain
}

const USDT0 = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as const
const USDT0_A = '0x6ab707Aca953eDAeFBc4fD23bA73294241490620' as const
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const
const USDC_A = '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD' as const

export const ASSETS: Record<AssetKey, AssetInfo> = {
  USDT0: {
    address: USDT0,
    aToken: USDT0_A,
    decimals: 6,
    // USDT0 domain has a salt (the chain id) and no chainId field
    domain: {
      name: 'USDT0',
      version: '1',
      verifyingContract: USDT0,
      salt: '0x0000000000000000000000000000000000000000000000000000000000000089',
    },
    aDomain: { name: 'Aave Polygon USDT', version: '1', chainId: 137, verifyingContract: USDT0_A },
  },
  USDC: {
    address: USDC,
    aToken: USDC_A,
    decimals: 6,
    domain: { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC },
    aDomain: { name: 'Aave Polygon USDCn', version: '1', chainId: 137, verifyingContract: USDC_A },
  },
}
