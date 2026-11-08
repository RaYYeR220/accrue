// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { SCENARIO_NAMES } from '../src/mock/scenarios'

afterEach(() => {
  uninstallMock(window)
  sessionStorage.clear()
})

const relay = (body: object) =>
  fetch('/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('installMock', () => {
  it('knows exactly the scenarios the plan lists', () => {
    expect([...SCENARIO_NAMES].sort()).toEqual(
      [
        'happy',
        'reject-sign',
        'insufficient',
        'relay-down',
        'stale-nonce',
        'unknown-outcome',
        'htlc-only-balance',
        'aave-illiquid',
        'testnet',
      ].sort(),
    )
  })

  it('injects frozen host context, a NIM provider and an EIP-1193 provider', () => {
    installMock('?mock=happy&delay=0', window)
    expect(window.nimiqPay).toMatchObject({ language: 'en', userFiat: 'USD', network: 'mainnet' })
    expect(Object.isFrozen(window.nimiqPay)).toBe(true)
    expect(typeof window.nimiq?.listAccounts).toBe('function')
    expect(typeof window.ethereum?.request).toBe('function')
  })

  it('takes language, fiat and network overrides from the query', () => {
    installMock('?mock=happy&lang=de&fiat=EUR&delay=0', window)
    expect(window.nimiqPay).toMatchObject({ language: 'de', userFiat: 'EUR' })
    uninstallMock(window)
    installMock('?mock=testnet&delay=0', window)
    expect(window.nimiqPay?.network).toBe('testnet')
  })

  it('the wallet starts on Ethereum unless chain= says otherwise', async () => {
    installMock('?mock=happy&delay=0', window)
    expect(await window.ethereum!.request({ method: 'eth_chainId' })).toBe('0x1')
    uninstallMock(window)
    installMock('?mock=happy&delay=0&chain=0x89', window)
    expect(await window.ethereum!.request({ method: 'eth_chainId' })).toBe('0x89')
  })

  it('rejects unknown scenarios loudly', () => {
    expect(() => installMock('?mock=nope', window)).toThrow(/happy/)
  })

  it('records provider calls and counts the ones before the first interaction', async () => {
    const m = installMock('?mock=happy&delay=0', window)
    expect(m.calls).toHaveLength(0)
    await window.nimiq!.listAccounts()
    expect(m.callsBeforeFirstInteraction()).toBe(1)
    document.dispatchEvent(new Event('pointerdown'))
    await window.ethereum!.request({ method: 'eth_chainId' })
    expect(m.calls.map(c => `${c.api}.${c.method}`)).toEqual(['nimiq.listAccounts', 'ethereum.eth_chainId'])
    expect(m.callsBeforeFirstInteraction()).toBe(1)
  })

  it('does not count API fetches as provider calls', async () => {
    const m = installMock('?mock=happy&delay=0', window)
    await fetch('/api/rates')
    expect(m.calls).toHaveLength(0)
  })

  it('answers /api/rates', async () => {
    installMock('?mock=happy&delay=0', window)
    const r = await (await fetch('/api/rates')).json()
    expect(r.fx.USD).toBe(1)
    expect(r.nimUsd).toBeGreaterThan(0)
  })
})

describe('mock relay', () => {
  const req = { kind: 'supply', asset: 'USDT0', owner: '0x1111111111111111111111111111111111111111', amount: '5000000', signature: '0x01' }

  it('happy: a job goes queued, submitted, confirmed', async () => {
    installMock('?mock=happy&delay=0', window)
    const res = await relay(req)
    expect(res.status).toBe(202)
    const { jobId } = await res.json()
    const seen: string[] = []
    for (let i = 0; i < 3; i++) seen.push((await (await fetch(`/api/relay/${jobId}`)).json()).status)
    expect(seen).toEqual(['submitted', 'confirmed', 'confirmed'])
    const byOwner = await (await fetch(`/api/relay/by-owner/${req.owner}`)).json()
    expect(byOwner.jobs).toHaveLength(1)
  })

  it('relay-down: 503 RPC_UNAVAILABLE, as the worker answers when the relayer cannot be reached', async () => {
    installMock('?mock=relay-down&delay=0', window)
    const res = await relay(req)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'RPC_UNAVAILABLE', detail: { reason: 'relayer_unavailable' } })
  })

  it('stale-nonce: the first permit is stale, a re-signed one goes through', async () => {
    installMock('?mock=stale-nonce&delay=0', window)
    const first = await relay(req)
    expect(first.status).toBe(409)
    expect(await first.json()).toEqual({ error: 'PERMIT_NONCE_STALE' })
    expect((await relay({ ...req, signature: '0x02' })).status).toBe(202)
  })

  it('aave-illiquid: withdraw reports the available liquidity, supply works', async () => {
    installMock('?mock=aave-illiquid&delay=0', window)
    const w = await relay({ ...req, kind: 'withdraw' })
    expect(w.status).toBe(422)
    expect(await w.json()).toEqual({ error: 'AAVE_LIQUIDITY', detail: { available: '3000000' } })
    expect((await relay(req)).status).toBe(202)
  })

  it('insufficient: the relay refuses the amount', async () => {
    installMock('?mock=insufficient&delay=0', window)
    expect(await (await relay(req)).json()).toEqual({ error: 'INSUFFICIENT_BALANCE' })
  })

  it('unknown-outcome: the relay takes the job but no answer arrives until the app is reopened, then it confirms', async () => {
    installMock('?mock=unknown-outcome&delay=0', window)
    await expect(relay(req)).rejects.toThrow(TypeError)
    await expect(fetch('/api/relay/by-owner/' + req.owner)).rejects.toThrow(TypeError)
    // a reload: the relay kept the job and answers again
    uninstallMock(window)
    installMock('?mock=unknown-outcome&delay=0', window)
    const { jobs } = await (await fetch(`/api/relay/by-owner/${req.owner}`)).json()
    expect(jobs).toHaveLength(1)
    const seen: string[] = []
    for (let i = 0; i < 2; i++) seen.push((await (await fetch(`/api/relay/${jobs[0].jobId}`)).json()).status)
    expect(seen).toEqual(['submitted', 'confirmed'])
  })

  it('a confirmed deposit moves the mock balances, and the position API follows', async () => {
    installMock('?mock=happy&delay=0', window)
    const owner = '0xa11ce00000000000000000000000000000000a11'
    const before = await (await fetch(`/api/position/${owner}`)).json()
    expect(before.assets.USDT0.aTokenBalance).toBe('100000000')
    const { jobId } = await (await relay({ ...req, owner })).json()
    await fetch(`/api/relay/${jobId}`)
    await fetch(`/api/relay/${jobId}`)
    const after = await (await fetch(`/api/position/${owner}`)).json()
    expect(after.assets.USDT0).toMatchObject({ aTokenBalance: '105000000', principal: '103400000' })
    // and it survives a reload
    uninstallMock(window)
    installMock('?mock=happy&delay=0', window)
    expect((await (await fetch(`/api/position/${owner}`)).json()).assets.USDT0.aTokenBalance).toBe('105000000')
  })

  // Same shapes the testnet RPC returned (task-12 report).
  it('NIM reads answer like the real RPC: no-staker error, tx lookups, validators, policy', async () => {
    installMock('?mock=htlc-only-balance&delay=0', window)
    const nimiq = window.nimiq!
    const wallet = ((await nimiq.listAccounts()) as string[])[0]!
    const noStaker = await nimiq.request({ method: 'getStakerByAddress', params: [wallet] }).catch((e: unknown) => e)
    expect(noStaker).toMatchObject({ code: -32603, message: 'Internal error', data: `No staker with address: ${wallet}` })
    const unknownTx = await nimiq.request({ method: 'getTransactionByHash', params: ['ab'] }).catch((e: unknown) => e)
    expect(unknownTx).toMatchObject({ code: -32603, message: 'Internal error', data: 'Transaction not found: ab' })
    const hash = await nimiq.sendNewStakerTransaction({ delegation: 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH', value: 20_000_000 })
    const tx = await nimiq.request({ method: 'getTransactionByHash', params: [hash] })
    expect(tx).toMatchObject({ data: { hash, executionResult: true } })
    expect((tx as { data: { blockNumber: number } }).data.blockNumber).toBeGreaterThan(0)
    const v = await nimiq.request({ method: 'getValidatorByAddress', params: ['NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'] })
    expect(v).toMatchObject({ data: { jailedFrom: null } })
    const p = await nimiq.request({ method: 'getPolicyConstants', params: [] })
    expect(p).toMatchObject({ data: { blocksPerEpoch: 43_200, blockSeparationTime: 1_000, genesisBlockNumber: 3_456_000, jailEpochs: 8 } })
    const missing = await nimiq.request({ method: 'getNothing', params: [] }).catch((e: unknown) => e)
    expect(missing).toMatchObject({ code: -32601 })
  })

  it('staking transactions change the mock staker and show up in the address history', async () => {
    installMock('?mock=htlc-only-balance&delay=0', window)
    const nimiq = window.nimiq!
    const [wallet, htlc] = (await nimiq.listAccounts()) as string[]
    const siam = 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH'
    const hash = await nimiq.sendNewStakerTransaction({ delegation: siam, value: 20_000_000 })
    expect(await nimiq.request({ method: 'getStakerByAddress', params: [wallet] })).toMatchObject({ data: { balance: 20_000_000, delegation: siam } })
    expect(await nimiq.getBalance(htlc!)).toBe(105_000_000)
    await nimiq.sendSetActiveStakeTransaction({ newActiveBalance: 0 })
    const s = (await nimiq.request({ method: 'getStakerByAddress', params: [wallet] })) as { data: { balance: number; inactiveBalance: number; inactiveFrom: number } }
    expect(s.data).toMatchObject({ balance: 0, inactiveBalance: 20_000_000 })
    expect(s.data.inactiveFrom).toBeGreaterThan(41_000_000)
    const history = (await nimiq.request({ method: 'getTransactionsByAddress', params: [wallet, 20] })) as { data: { hash: string; recipientData: string }[] }
    expect(history.data.map(t => t.recipientData.slice(0, 2))).toEqual(['08', '05'])
    expect(history.data[1]!.hash).toBe(hash)
  })

  it('answers the read APIs: pools with every verdict, the check for the wallet, Aave reserves', async () => {
    installMock('?mock=happy&delay=0', window)
    const pools = await (await fetch('/api/pools')).json()
    const verdicts = new Set(pools.pools.map((p: { verdict?: string }) => p.verdict ?? null))
    for (const v of ['PAID_AS_PROMISED', 'BEHIND_SCHEDULE', 'SHORT', 'NOT_ENOUGH_DATA', 'NO_PAYOUTS_BY_DESIGN', 'CANT_VERIFY_ROUTED', null]) expect(verdicts.has(v)).toBe(true)
    const check = await (await fetch('/api/check/NQ68L6GS38D1L6GS38D1L6GS38D1L6GS38D1')).json()
    expect(check).toMatchObject({ staker: { activeLuna: '100000000', delegation: 'NQ38 VK34 DRBL S3CN M9KM 8UJN 9JY2 2KFN VQQH' }, verdict: 'PAID_AS_PROMISED' })
    expect(check.pool.name).toBe('Siam Pool')
    const aave = await (await fetch('/api/aave')).json()
    expect(Object.keys(aave.reserves).sort()).toEqual(['USDC', 'USDT0'])
  })

  it('testnet: pools come from the testnet validators API', async () => {
    installMock('?mock=testnet&delay=0', window)
    const list = await (await fetch('https://validators-api-test.je-cf9.workers.dev/api/v1/validators')).json()
    expect(list.length).toBeGreaterThan(1)
    expect(list.some((v: { address: string }) => v.address === 'NQ10 UPJX BRF5 UPJX BRF5 UPJX BRF5 UPJX BRF5')).toBe(true)
  })

  it('the testnet scenario reports testnet policy constants', async () => {
    installMock('?mock=testnet&delay=0', window)
    const p = await window.nimiq!.request({ method: 'getPolicyConstants', params: [] })
    expect(p).toMatchObject({ data: { genesisBlockNumber: 3_032_010 } })
  })

  it('restores the real fetch and globals on uninstall', () => {
    const realFetch = window.fetch
    installMock('?mock=happy&delay=0', window)
    expect(window.fetch).not.toBe(realFetch)
    uninstallMock(window)
    expect(window.fetch).toBe(realFetch)
    expect(window.nimiqPay).toBeUndefined()
    expect(window.nimiq).toBeUndefined()
    expect(window.ethereum).toBeUndefined()
  })
})
