import { DurableObject } from 'cloudflare:workers'
import { decodeEventLog, hexToBigInt, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { POLYGON, type AssetKey, type RelayErrorCode } from '@accrue/shared'
import type { Env } from '../env'
import { polygonClient, polygonUrls } from '../rpc/polygon'
import { broadcast } from './broadcast'
import { findLanded, routerAbi, routerAddress, routerCalldata, simulate } from './chain'
import { decodeRevert, RelayError, toResponse, type Detail, type RelayResponse } from './errors'
import { budgetDay, bumpedFees, GAS_POLICY, gasLimit, initialFees, pickNonce, type Fees } from './gas'
import { fromSubmit, jobView, upsertJob, type JobRow, type JobStatus, type SubmitRequest } from './jobs'
import { checkLimits, type ParsedRelay } from './validate'
import './warm'

type CancelReason = 'deadline' | 'would_revert' | 'stuck'

/** A relay whose nonce is not settled yet. Kept in DO storage so restarts keep driving it. */
interface Inflight {
  jobId: Hex
  owner: Address
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  amount: string
  permitValue: string
  permitNonce: string
  deadline: string
  v: 27 | 28
  r: Hex
  s: Hex
  /** Router calldata. */
  data: Hex
  /** Gas limit, fees and raw bytes of the most recent tx signed for `nonce`. */
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  raw: Hex
  nonce: number
  /** Every tx signed for `nonce`, oldest first; any of them may be the one that gets mined. */
  hashes: Hex[]
  cancelHashes: Hex[]
  cancelReason?: CancelReason
  cancelRevert?: string
  /** A node confirmed it has `raw`. */
  accepted: boolean
  bumps: number
  cancelBumps: number
  /** Polls in a row that saw `nonce` used with no receipt for any of `hashes`. */
  consumedPolls: number
  createdAt: number
  lastSentAt: number
}

interface RpcReceipt {
  transactionHash: Hex
  status: Hex
  gasUsed: Hex
  effectiveGasPrice: Hex
  logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[]
}

const DAY_MS = 86_400_000
const BALANCE_TTL_MS = 30_000
const MAX_POLLS_PER_ALARM = 10

const CANCEL_OUTCOME: Record<CancelReason, (j: Inflight) => [RelayErrorCode, Detail]> = {
  deadline: () => ['DEADLINE_INVALID', { reason: 'expired_pending' }],
  would_revert: j => ['SIMULATION_FAILED', { reason: j.cancelRevert ?? 'reverted' }],
  stuck: () => ['RPC_UNAVAILABLE', { reason: 'not_included' }],
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
  v: j.v,
  r: j.r,
  s: j.s,
})

/**
 * The one relayer: holds the hot key and the nonce. It receives only relays the Worker has already validated and
 * simulated, re-checks them against fresh state through estimateGas, then signs, persists and broadcasts. Its
 * alarm follows every tx to a receipt, re-tips stuck ones and cancels ones that can no longer succeed.
 */
export class Relayer extends DurableObject<Env> {
  readonly ready: Promise<void>
  private inflight = new Map<string, Inflight>()
  private nextNonce: number | undefined
  private queue: Promise<unknown>
  private balance: { wei: bigint; at: number } | undefined
  private account: PrivateKeyAccount | undefined
  private client: PublicClient

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.client = polygonClient(env)
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const jobs = await ctx.storage.list<Inflight>({ prefix: 'job:' })
      for (const j of jobs.values()) this.inflight.set(j.jobId, j)
      this.nextNonce = await ctx.storage.get<number>('nextNonce')
      // Being killed between a broadcast and the alarm write must not orphan a job.
      if (this.inflight.size > 0 && (await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + GAS_POLICY.pollMs)
    })
    this.queue = this.ready
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

  /** RPC from the Worker's POST /api/relay; the body comes back as JSON text. */
  async submit(q: SubmitRequest): Promise<{ status: number; json: string }> {
    const res = await this.lock(() => this.accept(q)).catch(e => toResponse(e, 'relayer'))
    console.log(JSON.stringify({ evt: 'submit', http: res.status, status: res.body.status, error: res.body.error }))
    return { status: res.status, json: JSON.stringify(res.body) }
  }

  private async accept(q: SubmitRequest): Promise<RelayResponse> {
    const now = Date.now()
    const router = routerAddress(this.env)
    if (!router) throw new RelayError('INTERNAL', { reason: 'router_not_configured' })
    const account = this.signer()

    const mine = this.inflight.get(q.jobId)
    if (mine)
      return { status: 202, body: { jobId: q.jobId, status: mine.accepted ? 'submitted' : 'queued', txHash: mine.hashes[0] } }

    let row: JobRow | undefined
    let count = 0
    let spent = 0n
    try {
      const [existing, recent, budget] = await this.env.DB.batch([
        this.env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?1').bind(q.jobId),
        this.env.DB.prepare('SELECT COUNT(*) AS n FROM relay_jobs WHERE owner = ?1 AND created_at > ?2').bind(
          q.owner.toLowerCase(),
          now - DAY_MS,
        ),
        this.env.DB.prepare('SELECT gas_wei FROM relay_budget WHERE day = ?1').bind(budgetDay(now)),
      ])
      row = existing?.results[0] as JobRow | undefined
      count = Number((recent?.results[0] as { n?: number } | undefined)?.n ?? 0)
      spent = BigInt((budget?.results[0] as { gas_wei?: string } | undefined)?.gas_wei ?? '0')
    } catch {
      throw new RelayError('INTERNAL', { reason: 'db_error' })
    }
    if (row) return { status: 202, body: jobView(row) }

    const reserved = this.reservedWei()
    const balance = await this.relayerBalance(account.address)
    const limit = checkLimits({
      ownerCount24h: count,
      budgetWeiToday: spent + reserved,
      budgetWeiMax: GAS_POLICY.budgetWeiMax,
      relayerBalanceWei: balance,
      floorWei: GAS_POLICY.floorWei,
    })
    if (limit) throw new RelayError(limit.error, limit.detail)

    for (const j of this.inflight.values()) {
      if (j.kind === q.kind && j.asset === q.asset && j.owner === q.owner && j.permitNonce === q.nonce)
        throw new RelayError('PERMIT_NONCE_STALE', { reason: 'in_flight', jobId: j.jobId })
    }

    const p = fromSubmit(q)
    return this.send(q.jobId, p, routerCalldata(p), router, now, spent + reserved, balance - reserved)
  }

  /** estimateGas doubles as the re-simulation against fresh state, so nothing is signed unsimulated. */
  private async quote(router: Address, data: Hex) {
    const from = this.signer().address
    const [est, base, tip, pending] = await Promise.allSettled([
      this.client.estimateGas({ account: from, to: router, data }),
      this.nextBaseFee(),
      this.client.request({ method: 'eth_maxPriorityFeePerGas' }).then(h => hexToBigInt(h)),
      this.client.getTransactionCount({ address: from, blockTag: 'pending' }),
    ])
    if (est.status === 'rejected') {
      const r = decodeRevert(est.reason, routerAbi)
      throw r ? new RelayError('SIMULATION_FAILED', { reason: r.reason }) : new RelayError('RPC_UNAVAILABLE')
    }
    if (base.status === 'rejected' || tip.status === 'rejected') throw new RelayError('RPC_UNAVAILABLE')
    return {
      gas: gasLimit(est.value),
      fees: initialFees(base.value, tip.value),
      pending: pending.status === 'fulfilled' ? pending.value : undefined,
    }
  }

  private async send(
    jobId: Hex,
    p: ParsedRelay,
    data: Hex,
    router: Address,
    now: number,
    committedWei: bigint,
    freeBalanceWei: bigint,
  ): Promise<RelayResponse> {
    let quote = await this.quote(router, data)
    const cost = quote.gas * quote.fees.maxFeePerGas
    if (committedWei + cost > GAS_POLICY.budgetWeiMax) throw new RelayError('BUDGET_EXHAUSTED')
    if (freeBalanceWei < cost) throw new RelayError('RELAYER_LOW_GAS')

    let nonce: number
    try {
      nonce = pickNonce(this.nextNonce, quote.pending, this.inflight.size > 0)
    } catch {
      throw new RelayError('RPC_UNAVAILABLE')
    }

    for (let attempt = 0; ; attempt++) {
      const raw = await this.sign({ to: router, data, gas: quote.gas, nonce, fees: quote.fees })
      const job: Inflight = {
        jobId,
        owner: p.owner,
        kind: p.kind,
        asset: p.asset,
        amount: p.amount.toString(),
        permitValue: p.permitValue.toString(),
        permitNonce: p.nonce.toString(),
        deadline: p.deadline.toString(),
        v: p.v,
        r: p.r,
        s: p.s,
        data,
        gas: quote.gas.toString(),
        maxFeePerGas: quote.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: quote.fees.maxPriorityFeePerGas.toString(),
        raw,
        nonce,
        hashes: [keccak256(raw)],
        cancelHashes: [],
        accepted: false,
        bumps: 0,
        cancelBumps: 0,
        consumedPolls: 0,
        createdAt: now,
        lastSentAt: Date.now(),
      }
      const prevNonce = this.nextNonce
      await this.track(job, nonce + 1)

      const outcome = await broadcast(polygonUrls(this.env), raw)
      if (outcome === 'accepted' || outcome === 'ambiguous') return this.recordSent(job, p, outcome === 'accepted')
      if (outcome === 'nonce_low') {
        // Possibly our own tx, taken by a node that answered late; only a definite "no such tx" moves on.
        const known = await this.txKnown(job.hashes[0]!)
        if (known !== false) return this.recordSent(job, p, known === true)
        await this.untrack(job, prevNonce)
        if (attempt > 0) throw new RelayError('INTERNAL', { reason: 'nonce_conflict' })
        const fresh = await this.client
          .getTransactionCount({ address: this.signer().address, blockTag: 'pending' })
          .catch(() => undefined)
        if (fresh === undefined) throw new RelayError('RPC_UNAVAILABLE')
        quote = await this.quote(router, data)
        nonce = Math.max(fresh, quote.pending ?? 0, nonce + 1)
        continue
      }
      await this.untrack(job, prevNonce)
      throw outcome === 'no_funds'
        ? new RelayError('RELAYER_LOW_GAS')
        : new RelayError('INTERNAL', { reason: 'send_rejected' })
    }
  }

  /** Persists the job and the next nonce, and makes sure an alarm will follow it up, before anything is sent. */
  private async track(job: Inflight, nextNonce: number) {
    this.inflight.set(job.jobId, job)
    this.nextNonce = nextNonce
    await this.ctx.storage.put({ [`job:${job.jobId}`]: job, nextNonce })
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + GAS_POLICY.pollMs)
  }

  private async untrack(job: Inflight, prevNonce: number | undefined) {
    this.inflight.delete(job.jobId)
    this.nextNonce = prevNonce
    await this.ctx.storage.delete(`job:${job.jobId}`)
    if (prevNonce === undefined) await this.ctx.storage.delete('nextNonce')
    else await this.ctx.storage.put('nextNonce', prevNonce)
  }

  private async recordSent(job: Inflight, p: ParsedRelay, accepted: boolean): Promise<RelayResponse> {
    job.accepted = accepted
    await this.ctx.storage.put(`job:${job.jobId}`, job)
    const status: JobStatus = accepted ? 'submitted' : 'queued'
    const txHash = job.hashes[0]!
    try {
      await upsertJob(this.env.DB, job.jobId, p, job.createdAt, status, txHash, null, null)
    } catch (e) {
      // The tx is tracked in storage; the alarm writes the row again when it settles.
      console.error('relay_jobs write failed', e instanceof Error ? e.message.slice(0, 200) : String(e))
    }
    return { status: 202, body: { jobId: job.jobId, status, txHash } }
  }

  /** true / false when a node answered for the hash, 'unknown' when none could be asked. */
  private async txKnown(hash: Hex): Promise<boolean | 'unknown'> {
    try {
      return !!(await this.client.request({ method: 'eth_getTransactionByHash', params: [hash] }))
    } catch {
      return 'unknown'
    }
  }

  private sign(tx: { to: Address; data?: Hex; gas: bigint; nonce: number; fees: Fees }): Promise<Hex> {
    return this.signer().signTransaction({
      type: 'eip1559',
      chainId: POLYGON.chainId,
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: tx.gas,
      nonce: tx.nonce,
      maxFeePerGas: tx.fees.maxFeePerGas,
      maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
    })
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

    const fresh = now - j.lastSentAt < GAS_POLICY.replaceAfterMs
    // The deadline does not wait out the freshness window: a pending router call is replaced before its permit
    // expires, or a bump sent just before could still be mined after it and revert.
    const expiring =
      !j.cancelReason && Math.floor(now / 1000) >= Number(j.deadline) - GAS_POLICY.deadlineMarginSec
    if (j.accepted && fresh && !expiring) return

    const used = await this.client.getTransactionCount({ address: this.signer().address, blockTag: 'latest' })
    if (used > j.nonce) return this.nonceUsedWithoutReceipt(j)
    j.consumedPolls = 0

    if (j.cancelReason) return fresh ? this.rebroadcast(j) : this.replace(j)

    // The router call is only sent again while it can still succeed.
    if (expiring) return this.replace(j, 'deadline')
    const revert = await simulate(this.client, this.signer().address, routerAddress(this.env)!, j.data)
    if (revert) return this.replace(j, 'would_revert', revert.reason)
    if (fresh) return this.rebroadcast(j)
    return this.replace(j, j.bumps < GAS_POLICY.maxBumps ? undefined : 'stuck')
  }

  /**
   * Signs the next tx for `j.nonce` with fees +25 %: the router call again while `cancel` is undefined and the job
   * is not cancelled, otherwise a 0-value self-transfer. The new hash is saved before it is broadcast.
   */
  private async replace(j: Inflight, cancel?: CancelReason, revertReason?: string) {
    const isCancel = !!cancel || !!j.cancelReason
    if (j.cancelReason && j.cancelBumps >= GAS_POLICY.maxBumps) return this.rebroadcast(j)
    const fees = bumpedFees(
      { maxFeePerGas: BigInt(j.maxFeePerGas), maxPriorityFeePerGas: BigInt(j.maxPriorityFeePerGas) },
      await this.nextBaseFee(),
    )
    const gas = isCancel ? GAS_POLICY.cancelGas : BigInt(j.gas)
    const raw = await this.sign(
      isCancel
        ? { to: this.signer().address, gas, nonce: j.nonce, fees }
        : { to: routerAddress(this.env)!, data: j.data, gas, nonce: j.nonce, fees },
    )
    const hash = keccak256(raw)

    if (!isCancel) j.bumps += 1
    else if (j.cancelReason) j.cancelBumps += 1
    else Object.assign(j, { cancelReason: cancel, cancelRevert: revertReason })
    Object.assign(j, {
      raw,
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      hashes: [...j.hashes, hash],
      cancelHashes: isCancel ? [...j.cancelHashes, hash] : j.cancelHashes,
      accepted: false,
      lastSentAt: Date.now(),
    })
    await this.ctx.storage.put(`job:${j.jobId}`, j)

    j.accepted = (await broadcast(polygonUrls(this.env), raw)) === 'accepted'
    await this.ctx.storage.put(`job:${j.jobId}`, j)
    console.log(
      JSON.stringify({
        evt: isCancel ? 'cancel' : 'bump',
        jobId: j.jobId,
        reason: j.cancelReason,
        bumps: j.bumps,
        tip: j.maxPriorityFeePerGas,
      }),
    )
  }

  /** Re-sends the current raw tx (same hash) to nodes that may not have it. */
  private async rebroadcast(j: Inflight) {
    if ((await broadcast(polygonUrls(this.env), j.raw)) !== 'accepted' || j.accepted) return
    j.accepted = true
    await this.ctx.storage.put(`job:${j.jobId}`, j)
    if (!j.cancelReason)
      await upsertJob(this.env.DB, j.jobId, asParsed(j), j.createdAt, 'submitted', j.hashes[0]!, null, null).catch(
        () => undefined,
      )
  }

  /** Our nonce is used but no receipt shows for any of our hashes: a lagging node, or a tx we do not track. */
  private async nonceUsedWithoutReceipt(j: Inflight) {
    j.consumedPolls += 1
    await this.ctx.storage.put(`job:${j.jobId}`, j)
    if (j.consumedPolls < GAS_POLICY.droppedPolls) return
    const landed = await findLanded(this.client, routerAddress(this.env)!, asParsed(j))
    if (landed && landed !== 'unknown')
      return this.finish(j, 'confirmed', landed, null, j.hashes.includes(landed) ? null : { reason: 'already_landed' })
    if (landed === 'unknown' && j.consumedPolls < GAS_POLICY.droppedPolls * 4) return
    return this.finish(j, 'failed', j.hashes[j.hashes.length - 1]!, 'RPC_UNAVAILABLE', {
      reason: 'dropped',
      ...(landed === 'unknown' ? { landedCheck: 'unavailable' } : {}),
    })
  }

  private async settle(j: Inflight, rc: RpcReceipt) {
    await this.addSpent(hexToBigInt(rc.gasUsed) * hexToBigInt(rc.effectiveGasPrice))
    this.balance = undefined
    const cancelled = j.cancelHashes.includes(rc.transactionHash)
    if (!cancelled && rc.status === '0x1') {
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
    // Our cancel or a reverted router call was mined; someone else may still have relayed the same signature.
    const landed = await findLanded(this.client, routerAddress(this.env)!, asParsed(j))
    if (landed && landed !== 'unknown') return this.finish(j, 'confirmed', landed, null, { reason: 'already_landed' })
    const [code, detail]: [RelayErrorCode, Detail] =
      cancelled && j.cancelReason
        ? CANCEL_OUTCOME[j.cancelReason](j)
        : ['SIMULATION_FAILED', { reason: 'reverted_onchain' }]
    return this.finish(j, 'failed', rc.transactionHash, code, {
      ...detail,
      ...(landed === 'unknown' ? { landedCheck: 'unavailable' } : {}),
    })
  }

  private async finish(j: Inflight, status: JobStatus, txHash: Hex, error: RelayErrorCode | null, detail: Detail | null) {
    await upsertJob(this.env.DB, j.jobId, asParsed(j), j.createdAt, status, txHash, error, detail)
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
