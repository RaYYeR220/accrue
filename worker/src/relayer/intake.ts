import { isAddress, isAddressEqual, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem'
import { buildPermit } from '@accrue/shared'
import type { Env } from '../env'
import { polygonClient } from '../rpc/polygon'
import { judgeState, readOwnerState, routerAddress, routerCalldata, simulate, type Verdict } from './chain'
import { RelayError, toResponse, type RelayResponse } from './errors'
import { jobView, toSubmit, upsertJob, type JobRow } from './jobs'
import { jobIdOf, rateLimit, validateStatic, type ParsedRelay, type RelayRequest } from './validate'
import './warm'

const DAY_MS = 86_400_000

/**
 * POST /api/relay, Worker side. Everything that needs no relayer state runs here, in the stateless request
 * (static checks, signer recovery, owner reads, the router simulation), so junk and doomed requests never queue
 * behind the Durable Object's lock and the DO invocation stays small. Only a relay that would succeed reaches it.
 */
export async function intake(env: Env, body: unknown): Promise<RelayResponse> {
  try {
    return await run(env, body)
  } catch (e) {
    return toResponse(e, 'intake')
  }
}

async function run(env: Env, body: unknown): Promise<RelayResponse> {
  const now = Date.now()
  const v = validateStatic(body as RelayRequest, now)
  if (!v.ok) throw new RelayError(v.error, v.detail, v.status)
  const p = v.parsed
  const router = routerAddress(env)
  if (!router) throw new RelayError('INTERNAL', { reason: 'router_not_configured' })
  const jobId = jobIdOf(p.signature)

  // Early copy of the DO's checks: a known job is answered without recovery or RPC, and an owner over the rate
  // limit costs one D1 read. The DO repeats both authoritatively.
  let row: JobRow | undefined
  let count = 0
  try {
    const [existing, recent] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?1').bind(jobId),
      env.DB.prepare('SELECT COUNT(*) AS n FROM relay_jobs WHERE owner = ?1 AND created_at > ?2').bind(
        p.owner.toLowerCase(),
        now - DAY_MS,
      ),
    ])
    row = existing?.results[0] as JobRow | undefined
    count = Number((recent?.results[0] as { n?: number } | undefined)?.n ?? 0)
  } catch {
    throw new RelayError('INTERNAL', { reason: 'db_error' })
  }
  if (row) return { status: 202, body: jobView(row) }
  const limited = rateLimit(count)
  if (limited) throw new RelayError(limited.error, limited.detail)

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

  const client = polygonClient(env)
  const conclude = async (verdict: Verdict): Promise<RelayResponse | null> => {
    if (!verdict) return null
    if ('error' in verdict) throw verdict.error
    await recordLanded(env, jobId, p, now, verdict.landed)
    return { status: 202, body: { jobId, status: 'confirmed', txHash: verdict.landed } }
  }

  const early = await conclude(await judgeState(client, router, p, await readOwnerState(client, p)))
  if (early) return early

  const from: Address = isAddress(env.RELAYER_ADDRESS?.trim() ?? '') ? (env.RELAYER_ADDRESS.trim() as Address) : zeroAddress
  const revert = await simulate(client, from, router, routerCalldata(p))
  if (revert) {
    // Re-read: the revert may come from state that changed since the first read (e.g. a replayed permit).
    const late = await conclude(await judgeState(client, router, p, await readOwnerState(client, p)))
    if (late) return late
    if (p.kind === 'withdraw' && revert.name === 'NothingToWithdraw')
      throw new RelayError('BAD_SIGNATURE', { reason: 'permit_rejected' })
    throw new RelayError('SIMULATION_FAILED', { reason: revert.reason })
  }

  let res: { status: number; json: string }
  try {
    res = await env.RELAYER.get(env.RELAYER.idFromName('relayer')).submit(toSubmit(jobId, p))
  } catch (e) {
    // The DO is reset on every deploy and can be briefly unreachable; the client may retry the same signature.
    console.error('relayer DO call failed', e instanceof Error ? e.message.slice(0, 200) : String(e))
    throw new RelayError('RPC_UNAVAILABLE', { reason: 'relayer_unavailable' })
  }
  return { status: res.status, body: JSON.parse(res.json) as Record<string, unknown> }
}

async function recordLanded(env: Env, jobId: Hex, p: ParsedRelay, now: number, txHash: Hex) {
  try {
    await upsertJob(env.DB, jobId, p, now, 'confirmed', txHash, null, { reason: 'already_landed' })
  } catch {
    throw new RelayError('INTERNAL', { reason: 'db_error' })
  }
}
