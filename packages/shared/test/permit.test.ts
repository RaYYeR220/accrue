import { describe, expect, it } from 'vitest'
import { getTypesForEIP712Domain, hashDomain as hd, recoverTypedDataAddress, type TypedDataDomain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ASSETS, POLYGON, buildPermit, permitToJson } from '../src/index'

// DOMAIN_SEPARATOR() read from Polygon mainnet on 2026-11-07.
const ON_CHAIN = {
  USDT0: '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05',
  USDC: '0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca',
  aUSDT0: '0x6779dbf886b2eb2171d0f5fd30c4025e8ff26ede4a28ac90cf71d0ef088faf51',
  aUSDC: '0xad2b554fbaa19a0a1e5c89e6b464194aa5ddb63ab7ab2a425a79b7080cbba904',
} as const

const hashDomain = ({ domain }: { domain: TypedDataDomain }) => hd({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }) } } as never)

const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const owner = privateKeyToAccount(key)
const spender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

describe('constants', () => {
  it('chain and assets', () => {
    expect(POLYGON.chainId).toBe(137)
    expect(POLYGON.hex).toBe('0x89')
    expect(POLYGON.pool).toBe('0x794a61358D6845594F94dc1DB02A252b5b4814aD')
    expect(POLYGON.router).toBeNull()
    expect(ASSETS.USDT0.decimals).toBe(6)
    expect(ASSETS.USDC.aToken).toBe('0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD')
  })
})

describe('domains match on-chain DOMAIN_SEPARATOR', () => {
  it('USDT0', () => expect(hashDomain({ domain: ASSETS.USDT0.domain })).toBe(ON_CHAIN.USDT0))
  it('USDC', () => expect(hashDomain({ domain: ASSETS.USDC.domain })).toBe(ON_CHAIN.USDC))
  it('aUSDT0', () => expect(hashDomain({ domain: ASSETS.USDT0.aDomain })).toBe(ON_CHAIN.aUSDT0))
  it('aUSDC', () => expect(hashDomain({ domain: ASSETS.USDC.aDomain })).toBe(ON_CHAIN.aUSDC))
})

describe('permit typed data', () => {
  const args = { owner: owner.address, spender, value: 5_000_000n, nonce: 3n, deadline: 1_900_000_000n } as const

  it('USDT0 json has salt and no chainId', () => {
    const json = JSON.parse(permitToJson(buildPermit({ ...args, token: 'asset', asset: 'USDT0' })))
    expect(json.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(['name', 'version', 'verifyingContract', 'salt'])
    expect(json.domain.chainId).toBeUndefined()
    expect(json.primaryType).toBe('Permit')
    expect(json.message.value).toBe('5000000')
    expect(json.message.nonce).toBe('3')
    expect(json.message.deadline).toBe('1900000000')
  })

  it('USDC json lists chainId in canonical order', () => {
    const json = JSON.parse(permitToJson(buildPermit({ ...args, token: 'asset', asset: 'USDC' })))
    expect(json.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract'])
  })

  for (const asset of ['USDT0', 'USDC'] as const) {
    for (const token of ['asset', 'aToken'] as const) {
      it(`signature recovers owner (${asset}/${token})`, async () => {
        const td = buildPermit({ ...args, token, asset })
        const signature = await owner.signTypedData(td)
        const recovered = await recoverTypedDataAddress({ ...td, signature })
        expect(recovered).toBe(owner.address)
      })
    }
  }

  it('uses the aToken domain for aToken permits', () => {
    const td = buildPermit({ ...args, token: 'aToken', asset: 'USDC' })
    expect(td.domain.verifyingContract).toBe(ASSETS.USDC.aToken)
  })
})
