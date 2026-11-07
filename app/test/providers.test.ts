// @vitest-environment jsdom
import { ASSETS, buildPermit } from '@accrue/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { toUiError, WrongChainError } from '../src/providers/errors'
import { createEvm, type Eip1193 } from '../src/providers/evm'
import { createNimiq } from '../src/providers/nimiq'

afterEach(() => uninstallMock(window))

const mock = (scenario: string) => installMock(`?mock=${scenario}&delay=0`, window)
const owner = '0x1111111111111111111111111111111111111111' as const
const router = '0x2222222222222222222222222222222222222222' as const

describe('nimiq provider wrapper', () => {
  it('connect returns the wallet and the HTLC address', async () => {
    mock('htlc-only-balance')
    const n = createNimiq()
    const acc = await n.connect()
    expect(acc.wallet).toMatch(/^NQ/)
    expect(acc.htlc).toMatch(/^NQ/)
  })

  it('a double tap on connect prompts once', async () => {
    const m = mock('happy')
    const n = createNimiq()
    const [a, b] = await Promise.all([n.connect(), n.connect()])
    expect(a).toEqual(b)
    expect(m.calls.filter(c => c.method === 'listAccounts')).toHaveLength(1)
  })

  it('total balance includes the HTLC, where spendable NIM usually sits', async () => {
    mock('htlc-only-balance')
    const n = createNimiq()
    await n.connect()
    const b = await n.balances()
    expect(b.wallet).toBe(0n)
    expect(b.htlc).toBeGreaterThan(0n)
    expect(b.total).toBe(b.wallet + b.htlc)
  })

  it('balances before connect fails without calling the provider', async () => {
    const m = mock('happy')
    await expect(createNimiq().balances()).rejects.toThrow(/connect/)
    expect(m.calls).toHaveLength(0)
  })

  it('reads the staker as bigints, and null for a non-staker', async () => {
    mock('happy')
    const n = createNimiq()
    const { wallet } = await n.connect()
    const s = await n.staker(wallet)
    expect(s).not.toBeNull()
    expect(typeof s!.activeLuna).toBe('bigint')
    expect(s!.delegation).toMatch(/^NQ/)
    expect(await n.staker('NQ00 0000 0000 0000 0000 0000 0000 0000 0000')).toBeNull()
  })

  it('staking calls pass luna as numbers in the SDK shape and return the tx hash', async () => {
    const m = mock('happy')
    const n = createNimiq()
    const hash = await n.newStaker('NQ12 VALI DATO R000 0000 0000 0000 0000 0000', 20_000_000n)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await n.addStake(1n)
    await n.setActive(2n)
    await n.updateDelegation('NQ12 VALI DATO R000 0000 0000 0000 0000 0000', true)
    await n.retire(3n)
    await n.remove(4n)
    expect(m.calls.map(c => [c.method, c.params])).toEqual([
      ['sendNewStakerTransaction', [{ delegation: 'NQ12 VALI DATO R000 0000 0000 0000 0000 0000', value: 20_000_000 }]],
      ['sendStakeTransaction', [{ value: 1 }]],
      ['sendSetActiveStakeTransaction', [{ newActiveBalance: 2 }]],
      ['sendUpdateStakerTransaction', [{ newDelegation: 'NQ12 VALI DATO R000 0000 0000 0000 0000 0000', reactivateAllStake: true }]],
      ['sendRetireStakeTransaction', [{ retireStake: 3 }]],
      ['sendRemoveStakeTransaction', [{ value: 4 }]],
    ])
  })

  it('refuses luna amounts the provider cannot represent', async () => {
    const m = mock('happy')
    await expect(createNimiq().addStake(2n ** 60n)).rejects.toThrow(RangeError)
    await expect(createNimiq().addStake(0n)).rejects.toThrow(RangeError)
    expect(m.calls).toHaveLength(0)
  })

  it('maps scenario failures to UI errors', async () => {
    mock('reject-sign')
    await expect(createNimiq().addStake(1n).catch(toUiError)).resolves.toMatchObject({ code: 'USER_REJECTED' })
    uninstallMock(window)
    mock('insufficient')
    await expect(createNimiq().addStake(1n).catch(toUiError)).resolves.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    uninstallMock(window)
    mock('unknown-outcome')
    await expect(createNimiq().addStake(1n).catch(toUiError)).resolves.toMatchObject({ code: 'UNKNOWN_OUTCOME' })
  })

  it('follows accountsChanged', async () => {
    const m = mock('happy')
    const n = createNimiq()
    await n.connect()
    const seen: string[] = []
    const off = n.onAccountsChanged(a => seen.push(a.htlc ?? ''))
    // the listener attaches once the (already resolved) provider promise settles
    await Promise.resolve()
    m.emitAccountsChanged(['NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA', 'NQ22 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB'])
    expect(seen).toEqual(['NQ22 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB'])
    expect(n.accounts()?.wallet).toBe('NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA')
    off()
    m.emitAccountsChanged(['NQ33 CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC'])
    expect(seen).toHaveLength(1)
  })

  it('no injected provider is PROVIDER_MISSING', async () => {
    await expect(createNimiq({ timeout: 20 }).connect().catch(toUiError)).resolves.toMatchObject({ code: 'PROVIDER_MISSING' })
  })
})

describe('evm provider wrapper', () => {
  it('connect returns a checksummed address', async () => {
    mock('happy')
    const a = await createEvm().connect()
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(a).not.toBe(a.toLowerCase())
  })

  it('a double tap on connect prompts once', async () => {
    const m = mock('happy')
    const e = createEvm()
    await Promise.all([e.connect(), e.connect()])
    expect(m.calls.filter(c => c.method === 'eth_requestAccounts')).toHaveLength(1)
  })

  it('reads failing on every public RPC are RPC_UNAVAILABLE', async () => {
    const e = createEvm({ rpcs: ['http://127.0.0.1:9/', 'http://127.0.0.1:9/b'] })
    await expect(e.tokenBalance('USDC', owner).catch(toUiError)).resolves.toMatchObject({ code: 'RPC_UNAVAILABLE', retry: 'same' })
    await expect(e.polBalance(owner).catch(toUiError)).resolves.toMatchObject({ code: 'RPC_UNAVAILABLE' })
  })

  it('switches from the default chain to Polygon once', async () => {
    const m = mock('happy')
    const e = createEvm()
    await e.ensurePolygon()
    await e.ensurePolygon()
    expect(m.calls.map(c => c.method)).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId'])
    expect(m.calls[1]!.params).toEqual([{ chainId: '0x89' }])
  })

  // A wallet without Polygon configured; `switchOnAdd` mimics wallets that switch as part of adding.
  function walletWithoutPolygon(switchOnAdd: boolean) {
    const calls: string[] = []
    let chain = '0x1'
    let known = false
    const eth: Eip1193 = {
      async request({ method, params }) {
        calls.push(method)
        if (method === 'eth_chainId') return chain
        if (method === 'wallet_switchEthereumChain') {
          if (!known) throw Object.assign(new Error('unknown chain'), { code: 4902 })
          chain = (params as [{ chainId: string }])[0].chainId
          return null
        }
        if (method === 'wallet_addEthereumChain') {
          const p = (params as [{ chainId: string; rpcUrls: string[]; nativeCurrency: { symbol: string } }])[0]
          expect(p.chainId).toBe('0x89')
          expect(p.nativeCurrency.symbol).toBe('POL')
          expect(p.rpcUrls.length).toBeGreaterThan(0)
          known = true
          if (switchOnAdd) chain = p.chainId
          return null
        }
        throw new Error(method)
      },
    }
    return { calls, eth, chain: () => chain }
  }

  it('4902: adds Polygon, and a wallet that switches on add needs no second dialog', async () => {
    const w = walletWithoutPolygon(true)
    await createEvm({ provider: () => w.eth }).ensurePolygon()
    expect(w.calls).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId'])
    expect(w.chain()).toBe('0x89')
  })

  it('4902: never chains add and switch dialogs in one tap; the next tap switches', async () => {
    const w = walletWithoutPolygon(false)
    const e = createEvm({ provider: () => w.eth })
    await expect(e.ensurePolygon()).rejects.toBeInstanceOf(WrongChainError)
    expect(w.calls).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId'])
    w.calls.length = 0
    await e.ensurePolygon()
    expect(w.calls).toEqual(['eth_chainId', 'wallet_switchEthereumChain'])
    expect(w.chain()).toBe('0x89')
  })

  const usdt0Permit = () =>
    buildPermit({ token: 'asset', asset: 'USDT0', owner, spender: router, value: 5_000_000n, nonce: 0n, deadline: 1_900_000_000n })
  const dialogs = (m: ReturnType<typeof mock>) => m.calls.map(c => c.method).filter(x => x !== 'eth_chainId')

  it('signPermit off Polygon throws WrongChainError and opens no dialog', async () => {
    const m = mock('happy')
    const err = await createEvm().signPermit(usdt0Permit()).catch(e => e)
    expect(err).toBeInstanceOf(WrongChainError)
    expect(toUiError(err)).toMatchObject({ code: 'WRONG_CHAIN', retry: 'same' })
    expect(m.calls.map(c => c.method)).toEqual(['eth_chainId'])
  })

  it('after ensurePolygon, signPermit opens exactly one sign dialog: USDT0 as [owner, JSON] without a chainId', async () => {
    const m = mock('happy')
    const e = createEvm()
    await e.ensurePolygon()
    m.calls.length = 0
    const sig = await e.signPermit(usdt0Permit())
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(dialogs(m)).toEqual(['eth_signTypedData_v4'])
    const [addr, json] = m.calls.find(c => c.method === 'eth_signTypedData_v4')!.params as [string, string]
    expect(addr).toBe(owner)
    const parsed = JSON.parse(json)
    expect(parsed.domain.chainId).toBeUndefined()
    expect(parsed.domain.salt).toBe(ASSETS.USDT0.domain.salt)
    expect(parsed.message.value).toBe('5000000')
  })

  it('a wallet already on Polygon signs in one tap', async () => {
    const m = installMock('?mock=happy&delay=0&chain=0x89', window)
    await createEvm().signPermit(usdt0Permit())
    expect(m.calls.map(c => c.method)).toEqual(['eth_chainId', 'eth_signTypedData_v4'])
  })

  it('a rejected signature is USER_REJECTED', async () => {
    mock('reject-sign')
    const e = createEvm()
    await e.ensurePolygon()
    const td = buildPermit({ token: 'asset', asset: 'USDC', owner, spender: router, value: 1n, nonce: 0n, deadline: 1n })
    await expect(e.signPermit(td).catch(toUiError)).resolves.toMatchObject({ code: 'USER_REJECTED' })
  })

  it('sendTx off Polygon throws WrongChainError and opens no dialog', async () => {
    const m = mock('relay-down')
    await expect(createEvm().sendTx({ from: owner, to: router, data: '0xabcdef' })).rejects.toBeInstanceOf(WrongChainError)
    expect(m.calls.map(c => c.method)).toEqual(['eth_chainId'])
  })

  it('after ensurePolygon, sendTx opens exactly one send dialog with a hex value', async () => {
    const m = mock('relay-down')
    const e = createEvm()
    await e.ensurePolygon()
    m.calls.length = 0
    const hash = await e.sendTx({ from: owner, to: router, data: '0xabcdef', value: 10n })
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(dialogs(m)).toEqual(['eth_sendTransaction'])
    expect(m.calls.find(c => c.method === 'eth_sendTransaction')!.params).toEqual([
      { from: owner, to: router, data: '0xabcdef', value: '0xa' },
    ])
  })

  it('isPolygon reads the chain without a dialog', async () => {
    const m = mock('happy')
    const e = createEvm()
    expect(await e.isPolygon()).toBe(false)
    await e.ensurePolygon()
    expect(await e.isPolygon()).toBe(true)
    expect(dialogs(m)).toEqual(['wallet_switchEthereumChain'])
  })

  it('reads token, aToken, permit nonce and POL balances from a public Polygon RPC, not the wallet', async () => {
    const m = mock('happy')
    const e = createEvm()
    expect(await e.tokenBalance('USDT0', owner)).toBe(25_000_000n)
    expect(await e.tokenBalance(ASSETS.USDT0.aToken, owner)).toBe(100_000_000n)
    expect(await e.permitNonce(ASSETS.USDT0.address, owner)).toBe(0n)
    expect(await e.polBalance(owner)).toBeGreaterThan(0n)
    expect(m.calls).toHaveLength(0)
  })

  it('insufficient scenario has less than the $1 minimum and no POL', async () => {
    mock('insufficient')
    const e = createEvm()
    expect(await e.tokenBalance('USDT0', owner)).toBeLessThan(1_000_000n)
    expect(await e.polBalance(owner)).toBe(0n)
  })

  it('no window.ethereum is PROVIDER_MISSING', async () => {
    await expect(createEvm().connect().catch(toUiError)).resolves.toMatchObject({ code: 'PROVIDER_MISSING' })
  })
})
