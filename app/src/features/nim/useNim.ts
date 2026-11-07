import { LUNA_PER_NIM, normalizeAddress, type Staker } from '@accrue/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nimiq, type NimAccounts, type NimBalances, type Nimiq } from '../../providers/nimiq'
import {
  fetchCheck,
  fetchPools,
  parsePolicy,
  poolApr,
  waitForNimTx,
  type CheckResponse,
  type Network,
  type PoolRow,
  type PoolsResponse,
  type TxStatus,
} from './api'
import { NimPlanError, NimTxFailedError } from './errors'
import { restakeSuggestion } from './restake'
import { spendableOf, stakePlan, type StakePlan } from './staking'
import {
  checkUnstake,
  deactivateTarget,
  removeAmount,
  retireAmount,
  switchPoolPlan,
  unstakeSteps,
  type StakingPolicy,
  type UnstakeStep,
} from './unstake'

export const DEFAULT_RESERVE_LUNA = 10n * LUNA_PER_NIM

export interface ChainState {
  blockNow: number
  policy: Required<StakingPolicy>
  readAt: number
}

export interface TxOutcome {
  hash: string
  status: Exclude<TxStatus, 'failed'>
}

export interface NimApi {
  network: Network
  connected: boolean
  ready: boolean
  busy: boolean
  accounts: NimAccounts | null
  balances: NimBalances | undefined
  spendable: bigint | undefined
  staker: Staker | null | undefined
  chain: ChainState | undefined
  jailedFrom: number | null
  pools: PoolsResponse | undefined
  check: CheckResponse | undefined
  myPool: PoolRow | undefined
  restake: { amount: bigint; extraPerYearLuna: bigint } | null
  connect(): Promise<void>
  refresh(): Promise<void>
  blockNow(): number | null
  planStake(amount: bigint): StakePlan | null
  planUnstake(amount: bigint): { check: ReturnType<typeof checkUnstake>; steps: UnstakeStep[] } | null
  planSwitch(): ReturnType<typeof switchPoolPlan> | null
  stake(amount: bigint, delegation?: string): Promise<TxOutcome>
  deactivate(amount: bigint): Promise<TxOutcome | null>
  deactivateAll(): Promise<TxOutcome | null>
  retire(amount: bigint): Promise<TxOutcome | null>
  remove(): Promise<TxOutcome>
  switchPool(delegation: string): Promise<TxOutcome | null>
}

export interface UseNimOptions {
  client?: Nimiq
  network?: Network
  fetch?: typeof fetch
  reserve?: bigint
  txWait?: Parameters<typeof waitForNimTx>[2]
}

const hostNetwork = (): Network =>
  typeof window !== 'undefined' && window.nimiqPay?.network === 'testnet' ? 'testnet' : 'mainnet'

const same = (a: string, b: string) => normalizeAddress(a) === normalizeAddress(b)

async function readChain(client: Nimiq): Promise<ChainState> {
  const [block, raw] = await Promise.all([client.rpc<number>('getBlockNumber'), client.rpc<unknown>('getPolicyConstants')])
  if (typeof block !== 'number' || !Number.isSafeInteger(block)) throw new Error('unexpected getBlockNumber result')
  return { blockNow: block, policy: parsePolicy(raw), readAt: Date.now() }
}

// Blocks come about every blockSeparationTime, so a countdown can run between reads.
function estimateBlock(c: ChainState): number {
  return c.blockNow + Math.floor((Date.now() - c.readAt) / c.policy.blockSeparationTimeMs)
}

// Advisory: a host that cannot read validators reports no jail, and the countdown may then end
// early for a jailed pool; the retire guard re-reads the staker, not the jail.
async function readJail(client: Nimiq, delegation: string): Promise<number | null> {
  try {
    const v = await client.rpc<{ jailedFrom?: unknown }>('getValidatorByAddress', [delegation])
    return typeof v?.jailedFrom === 'number' ? v.jailedFrom : null
  } catch {
    return null
  }
}

// NIM side of Accrue. Nothing touches the wallet until connect() runs from a tap; every action
// re-reads the chain, refuses what the protocol would reject, and opens at most one dialog.
export function useNim(opts: UseNimOptions = {}): NimApi {
  const client = opts.client ?? nimiq
  const network = opts.network ?? hostNetwork()
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const reserve = opts.reserve ?? DEFAULT_RESERVE_LUNA
  const qc = useQueryClient()
  const [accounts, setAccounts] = useState<NimAccounts | null>(() => client.accounts())
  const [busy, setBusy] = useState(false)
  const inFlight = useRef<{ key: string; p: Promise<unknown> } | null>(null)
  const wallet = accounts?.wallet ?? null
  const connected = wallet !== null
  const scope = ['nim', network, wallet] as const

  useEffect(() => (connected ? client.onAccountsChanged(setAccounts) : undefined), [client, connected])

  const balancesQ = useQuery({ queryKey: [...scope, 'balances'], queryFn: () => client.balances(), enabled: connected })
  const stakerQ = useQuery({ queryKey: [...scope, 'staker'], queryFn: () => client.staker(wallet!), enabled: connected })
  const chainQ = useQuery({
    queryKey: [...scope, 'chain'],
    queryFn: () => readChain(client),
    enabled: connected,
    refetchInterval: 60_000,
  })
  const delegation = stakerQ.data?.delegation || null
  const jailQ = useQuery({
    queryKey: [...scope, 'jail', delegation],
    queryFn: () => readJail(client, delegation!),
    enabled: connected && delegation !== null,
    staleTime: 10 * 60_000,
  })
  const poolsQ = useQuery({ queryKey: ['nim', network, 'pools'], queryFn: () => fetchPools(network, f), staleTime: 10 * 60_000 })
  const checkQ = useQuery({
    queryKey: [...scope, 'check'],
    queryFn: () => fetchCheck(wallet!, f),
    enabled: connected && network === 'mainnet',
    staleTime: 10 * 60_000,
  })

  const balances = balancesQ.data
  const staker = stakerQ.data
  const chain = chainQ.data
  const jailedFrom = jailQ.data ?? null
  const spendable = balances ? spendableOf(balances) : undefined
  const myPool = useMemo(
    () => (delegation ? poolsQ.data?.pools.find(p => same(p.address, delegation)) : undefined),
    [poolsQ.data, delegation],
  )
  const restake = useMemo(() => {
    if (!staker || !myPool || spendable === undefined) return null
    const apr = checkQ.data ? poolApr(checkQ.data) : null
    return restakeSuggestion({ walletIdle: spendable, payoutType: myPool.payoutType, reserve, apr: apr ?? Number.NaN })
  }, [staker, myPool, spendable, checkQ.data, reserve])

  const blockNow = useCallback(() => (chain ? estimateBlock(chain) : null), [chain])

  // One wallet dialog at a time: a second tap on the same action joins the first, any other
  // action waits until it is done.
  function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const cur = inFlight.current
    if (cur) return cur.key === key ? (cur.p as Promise<T>) : Promise.reject(new NimPlanError('BUSY'))
    setBusy(true)
    const p = fn().finally(() => {
      inFlight.current = null
      setBusy(false)
    })
    inFlight.current = { key, p }
    return p
  }

  function requireWallet(): string {
    const w = client.accounts()?.wallet
    if (!w) throw new NimPlanError('NOT_CONNECTED')
    return w
  }

  async function fresh(w: string): Promise<{ s: Staker | null; c: ChainState }> {
    const [s, c] = await Promise.all([client.staker(w), readChain(client)])
    return { s, c }
  }

  async function settle(hash: string): Promise<TxOutcome> {
    const status = await waitForNimTx((m, p) => client.rpc(m, p), hash, opts.txWait)
    await qc.invalidateQueries({ queryKey: scope })
    if (status === 'failed') throw new NimTxFailedError(hash)
    return { hash, status }
  }

  const api: NimApi = {
    network,
    connected,
    ready: connected && balances !== undefined && staker !== undefined && chain !== undefined,
    busy,
    accounts,
    balances,
    spendable,
    staker,
    chain,
    jailedFrom,
    pools: poolsQ.data,
    check: checkQ.data,
    myPool,
    restake,
    blockNow,

    connect: () =>
      run('connect', async () => {
        setAccounts(await client.connect())
      }),

    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['nim', network] })
    },

    planStake: amount =>
      spendable === undefined || staker === undefined ? null : stakePlan({ staker, spendable, amount }),

    planUnstake: amount => {
      if (!staker || !chain) return null
      const check = checkUnstake({ staker, amount })
      if (check === 'INVALID_AMOUNT') return { check, steps: [] }
      return { check, steps: unstakeSteps({ staker, amount, blockNow: estimateBlock(chain), policy: chain.policy, jailedFrom }) }
    },

    planSwitch: () =>
      staker && chain ? switchPoolPlan(staker, { blockNow: estimateBlock(chain), policy: chain.policy, jailedFrom }) : null,

    // Adding always goes to the pool the staker already has; only a new staker picks one.
    stake: (amount, pool) =>
      run('stake', async () => {
        const w = requireWallet()
        const [b, s] = await Promise.all([client.balances(), client.staker(w)])
        const plan = stakePlan({ staker: s, spendable: spendableOf(b), amount })
        if ('error' in plan) throw new NimPlanError(plan.error)
        if (plan.kind === 'new' && !pool) throw new NimPlanError('NO_POOL')
        return settle(plan.kind === 'new' ? await client.newStaker(pool!, amount) : await client.addStake(amount))
      }),

    deactivate: amount =>
      run('deactivate', async () => {
        const { s } = await fresh(requireWallet())
        if (!s) throw new NimPlanError('NOT_STAKING')
        const check = checkUnstake({ staker: s, amount })
        if (check !== 'ok') throw new NimPlanError(check)
        const target = deactivateTarget(s, amount)
        return target ? settle(await client.setActive(target.newActive)) : null
      }),

    // First step of a pool switch: everything stops earning so the delegation can change.
    deactivateAll: () =>
      run('deactivate', async () => {
        const { s } = await fresh(requireWallet())
        if (!s) throw new NimPlanError('NOT_STAKING')
        return s.activeLuna > 0n ? settle(await client.setActive(0n)) : null
      }),

    retire: amount =>
      run('retire', async () => {
        const { s, c } = await fresh(requireWallet())
        if (!s) throw new NimPlanError('NOT_STAKING')
        const check = checkUnstake({ staker: s, amount })
        if (check !== 'ok') throw new NimPlanError(check)
        const steps = unstakeSteps({ staker: s, amount, blockNow: c.blockNow, policy: c.policy, jailedFrom })
        if (steps[2]!.done) return null
        if (!steps[1]!.done) throw new NimPlanError('NOT_READY')
        return settle(await client.retire(retireAmount(s, amount)))
      }),

    remove: () =>
      run('remove', async () => {
        const s = await client.staker(requireWallet())
        const value = s ? removeAmount(s) : 0n
        if (value === 0n) throw new NimPlanError('NOT_READY')
        return settle(await client.remove(value))
      }),

    switchPool: pool =>
      run('switch', async () => {
        const { s, c } = await fresh(requireWallet())
        if (!s) throw new NimPlanError('NOT_STAKING')
        if (s.delegation && same(s.delegation, pool)) return null
        const plan = switchPoolPlan(s, { blockNow: c.blockNow, policy: c.policy, jailedFrom })
        if (plan.kind !== 'direct') throw new NimPlanError('NOT_READY')
        return settle(await client.updateDelegation(pool, true))
      }),
  }
  return api
}
