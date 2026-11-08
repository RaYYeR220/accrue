import { STAKING_CONTRACT, type NimTx } from '@accrue/shared'
import { maxUint256, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { LocalJob } from '../src/actions/jobs'
import { buildActivity, classifyNimTx, jobRow, nimTxUrl, polygonTxUrl, type NimLogEntry } from '../src/model/activity'

const OWNER = '0xa11ce00000000000000000000000000000000a11' as Address
const WALLET = 'NQ68 L6GS 38D1 L6GS 38D1 L6GS 38D1 L6GS 38D1'
const HASH = `0x${'ab'.repeat(32)}` as Hex

const job = (o: Partial<LocalJob> = {}): LocalJob => ({
  jobId: `0x${'01'.repeat(32)}`,
  owner: OWNER,
  kind: 'supply',
  asset: 'USDT0',
  amount: '1000000',
  createdAt: 1_000,
  status: 'confirmed',
  via: 'relay',
  txHash: HASH,
  ...o,
})

const tx = (o: Partial<NimTx> = {}): NimTx => ({
  hash: 'aa'.repeat(32),
  blockNumber: 41_000_001,
  timestamp: 2_000,
  from: WALLET,
  to: STAKING_CONTRACT,
  fromType: 0,
  toType: 3,
  value: 20_000_000,
  fee: 0,
  senderData: '',
  recipientData: '05',
  relatedAddresses: [],
  ...o,
})

describe('dollar jobs as activity rows', () => {
  it('a confirmed deposit links to its Polygonscan transaction', () => {
    expect(jobRow(job())).toMatchObject({ chain: 'polygon', kind: 'deposit', asset: 'USDT0', amount: 1_000_000n, status: 'confirmed', url: `https://polygonscan.com/tx/${HASH}` })
    expect(polygonTxUrl(HASH)).toBe(`https://polygonscan.com/tx/${HASH}`)
  })

  it('maps every job status to what the person sees', () => {
    expect(jobRow(job({ status: 'sent', txHash: undefined })).status).toBe('checking')
    expect(jobRow(job({ status: 'queued', txHash: undefined }))).toMatchObject({ status: 'pending', url: null })
    expect(jobRow(job({ status: 'submitted' })).status).toBe('pending')
    expect(jobRow(job({ status: 'failed', error: 'SIMULATION_FAILED' }))).toMatchObject({ status: 'failed', errorKey: 'error.SIMULATION_FAILED' })
  })

  it('a job landed by another transaction says so and has no link to guess', () => {
    expect(jobRow(job({ txHash: undefined, detail: { landed: 'elsewhere' } }))).toMatchObject({ status: 'confirmed', url: null, elsewhere: true })
  })

  it('withdraw "all" has no fixed amount', () => {
    expect(jobRow(job({ kind: 'withdraw', amount: maxUint256.toString() }))).toMatchObject({ kind: 'withdraw', amount: null })
  })

  it('a self-paid transaction is marked as paid from the wallet', () => {
    expect(jobRow(job({ via: 'wallet', jobId: HASH })).selfPaid).toBe(true)
  })
})

describe('NIM staking transactions from the chain', () => {
  it.each([
    ['05', 'stake'],
    ['06', 'add'],
    ['07', 'switch'],
    ['08', 'deactivate'],
    ['09', 'retire'],
  ] as const)('recipient data %s is %s', (data, kind) => {
    expect(classifyNimTx(tx({ recipientData: `${data}${'00'.repeat(20)}` }), WALLET)).toBe(kind)
  })

  it('stake leaving the staking contract to the wallet is the remove step', () => {
    expect(classifyNimTx(tx({ from: STAKING_CONTRACT, to: WALLET, recipientData: '' }), WALLET)).toBe('remove')
  })

  it('anything else is not staking activity', () => {
    expect(classifyNimTx(tx({ to: 'NQ11 0000 0000 0000 0000 0000 0000 0000 0000' }), WALLET)).toBeNull()
    expect(classifyNimTx(tx({ recipientData: '00' }), WALLET)).toBeNull()
    expect(classifyNimTx(tx({ from: 'NQ11 0000 0000 0000 0000 0000 0000 0000 0000' }), WALLET)).toBeNull()
  })

  it('links to the explorer of the network the wallet is on', () => {
    expect(nimTxUrl('cafe', 'mainnet')).toBe('https://nimiq.watch/#cafe')
    expect(nimTxUrl('cafe', 'testnet')).toBe('https://test.nimiq.watch/#cafe')
  })
})

describe('buildActivity', () => {
  const logged: NimLogEntry = { hash: 'aa'.repeat(32), wallet: WALLET, kind: 'stake', luna: '20000000', at: 1_500, status: 'pending' }

  it('merges relay jobs, the local NIM log and the chain, newest first', () => {
    const rows = buildActivity({
      jobs: [job({ createdAt: 1_000 })],
      nimLog: [logged],
      nimChain: [tx({ hash: 'bb'.repeat(32), timestamp: 3_000, recipientData: '06' })],
      wallet: WALLET,
      network: 'mainnet',
    })
    expect(rows.map(r => [r.kind, r.at])).toEqual([
      ['add', 3_000],
      ['stake', 1_500],
      ['deposit', 1_000],
    ])
  })

  it('the chain confirms a logged transaction: one row, confirmed', () => {
    const rows = buildActivity({ jobs: [], nimLog: [logged], nimChain: [tx()], wallet: WALLET, network: 'mainnet' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'stake', status: 'confirmed', amount: 20_000_000n, url: `https://nimiq.watch/#${'aa'.repeat(32)}` })
  })

  it('a staking transaction the chain lists as failed is shown failed', () => {
    const rows = buildActivity({ jobs: [], nimLog: [{ ...logged, status: 'failed' }], nimChain: [], wallet: WALLET, network: 'mainnet' })
    expect(rows[0]).toMatchObject({ status: 'failed', errorKey: 'nim.error.TX_FAILED' })
  })
})
