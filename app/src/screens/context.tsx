import { type AssetKey } from '@accrue/shared'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Address } from 'viem'
import type { LocalJob } from '../actions/jobs'
import { useJobs } from '../actions/useJobs'
import { useAave, type AaveReserves } from '../features/dollars/useAave'
import { usePosition, type Position } from '../features/dollars/usePosition'
import { useNim, type NimApi, type TxOutcome } from '../features/nim/useNim'
import type { Network } from '../features/nim/api'
import { useFiat, type FiatApi } from '../fiat/useFiat'
import { isRecord } from '../lib/util'
import { buildActivity, nimLog, recordNimTx, subscribeNimLog, type ActivityRow, type ChainTx, type NimKind } from '../model/activity'
import { toUiError, type UiError } from '../providers/errors'
import { evm } from '../providers/evm'
import { nimiq } from '../providers/nimiq'
import { loadSession, saveSession, type Session } from './session'

export const ROUTES = ['home', 'dollars', 'nim', 'payouts', 'activity', 'about'] as const
export type Route = (typeof ROUTES)[number]

// What a screen should open when it is reached from a "Put to work" or a link.
export type Intent = { deposit: AssetKey } | { stake: true } | { section: 'methodology' } | null

export interface WalletBalances {
  USDT0: bigint
  USDC: bigint
}

export interface App {
  network: Network
  route: Route
  go(route: Route, intent?: Intent): void
  intent: Intent
  takeIntent(): Intent
  fiat: FiatApi
  nim: NimApi
  // the NIM wallet this phone used before, for reads before the next tap
  session: Session
  started: boolean
  start(): Promise<UiError | null>
  connectNim(): Promise<UiError | null>
  // dollars: the owner is known from a connect in this page, or from the last one
  owner: Address | null
  evmLive: boolean
  connectEvm(): Promise<UiError | null>
  aave: UseQueryResult<AaveReserves>
  position: UseQueryResult<Position>
  wallet: UseQueryResult<WalletBalances>
  jobs: LocalJob[]
  activity: ActivityRow[]
  // a staking action, logged so Activity shows it before the chain lists it
  nimAction(kind: NimKind, luna: bigint, run: () => Promise<TxOutcome | null>, pool?: string): Promise<TxOutcome | null>
}

const Ctx = createContext<App | null>(null)

export function useApp(): App {
  const a = useContext(Ctx)
  if (!a) throw new Error('useApp outside AppProvider')
  return a
}

const readRoute = (): Route => {
  const h = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? ''
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : 'home'
}

const hostNetwork = (): Network => (window.nimiqPay?.network === 'testnet' ? 'testnet' : 'mainnet')

function parseHistory(raw: unknown): ChainTx[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is ChainTx => isRecord(t) && typeof t.hash === 'string' && typeof t.from === 'string' && typeof t.to === 'string' && typeof t.value === 'number' && typeof t.timestamp === 'number' && typeof t.recipientData === 'string')
}

export function AppProvider({ children }: { children: ReactNode }) {
  const network = hostNetwork()
  const fiat = useFiat()
  const nim = useNim({ network })
  const [route, setRoute] = useState<Route>(readRoute)
  const [intent, setIntent] = useState<Intent>(null)
  const [session, setSession] = useState<Session>(loadSession)
  const [evmLive, setEvmLive] = useState(() => evm.address() !== null)
  const owner = evm.address() ?? session.evm

  useEffect(() => {
    const on = () => setRoute(readRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const remember = useCallback((s: Partial<Session>) => {
    setSession(prev => {
      const next = { ...prev, ...s }
      saveSession(next)
      return next
    })
  }, [])

  const connectNim = useCallback(async (): Promise<UiError | null> => {
    try {
      await nim.connect()
      const wallet = nimiq.accounts()?.wallet ?? null
      if (wallet) remember({ nim: wallet })
      return null
    } catch (e) {
      return toUiError(e)
    }
  }, [nim, remember])

  const connectEvm = useCallback(async (): Promise<UiError | null> => {
    try {
      const a = await evm.connect()
      setEvmLive(true)
      remember({ evm: a })
      return null
    } catch (e) {
      return toUiError(e)
    }
  }, [remember])

  const aave = useAave()
  const position = usePosition(owner)
  // public RPC reads: no wallet permission, no dialog
  const wallet = useQuery({
    queryKey: ['wallet', owner],
    queryFn: async (): Promise<WalletBalances> => {
      const [USDT0, USDC] = await Promise.all([evm.tokenBalance('USDT0', owner!), evm.tokenBalance('USDC', owner!)])
      return { USDT0, USDC }
    },
    enabled: owner !== null,
    staleTime: 30_000,
  })
  const jobs = useJobs(owner)

  const nimWallet = nim.accounts?.wallet ?? null
  const log = useSyncExternalStore(subscribeNimLog, () => nimLog(nimWallet), () => nimLog(null))
  const history = useQuery({
    queryKey: ['nim', network, nimWallet, 'history'],
    queryFn: async () => parseHistory(await nimiq.rpc<unknown>('getTransactionsByAddress', [nimWallet, 50])),
    enabled: nim.connected,
    staleTime: 60_000,
    retry: false,
  })
  const nimAccounts = nim.accounts
  const activity = useMemo(
    () =>
      buildActivity({
        jobs,
        nimLog: log,
        nimChain: history.data ?? [],
        wallet: nimAccounts ? [nimAccounts.wallet, nimAccounts.htlc].filter((a): a is string => !!a) : null,
        network,
      }),
    [jobs, log, history.data, nimAccounts, network],
  )

  const nimAction = useCallback(
    async (kind: NimKind, luna: bigint, run: () => Promise<TxOutcome | null>, pool?: string) => {
      const out = await run()
      if (out && nimWallet) {
        recordNimTx({ hash: out.hash, wallet: nimWallet, kind, luna: luna.toString(), at: Date.now(), status: out.status === 'confirmed' ? 'confirmed' : 'pending', ...(pool ? { pool } : {}) })
        void history.refetch()
      }
      return out
    },
    [nimWallet, history],
  )

  const app: App = {
    network,
    route,
    go: (r, i = null) => {
      setIntent(i)
      if (r === readRoute()) setRoute(r)
      else location.hash = r === 'home' ? '' : r
      window.scrollTo(0, 0)
    },
    intent,
    takeIntent: () => {
      const i = intent
      if (i) setIntent(null)
      return i
    },
    fiat,
    nim,
    session,
    started: nim.connected || session.nim !== null || session.evm !== null,
    start: connectNim,
    connectNim,
    owner,
    evmLive,
    connectEvm,
    aave,
    position,
    wallet,
    jobs,
    activity,
    nimAction,
  }
  return <Ctx.Provider value={app}>{children}</Ctx.Provider>
}
