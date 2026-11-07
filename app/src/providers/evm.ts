import { ASSETS, permitToJson, POLYGON, type AssetKey, type PermitTypedData } from '@accrue/shared'
import { createClient, fallback, getAddress, http, numberToHex, type Address, type Client, type Hex } from 'viem'
import { getBalance, getGasPrice, readContract } from 'viem/actions'
import { polygon } from 'viem/chains'
import { ProviderMissingError, RpcUnavailableError, WrongChainError } from './errors'

export interface Eip1193 {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

// Balances are read from public RPCs: they need no wallet permission and never prompt.
export const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
] as const

const ADD_POLYGON = {
  chainId: POLYGON.hex,
  chainName: 'Polygon',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: [...POLYGON_RPCS],
  blockExplorerUrls: ['https://polygonscan.com'],
}

const ERC20_READS = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export interface EvmTx {
  from: Address
  to: Address
  data: Hex
  value?: bigint
}

const isAssetKey = (a: string): a is AssetKey => a in ASSETS

function errorCode(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const o = e as { code?: unknown; data?: { originalError?: { code?: unknown } } }
  if (typeof o.code === 'number') return o.code
  const nested = o.data?.originalError?.code
  return typeof nested === 'number' ? nested : undefined
}

export function createEvm(opts: { provider?: () => Eip1193 | undefined; rpcs?: readonly string[] } = {}) {
  let address: Address | null = null
  let connecting: Promise<Address> | null = null
  let client: Client | null = null

  function eth(): Eip1193 {
    const p = opts.provider ? opts.provider() : typeof window === 'undefined' ? undefined : window.ethereum
    if (!p) throw new ProviderMissingError('ethereum')
    return p
  }

  // A bare client plus the two actions used keeps viem's public-action set out of the bundle.
  function reader(): Client {
    client ??= createClient({
      chain: polygon,
      transport: fallback(
        (opts.rpcs ?? POLYGON_RPCS).map(url => http(url, { timeout: 8_000, retryCount: 0 })),
        { retryCount: 1 },
      ),
    })
    return client
  }

  async function read<T>(f: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await f(reader())
    } catch (e) {
      throw new RpcUnavailableError(e)
    }
  }

  async function requestAccount(): Promise<Address> {
    const accounts = await eth().request({ method: 'eth_requestAccounts' })
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('wallet returned no account')
    address = getAddress(accounts[0])
    return address
  }

  async function chainId(p: Eip1193): Promise<string> {
    const chain = await p.request({ method: 'eth_chainId' })
    return typeof chain === 'string' ? chain.toLowerCase() : String(chain)
  }

  // Read only: signing and sending never switch chains themselves, so one tap
  // never stacks a network dialog in front of the signature dialog.
  async function requirePolygon(p: Eip1193): Promise<void> {
    const chain = await chainId(p)
    if (chain !== POLYGON.hex) throw new WrongChainError(chain)
  }

  // The explicit, separately tapped step. At most one wallet dialog per call: when
  // Polygon has to be added first and the wallet does not switch as part of that,
  // it throws WrongChainError and the next tap does the switch.
  async function ensurePolygon(): Promise<void> {
    const p = eth()
    if ((await chainId(p)) === POLYGON.hex) return
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON.hex }] })
    } catch (e) {
      if (errorCode(e) !== 4902) throw e
      await p.request({ method: 'wallet_addEthereumChain', params: [ADD_POLYGON] })
      await requirePolygon(p)
    }
  }

  return {
    // A second tap while the prompt is open joins the pending request instead of prompting again.
    connect(): Promise<Address> {
      connecting ??= requestAccount().finally(() => {
        connecting = null
      })
      return connecting
    },

    address(): Address | null {
      return address
    },

    ensurePolygon,

    async isPolygon(): Promise<boolean> {
      return (await chainId(eth())) === POLYGON.hex
    },

    // USDC's domain carries chainId 137, which the host checks against the active chain;
    // USDT0's has none. Either way the wallet must already be on Polygon (ensurePolygon).
    async signPermit(td: PermitTypedData): Promise<Hex> {
      const p = eth()
      await requirePolygon(p)
      const sig = await p.request({ method: 'eth_signTypedData_v4', params: [td.message.owner, permitToJson(td)] })
      if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{128,130}$/.test(sig)) throw new Error('wallet returned no signature')
      return sig as Hex
    },

    // Self-paid fallback when the relayer is unavailable.
    async sendTx(tx: EvmTx): Promise<Hex> {
      const p = eth()
      await requirePolygon(p)
      const params: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data }
      if (tx.value !== undefined) params.value = numberToHex(tx.value)
      const hash = await p.request({ method: 'eth_sendTransaction', params: [params] })
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('wallet returned no transaction hash')
      return hash as Hex
    },

    // An AssetKey reads the underlying token; pass ASSETS[k].aToken for the Aave position.
    async tokenBalance(asset: AssetKey | Address, owner: Address): Promise<bigint> {
      const token = isAssetKey(asset) ? ASSETS[asset].address : asset
      return read(c => readContract(c, { address: token, abi: ERC20_READS, functionName: 'balanceOf', args: [owner] }))
    },

    async permitNonce(token: Address, owner: Address): Promise<bigint> {
      return read(c => readContract(c, { address: token, abi: ERC20_READS, functionName: 'nonces', args: [owner] }))
    },

    async polBalance(owner: Address): Promise<bigint> {
      return read(c => getBalance(c, { address: owner }))
    },

    async gasPrice(): Promise<bigint> {
      return read(c => getGasPrice(c))
    },

    // For transactions the user's own wallet sent (self-paid fallback). null = not mined yet.
    async txStatus(hash: Hex): Promise<'success' | 'reverted' | null> {
      const receipt = await read(c => c.request({ method: 'eth_getTransactionReceipt', params: [hash] }))
      if (!receipt) return null
      return receipt.status === '0x1' ? 'success' : 'reverted'
    },
  }
}

export type Evm = ReturnType<typeof createEvm>

export const evm: Evm = createEvm()
