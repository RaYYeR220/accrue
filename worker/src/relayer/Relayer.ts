import { DurableObject } from 'cloudflare:workers'
import {
  decodeEventLog,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  TimeoutError,
  BaseError,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { buildPermit, POLYGON, type AssetKey, type RelayErrorCode } from '@accrue/shared'
import type { Env } from '../env'
import { polygonClient } from '../rpc/polygon'
import { findLanded, judgeState, readOwnerState, routerAbi, routerCalldata, simulate, type Verdict } from './chain'
import { decodeRevert, errorBody, HTTP_STATUS, isTransportError, RelayError, type Detail } from './errors'
import { budgetDay, bumpedFees, GAS_POLICY, gasLimit, initialFees, pickNonce, shouldReplace, type Fees } from './gas'
import { isSignatureHex, jobIdOf, validateRelay, type ParsedRelay, type RelayRequest } from './validate'

export type JobStatus = 'queued' | 'submitted' | 'confirmed' | 'failed'

export interface RelayResponse {
  status: number
  body: Record<string, unknown>
}

/** A relay whose tx is out and has no receipt yet. Kept in DO storage so restarts keep polling it. */
interface Inflight {
  jobId: Hex
  owner: Address
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  amount: string
  permitValue: string
  permitNonce: string
  deadline: string
  r: Hex
  s: Hex
  data: Hex
  gas: string
  nonce: number
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  hashes: Hex[]
  raw: Hex
  bumps: number
  createdAt: number
  lastSentAt: number
}

interface JobRow {
  id: string
  owner: string
  kind: string
  asset: string
  amount: string
  status: JobStatus
  tx_hash: string | null
  nonce: number | null
  error: string | null
  detail: string | null
  created_at: number
}

interface RpcReceipt {
  transactionHash: Hex
  status: Hex
  gasUsed: Hex
  effectiveGasPrice: Hex
  logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[]
}

// Builds secp256k1's base-point table (~50 ms) during script startup, which has its own CPU allowance, instead of
// inside the first relay after the Durable Object wakes up.
privateKeyToAccount(`0x${'0'.repeat(63)}1`)

const DAY_MS = 86_400_000
const DROPPED_AFTER_MS = 30 * 60_000
const BALANCE_TTL_MS = 30_000
const MAX_POLLS_PER_ALARM = 10

class NonceTooLow extends Error {}

export function jobView(row: JobRow) {
  return {
    jobId: row.id,
    status: row.status,
    ...(row.tx_hash ? { txHash: row.tx_hash as Hex } : {}),
    ...(row.error ? { error: row.error as RelayErrorCode } : {}),
    ...(row.detail ? { detail: JSON.parse(row.detail) as Detail } : {}),
  }
}

function toResponse(e: unknown): RelayResponse {
  if (e instanceof RelayError) return { status: HTTP_STATUS[e.code], body: errorBody(e.code, e.detail) }
  console.error('relay internal', e instanceof Error ? e.message : String(e))
  return { status: 500, body: errorBody('INTERNAL') }
}

function routerAddress(env: Env): Address | null {
  const raw = env.ROUTER_ADDRESS?.trim() || POLYGON.router
  return raw ? getAddress(raw) : null
}

const asParsed = (j: Inflight): ParsedRelay => ({
  kind: j.kind,
  asset: j.asset,
  owner: j.owner,
  amount: BigInt(j.amount),
  permitValue: BigInt(j.permitValue),
  deadline: BigInt(j.deadline),
  nonce: BigInt(j.permitNonce),
  signature: '0x',
  v: 27,
  r: j.r,
  s: j.s,
})

/**
 * The one relayer: holds the hot key, serialises every relay and receipt poll behind one queue so relayer nonces
 * never race, and re-signs stuck txs with a higher tip from its alarm.
 */
export class Relayer extends DurableObject<Env> {
  private inflight = new Map<string, Inflight>()
  private nextNonce: number | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private balance: { wei: bigint; at: number } | undefined
  private account: PrivateKeyAccount | undefined
  private client: PublicClient

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.client = polygonClient(env)
    void ctx.blockConcurrencyWhile(async () => {
      const jobs = await ctx.storage.list<Inflight>({ prefix: 'job:' })
      for (const j of jobs.values()) this.inflight.set(j.jobId, j)
      this.nextNonce = await ctx.storage.get<number>('nextNonce')
    })
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private signer(): PrivateKeyAccount {
    if (!this.account) {
      const key = this.env.RELAYER_KEY?.trim()
      if (!key) throw new RelayError('INTERNAL', { reason: 'relayer_not_configured' })
      this.account = privateKeyToAccount(key as Hex)
    }
    return this.account
  }

  /** RPC entry used by the Worker's POST /api/relay; the body comes back as JSON text. */
  async relay(body: unknown): Promise<{ status: number; json: string }> {
    const started = Date.now()
    const res = await this.lock(() => this.handle(body as RelayRequest)).catch(toResponse)
    const b = res.body as { status?: string; error?: string }
    console.log(JSON.stringify({ evt: 'relay', http: res.status, status: b.status, error: b.error, wallMs: Date.now() - started }))
    return { status: res.status, json: JSON.stringify(res.body) }
  }

  private async handle(req: RelayRequest): Promise<RelayResponse> {
    const now = Date.now()
    const router = routerAddress(this.env)
    if (!router) throw new RelayError('INTERNAL', { reason: 'router_not_configured' })
    const account = this.signer()
    // A malformed signature cannot match a stored job; validateRelay rejects it below.
    const jobId = isSignatureHex(req?.signature) ? jobIdOf(req.signature) : ('0x' as Hex)
    const owner = String(req?.owner ?? '').toLowerCase()

    const [existing, count, budget] = await this.env.DB.batch([
      this.env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?1').bind(jobId),
      this.env.DB.prepare('SELECT COUNT(*) AS n FROM relay_jobs WHERE owner = ?1 AND created_at > ?2').bind(
        owner,
        now - DAY_MS,
      ),
      this.env.DB.prepare('SELECT gas_wei FROM relay_budget WHERE day = ?1').bind(budgetDay(now)),
    ])
    const row = existing?.results[0] as JobRow | undefined
    if (row) return { status: 202, body: jobView(row) }

    const spent = BigInt((budget?.results[0] as { gas_wei?: string } | undefined)?.gas_wei ?? '0')
    const reserved = this.reservedWei()
    const relayerBalanceWei = await this.relayerBalance(account.address)
    const v = validateRelay(req, {
      now,
      ownerCount24h: Number((count?.results[0] as { n?: number } | undefined)?.n ?? 0),
      budgetWeiToday: spent + reserved,
      budgetWeiMax: GAS_POLICY.budgetWeiMax,
      relayerBalanceWei,
      floorWei: GAS_POLICY.floorWei,
    })
    if (!v.ok) throw new RelayError(v.error, v.detail)
    const p = v.parsed

    const permit = buildPermit({
      token: p.kind === 'supply' ? 'asset' : 'aToken',
      asset: p.asset,
      owner: p.owner,
      spender: router,
      value: p.permitValue,
      nonce: p.nonce,
      deadline: p.deadline,
    })
    const signer = await recoverTypedDataAddress({ ...permit, signature: p.signature })
    if (!isAddressEqual(signer, p.owner)) throw new RelayError('BAD_SIGNATURE', { reason: 'signer_mismatch' })

    for (const j of this.inflight.values()) {
      if (j.kind === p.kind && j.asset === p.asset && j.owner === p.owner && j.permitNonce === p.nonce.toString())
        throw new RelayError('PERMIT_NONCE_STALE', { reason: 'in_flight', jobId: j.jobId })
    }

    const conclude = async (verdict: Verdict): Promise<RelayResponse | null> => {
      if (!verdict) return null
      if ('error' in verdict) throw verdict.error
      await this.upsertJob(jobId, p, now, 'confirmed', verdict.landed, null, { reason: 'already_landed' })
      return { status: 202, body: { jobId, status: 'confirmed', txHash: verdict.landed } }
    }

    const early = await conclude(await judgeState(this.client, router, p, await readOwnerState(this.client, p)))
    if (early) return early

    const data = routerCalldata(p)
    const revert = await simulate(this.client, account.address, router, data)
    if (revert) {
      // Re-read: the revert may come from state that changed since the first read (e.g. a replayed permit).
      const late = await conclude(await judgeState(this.client, router, p, await readOwnerState(this.client, p)))
      if (late) return late
      if (p.kind === 'withdraw' && revert.name === 'NothingToWithdraw')
        throw new RelayError('BAD_SIGNATURE', { reason: 'permit_rejected' })
      throw new RelayError('SIMULATION_FAILED', { reason: revert.reason })
    }

    return this.submit(jobId, p, data, router, now, spent + reserved, relayerBalanceWei - reserved)
  }

  private async submit(
    jobId: Hex,
    p: ParsedRelay,
    data: Hex,
    router: Address,
    now: number,
    committedWei: bigint,
    freeBalanceWei: bigint,
  ): Promise<RelayResponse> {
    const account = this.signer()
    const [est, base, tip, pending] = await Promise.allSettled([
      this.client.estimateGas({ account: account.address, to: router, data }),
      this.nextBaseFee(),
      this.client.request({ method: 'eth_maxPriorityFeePerGas' }).then(h => hexToBigInt(h)),
      this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ])
    if (est.status === 'rejected') {
      const r = decodeRevert(est.reason, routerAbi)
      throw r ? new RelayError('SIMULATION_FAILED', { reason: r.reason }) : new RelayError('RPC_UNAVAILABLE')
    }
    if (base.status === 'rejected' || tip.status === 'rejected') throw new RelayError('RPC_UNAVAILABLE')

    const gas = gasLimit(est.value)
    const fees = initialFees(base.value, tip.value)
    const cost = gas * fees.maxFeePerGas
    if (committedWei + cost > GAS_POLICY.budgetWeiMax) throw new RelayError('BUDGET_EXHAUSTED')
    if (freeBalanceWei < cost) throw new RelayError('RELAYER_LOW_GAS')

    let nonce: number
    try {
      nonce = pickNonce(this.nextNonce, pending.status === 'fulfilled' ? pending.value : undefined, this.inflight.size > 0)
    } catch {
      throw new RelayError('RPC_UNAVAILABLE')
    }

    let job: Inflight | undefined
    for (let attempt = 0; attempt < 2 && !job; attempt++) {
      const raw = await this.sign(router, data, gas, nonce, fees)
      const candidate: Inflight = {
        jobId,
        owner: p.owner,
        kind: p.kind,
        asset: p.asset,
        amount: p.amount.toString(),
        permitValue: p.permitValue.toString(),
        permitNonce: p.nonce.toString(),
        deadline: p.deadline.toString(),
        r: p.r,
        s: p.s,
        data,
        gas: gas.toString(),
        nonce,
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        hashes: [keccak256(raw)],
        raw,
        bumps: 0,
        createdAt: now,
        lastSentAt: Date.now(),
      }
      // Persist before broadcasting so a crash mid-send still leaves the tx tracked.
      await this.ctx.storage.put(`job:${jobId}`, candidate)
      try {
        await this.sendRaw(raw)
        job = candidate
      } catch (e) {
        await this.ctx.storage.delete(`job:${jobId}`)
        if (e instanceof NonceTooLow && attempt === 0) {
          const fresh = await this.client
            .getTransactionCount({ address: account.address, blockTag: 'pending' })
            .catch(() => undefined)
          if (fresh === undefined) throw new RelayError('RPC_UNAVAILABLE')
          nonce = Math.max(fresh, nonce + 1)
          continue
        }
        throw e instanceof RelayError ? e : new RelayError('INTERNAL', { reason: 'send_rejected' })
      }
    }
    if (!job) throw new RelayError('INTERNAL', { reason: 'send_rejected' })

    this.inflight.set(jobId, job)
    this.nextNonce = job.nonce + 1
    await this.ctx.storage.put('nextNonce', this.nextNonce)
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + GAS_POLICY.pollMs)

    const txHash = job.hashes[0]!
    try {
      await this.upsertJob(jobId, p, now, 'submitted', txHash, null, null)
    } catch (e) {
      // The tx is out and tracked in storage; the alarm writes the row again when it settles.
      console.error('relay_jobs insert failed', e instanceof Error ? e.message : String(e))
    }
    return { status: 202, body: { jobId, status: 'submitted', txHash } }
  }

  private sign(router: Address, data: Hex, gas: bigint, nonce: number, fees: Fees): Promise<Hex> {
    return this.signer().signTransaction({
      type: 'eip1559',
      chainId: POLYGON.chainId,
      to: router,
      data,
      value: 0n,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
  }

  /** Resolves once a node has the tx (or may have it, on a timeout); throws when it was definitely refused. */
  private async sendRaw(raw: Hex): Promise<void> {
    try {
      await this.client.request({ method: 'eth_sendRawTransaction', params: [raw] })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/already known|known transaction|already imported|already exists/i.test(msg)) return
      if (/nonce too low|nonce has already been used|nonce_expired|oldnonce/i.test(msg)) throw new NonceTooLow()
      if (/insufficient funds/i.test(msg)) throw new RelayError('RELAYER_LOW_GAS')
      if (e instanceof BaseError && e.walk(x => x instanceof TimeoutError)) return
      if (isTransportError(e)) throw new RelayError('RPC_UNAVAILABLE')
      console.error('send rejected', msg.slice(0, 200))
      throw new RelayError('INTERNAL', { reason: 'send_rejected' })
    }
  }

  private async nextBaseFee(): Promise<bigint> {
    const h = (await this.client.request({
      method: 'eth_feeHistory',
      params: ['0x1', 'latest', []],
    })) as { baseFeePerGas: Hex[] }
    const next = h.baseFeePerGas[h.baseFeePerGas.length - 1]
    if (!next) throw new Error('no base fee')
    return hexToBigInt(next)
  }

  private reservedWei(): bigint {
    let sum = 0n
    for (const j of this.inflight.values()) sum += BigInt(j.gas) * BigInt(j.maxFeePerGas)
    return sum
  }

  private async relayerBalance(address: Address): Promise<bigint> {
    if (this.balance && Date.now() - this.balance.at < BALANCE_TTL_MS) return this.balance.wei
    try {
      const wei = await this.client.getBalance({ address })
      this.balance = { wei, at: Date.now() }
      return wei
    } catch {
      throw new RelayError('RPC_UNAVAILABLE')
    }
  }

  private async upsertJob(
    jobId: Hex,
    p: Pick<ParsedRelay, 'owner' | 'kind' | 'asset' | 'amount' | 'nonce'>,
    createdAt: number,
    status: JobStatus,
    txHash: Hex | null,
    error: RelayErrorCode | null,
    detail: Detail | null,
  ) {
    await this.env.DB.prepare(
      `INSERT INTO relay_jobs (id, owner, kind, asset, amount, status, tx_hash, nonce, error, detail, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash, error = excluded.error,
         detail = excluded.detail, updated_at = excluded.updated_at`,
    )
      .bind(
        jobId,
        p.owner.toLowerCase(),
        p.kind,
        p.asset,
        p.amount.toString(),
        status,
        txHash,
        p.nonce.toString(),
        error,
        detail ? JSON.stringify(detail) : null,
        createdAt,
        Date.now(),
      )
      .run()
  }

  async alarm(): Promise<void> {
    await this.lock(async () => {
      const now = Date.now()
      for (const j of [...this.inflight.values()].slice(0, MAX_POLLS_PER_ALARM)) {
        try {
          await this.poll(j, now)
        } catch (e) {
          console.error('poll failed', j.jobId, e instanceof Error ? e.message.slice(0, 200) : String(e))
        }
      }
      if (this.inflight.size > 0) await this.ctx.storage.setAlarm(Date.now() + GAS_POLICY.pollMs)
    })
  }

  private async poll(j: Inflight, now: number) {
    const receipts = (await Promise.all(
      j.hashes.map(h => this.client.request({ method: 'eth_getTransactionReceipt', params: [h] })),
    )) as (RpcReceipt | null)[]
    const rc = receipts.find(r => r)
    if (rc) return this.settle(j, rc)

    if (shouldReplace(j.lastSentAt, now, j.bumps)) {
      const fees = bumpedFees(
        { maxFeePerGas: BigInt(j.maxFeePerGas), maxPriorityFeePerGas: BigInt(j.maxPriorityFeePerGas) },
        await this.nextBaseFee(),
      )
      const raw = await this.sign(routerAddress(this.env)!, j.data, BigInt(j.gas), j.nonce, fees)
      try {
        await this.sendRaw(raw)
      } catch (e) {
        // One of the earlier txs was mined under this nonce; the next poll picks up its receipt.
        if (e instanceof NonceTooLow) return
        throw e
      }
      Object.assign(j, {
        raw,
        hashes: [...j.hashes, keccak256(raw)],
        bumps: j.bumps + 1,
        lastSentAt: now,
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      })
      await this.ctx.storage.put(`job:${j.jobId}`, j)
      console.log(JSON.stringify({ evt: 'bump', jobId: j.jobId, bumps: j.bumps, tip: j.maxPriorityFeePerGas }))
      return
    }

    if (now - j.lastSentAt >= GAS_POLICY.replaceAfterMs) {
      await this.sendRaw(j.raw).catch(() => undefined)
      j.lastSentAt = now
      await this.ctx.storage.put(`job:${j.jobId}`, j)
    }

    if (now - j.createdAt > DROPPED_AFTER_MS) {
      const mined = await this.client.getTransactionCount({ address: this.signer().address, blockTag: 'latest' })
      if (mined > j.nonce) await this.finish(j, 'failed', j.hashes[j.hashes.length - 1]!, 'SIMULATION_FAILED', { reason: 'dropped' })
    }
  }

  private async settle(j: Inflight, rc: RpcReceipt) {
    await this.addSpent(hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice))
    this.balance = undefined
    if (rc.status === '0x1') {
      let detail: Detail | null = null
      if (j.kind === 'withdraw') {
        for (const log of rc.logs) {
          try {
            const ev = decodeEventLog({ abi: routerAbi, topics: log.topics, data: log.data })
            if (ev.eventName === 'Withdrawn') detail = { withdrawn: (ev.args as { amount: bigint }).amount.toString() }
          } catch {
            // not a router event
          }
        }
      }
      return this.finish(j, 'confirmed', rc.transactionHash, null, detail)
    }
    // Our tx reverted; if someone else relayed the same signature first, the user's deposit still landed.
    const router = routerAddress(this.env)
    const landed = router ? await findLanded(this.client, router, asParsed(j)) : null
    if (landed && landed !== 'unknown') return this.finish(j, 'confirmed', landed, null, { reason: 'already_landed' })
    return this.finish(j, 'failed', rc.transactionHash, 'SIMULATION_FAILED', {
      reason: 'reverted_onchain',
      ...(landed === 'unknown' ? { landedCheck: 'unavailable' } : {}),
    })
  }

  private async finish(j: Inflight, status: JobStatus, txHash: Hex, error: RelayErrorCode | null, detail: Detail | null) {
    await this.upsertJob(
      j.jobId,
      { owner: j.owner, kind: j.kind, asset: j.asset, amount: BigInt(j.amount), nonce: BigInt(j.permitNonce) },
      j.createdAt,
      status,
      txHash,
      error,
      detail,
    )
    this.inflight.delete(j.jobId)
    await this.ctx.storage.delete(`job:${j.jobId}`)
    console.log(JSON.stringify({ evt: 'settled', jobId: j.jobId, status, error }))
  }

  private async addSpent(wei: bigint) {
    await this.env.DB.prepare(
      `INSERT INTO relay_budget (day, gas_wei, count) VALUES (?1, ?2, 1)
       ON CONFLICT(day) DO UPDATE SET gas_wei = CAST(CAST(gas_wei AS INTEGER) + CAST(excluded.gas_wei AS INTEGER) AS TEXT),
         count = count + 1`,
    )
      .bind(budgetDay(Date.now()), wei.toString())
      .run()
  }
}
