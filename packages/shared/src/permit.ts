import type { Address, TypedDataDomain } from 'viem'
import { ASSETS, type AssetKey } from './assets'

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export interface PermitTypedData {
  domain: TypedDataDomain
  types: typeof PERMIT_TYPES
  primaryType: 'Permit'
  message: { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }
}

export function buildPermit(args: {
  token: 'asset' | 'aToken'
  asset: AssetKey
  owner: Address
  spender: Address
  value: bigint
  nonce: bigint
  deadline: bigint
}): PermitTypedData {
  const a = ASSETS[args.asset]
  return {
    domain: args.token === 'asset' ? a.domain : a.aDomain,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: args.owner, spender: args.spender, value: args.value, nonce: args.nonce, deadline: args.deadline },
  }
}

const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
] as const

// eth_signTypedData_v4 payload; EIP712Domain lists only the fields the domain actually has.
export function permitToJson(td: PermitTypedData): string {
  const domain = td.domain as Record<string, unknown>
  const EIP712Domain = DOMAIN_FIELDS.filter(([k]) => domain[k] !== undefined).map(([name, type]) => ({ name, type }))
  return JSON.stringify(
    { types: { EIP712Domain, ...td.types }, domain: td.domain, primaryType: td.primaryType, message: td.message },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  )
}
