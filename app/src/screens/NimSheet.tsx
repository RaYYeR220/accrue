import { LUNA_PER_NIM, normalizeAddress, STAKING_CONTRACT } from '@accrue/shared'
import { useMemo, useState, type ReactNode } from 'react'
import type { PoolRow } from '../features/nim/api'
import { toNimUiError, type NimUiError } from '../features/nim/errors'
import type { TxOutcome } from '../features/nim/useNim'
import { t } from '../i18n'
import { nimTxUrl, type NimKind } from '../model/activity'
import { parseAmount } from '../model/amount'
import { rankPools } from '../model/pools'
import { Button, Chip, Sheet } from '../ui/components'
import { AmountField, ExtLink, Facts, Notice, Spinner, Steps, type StepItem } from '../ui/components/Fields'
import { useApp } from './context'
import { about, commaDecimal, nimAmount } from './format'
import { payoutLine, PoolPicker, stakedTotal, unstakeItems } from './nimParts'
import { useNow } from './live'

export type NimMode = 'stake' | 'add' | 'unstake' | 'switch' | 'retire' | 'remove'

export interface NimSpec {
  mode: NimMode
  amount?: bigint
  pool?: string
}

const plainNim = (luna: bigint) => `${luna / LUNA_PER_NIM}.${(luna % LUNA_PER_NIM).toString().padStart(5, '0')}`.replace(/\.?0+$/, '')

const same = (a: string, b: string) => normalizeAddress(a) === normalizeAddress(b)

type Phase = { s: 'form' } | { s: 'busy' } | { s: 'done'; out: TxOutcome; kind: NimKind; luna: bigint } | { s: 'error'; error: NimUiError }

function errorText(e: NimUiError): string {
  return t(e.messageKey, (e.detail as Record<string, string> | undefined) ?? {})
}

export function NimSheet({ spec, onClose }: { spec: NimSpec; onClose: () => void }) {
  const app = useApp()
  const { nim } = app
  useNow(30_000)
  const staker = nim.staker ?? null
  const [text, setText] = useState(spec.amount ? plainNim(spec.amount) : '')
  const [all, setAll] = useState(false)
  const [pool, setPool] = useState<string | null>(spec.pool ?? null)
  const [phase, setPhase] = useState<Phase>({ s: 'form' })
  const ranked = useMemo(() => rankPools(nim.pools?.pools ?? []), [nim.pools])
  const chosen: PoolRow | undefined = pool ? ranked.find(p => same(p.address, pool)) : undefined
  const current = nim.myPool

  const mode = spec.mode
  const parsed = parseAmount(text, 5, { comma: commaDecimal() })
  const total = staker ? stakedTotal(staker) : 0n
  const amount: bigint | null =
    mode === 'unstake' ? (all ? total : parsed.ok ? parsed.units : null) : mode === 'retire' ? (staker?.inactiveLuna ?? null) : mode === 'remove' ? (staker?.retiredLuna ?? null) : parsed.ok ? parsed.units : null

  // Every protocol rule is checked here, before Nimiq Pay is asked anything.
  let refusal: string | null = null
  if (!parsed.ok && parsed.error !== 'EMPTY' && (mode === 'stake' || mode === 'add' || (mode === 'unstake' && !all))) {
    refusal = parsed.error === 'TOO_PRECISE' ? t('amount.precise', { n: 5 }) : commaDecimal() ? t('amount.formatComma') : t('amount.format')
  } else if ((mode === 'stake' || mode === 'add') && amount !== null) {
    const plan = nim.planStake(amount)
    if (plan && 'error' in plan) {
      refusal = t(`nim.error.${plan.error}`, plan.error === 'FUNDS_SPLIT' ? { amount: nimAmount(plan.available, false) } : {})
    }
  }
  let unstakeSteps: StepItem[] | null = null
  if (mode === 'unstake' && amount !== null && refusal === null) {
    const plan = nim.planUnstake(amount)
    if (plan?.check === 'LEAVES_DUST' || plan?.check === 'INVALID_AMOUNT') refusal = t(`nim.error.${plan.check}`)
    else if (plan) unstakeSteps = unstakeItems(plan.steps, amount)
  }
  const switchPlan = mode === 'switch' ? nim.planSwitch() : null

  const busy = phase.s === 'busy'
  async function go(kind: NimKind, luna: bigint, run: () => Promise<TxOutcome | null>, poolName?: string) {
    setPhase({ s: 'busy' })
    try {
      const out = await app.nimAction(kind, luna, run, poolName)
      setPhase(out ? { s: 'done', out, kind, luna } : { s: 'form' })
    } catch (e) {
      setPhase({ s: 'error', error: toNimUiError(e) })
    }
  }

  const title = t(`stake.title.${mode}`)
  let form: ReactNode = null
  let facts: { k: string; v: ReactNode }[] = []
  let action: ReactNode = null

  const amountField = (label: string, max: bigint | undefined, withAll: boolean) => (
    <AmountField
      id="nim-amount"
      label={label}
      unit="NIM"
      value={all ? plainNim(total) : text}
      disabled={all || busy}
      onChange={setText}
      error={refusal}
      hint={max !== undefined ? t('stake.available', { amount: nimAmount(max) }) : undefined}
      quick={
        withAll ? (
          <Chip pressed={all} onClick={() => setAll(a => !a)}>
            {t('amount.all')}
          </Chip>
        ) : max !== undefined && max > 0n ? (
          <Chip onClick={() => setText(plainNim(max))}>{t('amount.max')}</Chip>
        ) : null
      }
    />
  )

  const contract = `${STAKING_CONTRACT.slice(0, 9)} … ${STAKING_CONTRACT.slice(-4)}`
  const toFact = { k: t('sheet.k.to'), v: t('stake.to', { contract }) }
  const feeFact = { k: t('stake.k.fee'), v: t('stake.fee') }

  switch (mode) {
    case 'stake': {
      form = (
        <>
          <PoolPicker pools={ranked} value={pool} onChange={setPool} name="pool" />
          {amountField(t('stake.amount'), nim.stakeable, false)}
        </>
      )
      const ok = amount !== null && amount > 0n && refusal === null && chosen
      facts = [
        { k: t('sheet.k.sign'), v: t('stake.sign.stake', { amount: amount ? nimAmount(amount) : '—', pool: chosen?.name ?? '—' }) },
        toFact,
        { k: t('sheet.k.next'), v: chosen ? t('stake.next.stake', { pool: chosen.name, payouts: payoutLine(chosen) }) : t('pool.pickFirst') },
        feeFact,
      ]
      action = (
        <Button block disabled={!ok || busy} onClick={() => ok && go('stake', amount, () => nim.stake(amount, chosen.address), chosen.name)}>
          {busy && <Spinner />}
          {amount && amount > 0n ? t('stake.do.stake', { amount: nimAmount(amount) }) : t('stake.title.stake')}
        </Button>
      )
      break
    }
    case 'add': {
      form = amountField(t('stake.amount'), nim.stakeable, false)
      const ok = amount !== null && amount > 0n && refusal === null
      facts = [
        { k: t('sheet.k.sign'), v: t('stake.sign.add', { amount: amount ? nimAmount(amount) : '—', pool: current?.name ?? '—' }) },
        toFact,
        { k: t('sheet.k.next'), v: current ? t('stake.next.stake', { pool: current.name, payouts: payoutLine(current) }) : '—' },
        feeFact,
      ]
      action = (
        <Button block disabled={!ok || busy} onClick={() => ok && go('add', amount, () => nim.stake(amount))}>
          {busy && <Spinner />}
          {amount && amount > 0n ? t('stake.do.add', { amount: nimAmount(amount) }) : t('stake.title.add')}
        </Button>
      )
      break
    }
    case 'unstake': {
      form = (
        <>
          {amountField(t('stake.unstakeAmount'), undefined, true)}
          {unstakeSteps && <Steps label={t('stake.stepsLabel')} items={unstakeSteps} />}
          {staker && staker.inactiveLuna > 0n && amount !== null && amount - staker.retiredLuna > staker.inactiveLuna && <Notice>{t('nim.wait.resetsTimer')}</Notice>}
          <p className="sheet-note">{t('nim.wait.noRewards')}</p>
        </>
      )
      const ok = amount !== null && amount > 0n && refusal === null && unstakeSteps !== null
      facts = [
        { k: t('sheet.k.sign'), v: t('stake.sign.deactivate', { amount: amount ? nimAmount(amount) : '—' }) },
        toFact,
        { k: t('sheet.k.next'), v: t('stake.next.deactivate') },
        feeFact,
      ]
      // once this amount has stopped earning, the next steps live on the NIM screen
      const stepOne = unstakeSteps === null || unstakeSteps[0]!.state === 'now'
      action =
        stepOne ? (
          <Button block disabled={!ok || busy} onClick={() => ok && go('deactivate', amount, () => nim.deactivate(amount))}>
            {busy && <Spinner />}
            {amount && amount > 0n ? t('stake.do.deactivate', { amount: nimAmount(amount) }) : t('stake.title.unstake')}
          </Button>
        ) : (
          <Notice>{t('stake.alreadyStopped')}</Notice>
        )
      break
    }
    case 'switch': {
      const steps: StepItem[] | null =
        switchPlan?.kind === 'deactivate-first'
          ? [
              { title: t('stake.sw.stop', { amount: nimAmount(staker?.activeLuna ?? 0n) }), state: switchPlan.steps[0]!.done ? 'done' : 'now' },
              {
                title: t('nim.step.wait'),
                sub: switchPlan.steps[1]!.done ? t('nim.step.readyNow') : t('stake.readyIn', { time: about(switchPlan.steps[1]!.etaMs ?? 0) }),
                state: switchPlan.steps[1]!.done ? 'done' : switchPlan.steps[0]!.done ? 'wait' : 'later',
              },
              { title: t('stake.sw.move', { pool: chosen?.name ?? t('stake.sw.newPool') }), state: 'later' },
            ]
          : null
      // the plan comes first: it is the same for every pool, and the list below can be long
      form = (
        <>
          {switchPlan && (
            <div className="plan" aria-live="polite">
              <p className="field-label">{t('stake.sw.plan')}</p>
              {steps ? <Steps label={t('stake.sw.plan')} items={steps} /> : <p>{t('nim.switch.direct', { pool: chosen?.name ?? t('stake.sw.newPool') })}</p>}
              {steps && <p className="sheet-note">{t('nim.switch.deactivateFirst')}</p>}
            </div>
          )}
          <PoolPicker pools={ranked} value={pool} onChange={setPool} exclude={current?.address ?? null} name="switch" />
        </>
      )
      const direct = switchPlan?.kind === 'direct'
      const stopNow = switchPlan?.kind === 'deactivate-first' && !switchPlan.steps[0]!.done
      facts = [
        { k: t('sheet.k.sign'), v: direct ? t('stake.sign.switch', { pool: chosen?.name ?? '—' }) : t('stake.sign.deactivate', { amount: nimAmount(staker?.activeLuna ?? 0n) }) },
        toFact,
        { k: t('sheet.k.next'), v: direct ? t('stake.next.switch', { pool: chosen?.name ?? '—' }) : t('stake.next.deactivate') },
        feeFact,
      ]
      action = direct ? (
        <Button block disabled={!chosen || busy} onClick={() => chosen && go('switch', 0n, () => nim.switchPool(chosen.address), chosen.name)}>
          {busy && <Spinner />}
          {t('stake.do.switch', { pool: chosen?.name ?? '…' })}
        </Button>
      ) : stopNow ? (
        <Button block disabled={!chosen || busy} onClick={() => go('deactivate', staker?.activeLuna ?? 0n, () => nim.deactivateAll())}>
          {busy && <Spinner />}
          {t('stake.sw.stopDo', { amount: nimAmount(staker?.activeLuna ?? 0n) })}
        </Button>
      ) : (
        <Notice>{t('stake.sw.waiting')}</Notice>
      )
      break
    }
    case 'retire':
    case 'remove': {
      const luna = amount ?? 0n
      facts = [
        { k: t('sheet.k.sign'), v: t(mode === 'retire' ? 'stake.sign.retire' : 'stake.sign.remove', { amount: nimAmount(luna) }) },
        toFact,
        { k: t('sheet.k.next'), v: t(mode === 'retire' ? 'stake.next.retire' : 'stake.next.remove') },
        feeFact,
      ]
      action = (
        <Button block disabled={luna === 0n || busy} onClick={() => go(mode, luna, () => (mode === 'retire' ? nim.retire(luna + (staker?.retiredLuna ?? 0n)) : nim.remove()))}>
          {busy && <Spinner />}
          {t(mode === 'retire' ? 'stake.do.retire' : 'stake.do.remove', { amount: nimAmount(luna) })}
        </Button>
      )
      break
    }
  }

  let body: ReactNode
  if (phase.s === 'done') {
    const pending = phase.out.status === 'pending'
    body = (
      <div className="status status-ok" role="status">
        <span className="status-ico" aria-hidden="true">
          {pending ? <Spinner /> : '✓'}
        </span>
        <div className="status-body">
          <p className="status-title">{pending ? t('nim.tx.pending') : t(`stake.done.${phase.kind}`, { amount: nimAmount(phase.luna) })}</p>
          <ExtLink href={nimTxUrl(phase.out.hash, app.network)}>{t('common.viewNimiq')}</ExtLink>
        </div>
      </div>
    )
  } else {
    body = (
      <>
        {form}
        {busy && (nim.confirming ? <Notice live>{t('nim.tx.confirming')}</Notice> : <Notice live>{t('stake.inWallet')}</Notice>)}
        {phase.s === 'error' && (
          <p className="err" role="alert">
            {errorText(phase.error)}
          </p>
        )}
        <Facts className="sign-facts" rows={facts} />
      </>
    )
  }

  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="sheet-state">{body}</div>
      <div className="sheet-actions">
        {phase.s === 'done' ? (
          <Button block onClick={onClose}>
            {t('action.done')}
          </Button>
        ) : (
          <>
            {action}
            <Button variant="quiet" block onClick={onClose}>
              {t('action.close')}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  )
}
