// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installMock, uninstallMock } from '../src/mock/installMock'
import { SCENARIO_NAMES } from '../src/mock/scenarios'

afterEach(() => uninstallMock(window))

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

  it('relay-down: 503 without a body code', async () => {
    installMock('?mock=relay-down&delay=0', window)
    expect((await relay(req)).status).toBe(503)
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

  it('unknown-outcome: the job never confirms', async () => {
    installMock('?mock=unknown-outcome&delay=0', window)
    const { jobId } = await (await relay(req)).json()
    for (let i = 0; i < 4; i++) await fetch(`/api/relay/${jobId}`)
    expect((await (await fetch(`/api/relay/${jobId}`)).json()).status).toBe('submitted')
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
