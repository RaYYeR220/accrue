import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { ASSETS, POLYGON } from '@accrue/shared'
import { RelayError, decodeRevert, isTransportError } from './errors'
import { GAS_POLICY } from './gas'
import type { ParsedRelay } from './validate'
import type { Env } from '../env'

/** ROUTER_ADDRESS when set, else the deployed address from @accrue/shared; null until there is one. */
export function routerAddress(env: Pick<Env, 'ROUTER_ADDRESS'>): Address | null {
  const raw = env.ROUTER_ADDRESS?.trim() || POLYGON.router
  return raw && isAddress(raw, { strict: false }) ? getAddress(raw) : null
}

export const routerAbi = parseAbi([
  'function supplyWithPermit(address asset, address owner, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function withdrawWithPermit(address asset, address owner, uint256 amount, uint256 permitValue, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)',
  'event Supplied(address indexed owner, address indexed asset, uint256 amount, uint256 index)',
  'event Withdrawn(address indexed owner, address indexed asset, uint256 amount, uint256 index)',
  'error AssetNotAllowed()',
  'error ZeroAmount()',
  'error InsufficientAllowance()',
  'error NothingToWithdraw()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
])

const tokenAbi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])
const poolAbi = parseAbi(['function getVirtualUnderlyingBalance(address asset) view returns (uint128)'])

export function routerCalldata(p: ParsedRelay): Hex {
  const asset = ASSETS[p.asset].address
  return p.kind === 'supply'
    ? encodeFunctionData({
        abi: routerAbi,
        functionName: 'supplyWithPermit',
        args: [asset, p.owner, p.amount, p.deadline, p.v, p.r, p.s],
      })
    : encodeFunctionData({
        abi: routerAbi,
        functionName: 'withdrawWithPermit',
        args: [asset, p.owner, p.amount, p.permitValue, p.deadline, p.v, p.r, p.s],
      })
}

export interface OwnerState {
  /** Permit nonce on the token being permitted (underlying for supply, aToken for withdraw). */
  nonce: bigint
  /** Owner balance of that same token. */
  balance: bigint
  /** Withdraw only: underlying the reserve can pay out right now. */
  available?: bigint
  /** Supply of USDC only: owner has code (EIP-7702 delegation), which FiatToken's permit does not accept. */
  hasCode?: boolean
}

function rpcFail(err: unknown): never {
  if (err instanceof RelayError) throw err
  throw new RelayError(isTransportError(err) ? 'RPC_UNAVAILABLE' : 'INTERNAL', { reason: 'read_failed' })
}

export async function readOwnerState(client: PublicClient, p: ParsedRelay): Promise<OwnerState> {
  const a = ASSETS[p.asset]
  const token = p.kind === 'supply' ? a.address : a.aToken
  try {
    if (p.kind === 'supply') {
      const [res, code] = await Promise.all([
        client.multicall({
          allowFailure: false,
          contracts: [
            { address: token, abi: tokenAbi, functionName: 'nonces', args: [p.owner] },
            { address: token, abi: tokenAbi, functionName: 'balanceOf', args: [p.owner] },
          ],
        }),
        p.asset === 'USDC' ? client.getCode({ address: p.owner }) : Promise.resolve(undefined),
      ])
      return { nonce: res[0], balance: res[1], hasCode: !!code && code !== '0x' }
    }
    const res = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: tokenAbi, functionName: 'nonces', args: [p.owner] },
        { address: token, abi: tokenAbi, functionName: 'balanceOf', args: [p.owner] },
        { address: POLYGON.pool, abi: poolAbi, functionName: 'getVirtualUnderlyingBalance', args: [a.address] },
        { address: a.address, abi: tokenAbi, functionName: 'balanceOf', args: [a.aToken] },
      ],
    })
    if (res[0].status !== 'success' || res[1].status !== 'success') rpcFail(res[0].error ?? res[1].error)
    // Aave >= 3.1 pays withdrawals out of its virtual balance; older pools out of the aToken's underlying.
    const available =
      res[2].status === 'success' ? res[2].result : res[3].status === 'success' ? res[3].result : undefined
    return { nonce: res[0].result, balance: res[1].result, available }
  } catch (e) {
    rpcFail(e)
  }
}

/**
 * Finds the tx that already used this exact signature through the router, if any landed in the last ~hour.
 * Anyone can relay a signed permit, so "nonce already used" may simply mean the deposit is done.
 * Resolves to 'unknown' when no RPC would serve the log query.
 */
export async function findLanded(
  client: PublicClient,
  router: Address,
  p: ParsedRelay,
): Promise<Hex | null | 'unknown'> {
  const asset = ASSETS[p.asset].address
  const event = routerAbi.find(x => x.type === 'event' && x.name === (p.kind === 'supply' ? 'Supplied' : 'Withdrawn'))
  if (!event || event.type !== 'event') return null
  try {
    const latest = await client.getBlockNumber({ cacheTime: 0 })
    const floor = BigInt(POLYGON.deployBlock ?? 0)
    let logs
    // Free public RPCs cap eth_getLogs ranges (drpc ~100 blocks, 1rpc 50), so fall back to the newest 50 blocks,
    // which still catches someone front-running our own pending tx.
    for (const span of [GAS_POLICY.landedLookbackBlocks, GAS_POLICY.landedNarrowBlocks]) {
      const from = latest > span ? latest - span : 0n
      try {
        logs = await client.getLogs({
          address: router,
          event,
          args: { owner: p.owner, asset },
          fromBlock: from > floor ? from : floor,
          toBlock: latest,
        })
        break
      } catch {
        // try the narrower window
      }
    }
    if (!logs) return 'unknown'
    const candidates = logs
      .filter(l => p.kind !== 'supply' || (l.args as { amount?: bigint }).amount === p.amount)
      .reverse()
      .slice(0, 3)
    for (const log of candidates) {
      if (!log.transactionHash) continue
      const tx = await client.getTransaction({ hash: log.transactionHash })
      try {
        const call = decodeFunctionData({ abi: routerAbi, data: tx.input })
        const args = call.args as readonly unknown[]
        const [r, s] = call.functionName === 'supplyWithPermit' ? [args[5], args[6]] : [args[6], args[7]]
        if (String(r).toLowerCase() === p.r && String(s).toLowerCase() === p.s) return log.transactionHash
      } catch {
        // The landing tx went through another contract; without our calldata we cannot tie it to this signature.
      }
    }
    return null
  } catch {
    // Not knowing must not turn into INTERNAL; callers fall back to their non-landed answer.
    return 'unknown'
  }
}

export type Verdict = { landed: Hex } | { error: RelayError } | null

/**
 * Reads that explain why a relay cannot go through, in this order: used nonce (possibly by a landed relay),
 * future nonce, balance, then reserve liquidity. null = nothing wrong on-chain.
 */
export async function judgeState(
  client: PublicClient,
  router: Address,
  p: ParsedRelay,
  s: OwnerState,
): Promise<Verdict> {
  if (p.kind === 'supply' && s.hasCode)
    return { error: new RelayError('BAD_SIGNATURE', { reason: 'owner_has_code' }) }
  if (p.kind === 'withdraw' && s.balance === 0n)
    return { error: new RelayError('INSUFFICIENT_BALANCE', { balance: '0' }) }
  if (s.nonce > p.nonce) {
    const landed = await findLanded(client, router, p)
    if (landed && landed !== 'unknown') return { landed }
    return {
      error: new RelayError('PERMIT_NONCE_STALE', {
        expected: s.nonce.toString(),
        ...(landed === 'unknown' ? { landedCheck: 'unavailable' } : {}),
      }),
    }
  }
  if (s.nonce < p.nonce) return { error: new RelayError('PERMIT_NONCE_STALE', { expected: s.nonce.toString() }) }
  if (p.kind === 'supply' && s.balance < p.amount)
    return { error: new RelayError('INSUFFICIENT_BALANCE', { balance: s.balance.toString() }) }
  if (p.kind === 'withdraw' && s.available !== undefined) {
    const pull = [p.amount, s.balance, p.permitValue].reduce((a, b) => (a < b ? a : b))
    if (s.available < pull) return { error: new RelayError('AAVE_LIQUIDITY', { available: s.available.toString() }) }
  }
  return null
}

/** eth_call the router as the relayer. Resolves to null when it would succeed, else the decoded revert. */
export async function simulate(client: PublicClient, from: Address, router: Address, data: Hex) {
  try {
    await client.call({ account: from, to: router, data })
    return null
  } catch (e) {
    const revert = decodeRevert(e, routerAbi)
    if (!revert) rpcFail(e)
    return revert
  }
}
