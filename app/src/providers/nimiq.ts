import type { Staker } from '@accrue/shared'
import { init, type NimiqProvider } from '@nimiq/mini-app-sdk'
import { ProviderMissingError } from './errors'

export interface NimAccounts {
  wallet: string
  htlc?: string
}

export interface NimBalances {
  wallet: bigint
  htlc: bigint
  total: bigint
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function toAccounts(list: unknown): NimAccounts {
  if (!Array.isArray(list) || typeof list[0] !== 'string') throw new Error('Nimiq Pay returned no account')
  const [wallet, htlc] = list as [string, unknown]
  return typeof htlc === 'string' && htlc ? { wallet, htlc } : { wallet }
}

function lunaFrom(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`not a luna amount: ${String(v)}`)
  return BigInt(v)
}

// The SDK takes luna as JS numbers; 2^53 luna is far above NIM's total supply.
function lunaArg(luna: bigint, allowZero = false): number {
  if (luna < 0n || (!allowZero && luna === 0n) || luna > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`luna amount out of range: ${luna}`)
  }
  return Number(luna)
}

// Albatross RPC answers { data, metadata }; tolerate a host that already unwrapped it.
function unwrap(r: unknown): unknown {
  return isRecord(r) && 'data' in r ? r.data : r
}

function parseStaker(r: unknown): Staker {
  if (!isRecord(r) || typeof r.address !== 'string' || typeof r.delegation !== 'string') {
    throw new Error('unexpected getStakerByAddress result')
  }
  const inactiveFrom = r.inactiveFrom
  if (inactiveFrom !== null && inactiveFrom !== undefined && typeof inactiveFrom !== 'number') {
    throw new Error('unexpected inactiveFrom')
  }
  return {
    address: r.address,
    delegation: r.delegation,
    activeLuna: lunaFrom(r.balance),
    inactiveLuna: lunaFrom(r.inactiveBalance ?? 0),
    inactiveFrom: inactiveFrom ?? null,
    retiredLuna: lunaFrom(r.retiredBalance ?? 0),
  }
}

const isNotFound = (e: unknown) =>
  isRecord(e) && typeof e.message === 'string' && /not\s*found|does not exist|no staker|unknown staker/i.test(e.message)

export function createNimiq(opts: { timeout?: number } = {}) {
  let provider: Promise<NimiqProvider> | null = null
  let accounts: NimAccounts | null = null
  let connecting: Promise<NimAccounts> | null = null

  // Lazy: nothing touches the provider until a user action calls one of these.
  function get(): Promise<NimiqProvider> {
    provider ??= init({ timeout: opts.timeout ?? 5000 }).catch(() => {
      provider = null
      throw new ProviderMissingError('nimiq')
    })
    return provider
  }

  async function balanceOf(p: NimiqProvider, address: string): Promise<bigint> {
    if (typeof p.getBalance === 'function') return lunaFrom(await p.getBalance(address))
    const account = unwrap(await p.request({ method: 'getAccountByAddress', params: [address] }))
    return lunaFrom(isRecord(account) ? account.balance : undefined)
  }

  async function requestAccounts(): Promise<NimAccounts> {
    const p = await get()
    accounts = toAccounts(await p.listAccounts())
    return accounts
  }

  return {
    // A second tap while the prompt is open joins the pending request instead of prompting again.
    connect(): Promise<NimAccounts> {
      connecting ??= requestAccounts().finally(() => {
        connecting = null
      })
      return connecting
    },

    accounts(): NimAccounts | null {
      return accounts
    },

    // Spendable NIM often sits in the HTLC, so the total counts both.
    async balances(): Promise<NimBalances> {
      if (!accounts) throw new Error('connect the NIM wallet first')
      const { wallet, htlc } = accounts
      const p = await get()
      const [w, h] = await Promise.all([balanceOf(p, wallet), htlc ? balanceOf(p, htlc) : Promise.resolve(0n)])
      return { wallet: w, htlc: h, total: w + h }
    },

    async staker(address: string): Promise<Staker | null> {
      const p = await get()
      try {
        const r = unwrap(await p.request({ method: 'getStakerByAddress', params: [address] }))
        return r === null || r === undefined ? null : parseStaker(r)
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    // Read-only Albatross JSON-RPC through the host (getBlockNumber, getPolicyConstants, ...).
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      const p = await get()
      return unwrap(await p.request({ method, params })) as T
    },

    async newStaker(delegation: string, luna: bigint): Promise<string> {
      const value = lunaArg(luna)
      return (await get()).sendNewStakerTransaction({ delegation, value })
    },

    async addStake(luna: bigint): Promise<string> {
      const value = lunaArg(luna)
      return (await get()).sendStakeTransaction({ value })
    },

    async setActive(luna: bigint): Promise<string> {
      const newActiveBalance = lunaArg(luna, true)
      return (await get()).sendSetActiveStakeTransaction({ newActiveBalance })
    },

    async updateDelegation(newDelegation: string, reactivateAll: boolean): Promise<string> {
      return (await get()).sendUpdateStakerTransaction({ newDelegation, reactivateAllStake: reactivateAll })
    },

    async retire(luna: bigint): Promise<string> {
      const retireStake = lunaArg(luna)
      return (await get()).sendRetireStakeTransaction({ retireStake })
    },

    async remove(luna: bigint): Promise<string> {
      const value = lunaArg(luna)
      return (await get()).sendRemoveStakeTransaction({ value })
    },

    // Subscribes once the provider is ready; the returned function is safe to call at any time.
    // Without a provider there are no account changes to report, so that case stays silent.
    onAccountsChanged(cb: (a: NimAccounts) => void): () => void {
      let active = true
      let detach = () => {}
      const handler = (list: string[]) => {
        accounts = toAccounts(list)
        cb(accounts)
      }
      get().then(
        p => {
          if (!active) return
          p.on('accountsChanged', handler)
          detach = () => p.removeListener('accountsChanged', handler)
        },
        () => {},
      )
      return () => {
        active = false
        detach()
      }
    },
  }
}

export type Nimiq = ReturnType<typeof createNimiq>

export const nimiq: Nimiq = createNimiq()
