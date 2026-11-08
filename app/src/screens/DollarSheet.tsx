import { LIMITS, type AssetKey } from '@accrue/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import type { Draft } from '../actions/machine'
import { flowConfig } from '../features/dollars/flow'
import { useDollarAction } from '../features/dollars/useDollarAction'
import { t } from '../i18n'
import { polygonTxUrl } from '../model/activity'
import { checkDeposit, checkWithdraw, maxDeposit, parseAmount, type LimitCheck } from '../model/amount'
import type { UiError } from '../providers/errors'
import { Button, Chip, Sheet } from '../ui/components'
import { AmountField, ExtLink, Facts, Notice, Spinner, Steps } from '../ui/components/Fields'
import { useApp } from './context'
import { commaDecimal, num, short, SYMBOL, tokens } from './format'

export interface SheetSpec {
  kind: 'supply' | 'withdraw'
  asset: AssetKey
  // follow a job that is already on its way instead of starting one
  attach?: string
}

const plain = (units: bigint) => {
  const s = `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
  return s.replace(/\.?0+$/, '')
}

const pol = (wei: bigint) => num(Number(wei) / 1e18, 2, 4)

function limitMessage(c: LimitCheck, kind: SheetSpec['kind'], asset: AssetKey): string | null {
  if (c.ok) return null
  const amount = tokens(c.limit, asset)
  switch (c.reason) {
    case 'MIN':
      return t('amount.min', { min: amount })
    case 'MAX':
      return t('amount.tooMuch', { max: amount })
    case 'ZERO':
      return t('amount.zero')
    case 'BALANCE':
      return kind === 'supply' ? t('amount.balance', { balance: amount }) : t('amount.position', { balance: amount })
  }
}

const draftAmount = (d: Draft): bigint | 'all' => d.amount

function errorText(e: UiError, asset: AssetKey): string {
  const d = e.detail ?? {}
  const vars: Record<string, string> = {}
  for (const k of ['balance', 'available', 'min', 'max'] as const) {
    const v = d[k]
    if (typeof v === 'string' && /^\d+$/.test(v)) vars[k] = tokens(BigInt(v), asset)
  }
  return t(e.messageKey, vars)
}

function WhatYouSign({ draft }: { draft: Draft }) {
  const router = flowConfig.router
  const sym = SYMBOL[draft.asset]
  const amount = draftAmount(draft)
  const amountText = amount === 'all' ? t('sheet.everything', { token: sym }) : tokens(amount, draft.asset)
  const supply = draft.kind === 'supply'
  return (
    <>
      <Facts
        className="sign-facts"
        rows={[
          { key: 'sign', k: t('sheet.k.sign'), v: supply ? t('sheet.sign.supply', { amount: amountText, minutes: flowConfig.deadlineSec / 60 }) : t('sheet.sign.withdraw', { amount: amountText, token: sym, minutes: flowConfig.deadlineSec / 60 }) },
          {
            key: 'to',
            k: t('sheet.k.to'),
            v: router ? (
              <>
                {t('sheet.to', { address: short(router) })} <ExtLink href={`https://polygonscan.com/address/${router}#code`}>{t('common.polygonscan')}</ExtLink>
              </>
            ) : (
              t('dollars.error.notDeployed')
            ),
          },
          { key: 'next', k: t('sheet.k.next'), v: supply ? t('sheet.next.supply', { token: sym }) : t('sheet.next.withdraw') },
          { key: 'gas', k: t('sheet.k.gas'), v: t('sheet.gas') },
        ]}
      />
      {supply && draft.asset === 'USDT0' && <Notice tone="accent">{t('sheet.usdt0Chain')}</Notice>}
    </>
  )
}

function Status({ icon, title, children, live = true }: { icon: 'spin' | 'ok' | 'no' | 'wait'; title: string; children?: ReactNode; live?: boolean }) {
  return (
    <div className={`status status-${icon}`} role={live ? 'status' : undefined}>
      <span className="status-ico" aria-hidden="true">
        {icon === 'spin' ? <Spinner /> : icon === 'ok' ? '✓' : icon === 'no' ? '×' : '…'}
      </span>
      <div className="status-body">
        <p className="status-title">{title}</p>
        {children}
      </div>
    </div>
  )
}

export function DollarSheet({ spec, onClose }: { spec: SheetSpec; onClose: () => void }) {
  const app = useApp()
  const { kind, asset } = spec
  const { state, dispatch, switchChain, attach } = useDollarAction()
  const [text, setText] = useState('')
  const [all, setAll] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [note, setNote] = useState<UiError | null>(null)
  const [connecting, setConnecting] = useState(false)
  const sym = SYMBOL[asset]

  useEffect(() => {
    if (spec.attach) attach(spec.attach)
  }, [spec.attach, attach])

  // the wallet side moved too, not only the Aave position
  const qc = useQueryClient()
  useEffect(() => {
    if (state.s === 'confirmed') void qc.invalidateQueries({ queryKey: ['wallet'] })
  }, [state.s, qc])

  const balance = kind === 'supply' ? app.wallet.data?.[asset] : app.position.data?.assets[asset].aTokenBalance
  const parsed = parseAmount(text, 6, { comma: commaDecimal() })
  const limit = parsed.ok ? (kind === 'supply' ? checkDeposit(parsed.units, balance) : checkWithdraw(parsed.units, balance ?? 0n)) : null
  const fieldError = !parsed.ok
    ? parsed.error === 'EMPTY'
      ? null
      : parsed.error === 'TOO_PRECISE'
        ? t('amount.precise', { n: 6 })
        : commaDecimal()
          ? t('amount.formatComma')
          : t('amount.format')
    : limitMessage(limit!, kind, asset)
  const ready = all ? (balance ?? 0n) > 0n : parsed.ok && limit!.ok
  const draft: Draft | null = !ready ? null : kind === 'supply' ? { kind, asset, amount: parsed.ok ? parsed.units : 0n } : { kind, asset, amount: all ? 'all' : parsed.ok ? parsed.units : 0n }

  const title = t(kind === 'supply' ? 'sheet.title.supply' : 'sheet.title.withdraw', { token: sym })

  async function connect() {
    setConnecting(true)
    setNote(await app.connectEvm())
    setConnecting(false)
  }

  async function doSwitch() {
    setSwitching(true)
    setNote(await switchChain())
    setSwitching(false)
  }

  let body: ReactNode
  let actions: ReactNode

  const close = (
    <Button variant="quiet" block onClick={onClose}>
      {t('action.close')}
    </Button>
  )

  switch (state.s) {
    case 'idle': {
      const hint =
        balance === undefined
          ? t('status.loading')
          : kind === 'supply'
            ? t('amount.hintSupply', { balance: tokens(balance, asset), min: tokens(LIMITS.minDepositUnits), max: tokens(LIMITS.maxTxUnits) })
            : t('amount.hintWithdraw', { balance: tokens(balance, asset) })
      body = (
        <>
          <AmountField
            id="amount"
            label={t(kind === 'supply' ? 'amount.labelSupply' : 'amount.labelWithdraw')}
            unit={sym}
            value={all ? plain(balance ?? 0n) : text}
            disabled={all}
            onChange={v => setText(v)}
            hint={all ? t('amount.allNote') : hint}
            error={all ? null : fieldError}
            quick={
              kind === 'supply' ? (
                <Chip disabled={!balance} onClick={() => balance !== undefined && setText(plain(maxDeposit(balance)))}>
                  {t('amount.max')}
                </Chip>
              ) : (
                <Chip pressed={all} disabled={!balance} onClick={() => setAll(a => !a)}>
                  {t('amount.all')}
                </Chip>
              )
            }
          />
          <p className="sheet-note">{t(kind === 'supply' ? 'sheet.intro.supply' : 'sheet.intro.withdraw')}</p>
        </>
      )
      actions = (
        <>
          {!app.evmLive ? (
            <Button block onClick={connect} disabled={connecting}>
              {connecting && <Spinner />}
              {t('connect.evm')}
            </Button>
          ) : (
            <Button block disabled={!draft} onClick={() => draft && dispatch({ type: 'DRAFT', draft })}>
              {t('sheet.review')}
            </Button>
          )}
          {close}
        </>
      )
      break
    }
    case 'confirm': {
      const switchStep = state.chain === 'switch'
      body = (
        <>
          {switchStep && (
            <Steps
              label={t('sheet.stepsLabel')}
              items={[
                { title: t('sheet.step.switch'), sub: t('sheet.step.switchSub'), state: 'now' },
                { title: t('sheet.step.sign'), state: 'later' },
              ]}
            />
          )}
          <WhatYouSign draft={state.draft} />
        </>
      )
      actions = (
        <>
          {switchStep ? (
            <Button block onClick={doSwitch} disabled={switching}>
              {switching && <Spinner />}
              {t('action.switchToPolygon')}
            </Button>
          ) : (
            <Button block disabled={!flowConfig.router} onClick={() => dispatch({ type: 'SUBMIT' })}>
              {t(state.draft.kind === 'supply' ? 'sheet.signSupply' : 'sheet.signWithdraw')}
            </Button>
          )}
          <Button variant="quiet" block onClick={() => dispatch({ type: 'RESET' })}>
            {t('sheet.edit')}
          </Button>
        </>
      )
      break
    }
    case 'signing':
      body = (
        <>
          <Status icon="spin" title={state.jobId ? t('sheet.st.sending') : t('sheet.st.signing')}>
            <p>{state.jobId ? t('sheet.st.sendingSub') : t('sheet.st.signingSub')}</p>
          </Status>
          <WhatYouSign draft={state.draft} />
        </>
      )
      actions = close
      break
    case 'submitted':
      body = (
        <Status icon="spin" title={state.txHash ? t('sheet.st.submitted') : t('sheet.st.queued')}>
          <p>{t('sheet.st.submittedSub')}</p>
          {state.txHash && <ExtLink href={polygonTxUrl(state.txHash)}>{t('common.viewPolygonscan')}</ExtLink>}
        </Status>
      )
      actions = close
      break
    case 'unknown':
      body = (
        <Status icon="spin" title={t('sheet.st.checking')}>
          <p>{t('sheet.st.checkingSub')}</p>
          {state.offer?.kind === 'selfGas' && <p className="muted">{t('sheet.st.relayerDown')}</p>}
        </Status>
      )
      actions = (
        <>
          {state.offer?.kind === 'selfGas' && (
            <Button block variant="ghost" onClick={() => dispatch({ type: 'SELF_GAS' })}>
              {t('sheet.selfGas', { fee: pol(state.offer.estimateWei) })}
            </Button>
          )}
          {close}
        </>
      )
      break
    case 'confirmed': {
      const d = state.draft
      const amount = d ? draftAmount(d) : null
      const amountText = amount === null ? '' : amount === 'all' ? t('sheet.everything', { token: sym }) : tokens(amount, asset)
      const supply = (d?.kind ?? kind) === 'supply'
      body = (
        <Status icon="ok" title={supply ? t('sheet.st.earning') : t('sheet.st.back')}>
          <p>{state.elsewhere ? t('sheet.st.elsewhere') : supply ? t('sheet.st.earningSub', { amount: amountText }) : t('sheet.st.backSub', { amount: amountText })}</p>
          {state.txHash && <ExtLink href={polygonTxUrl(state.txHash)}>{t('common.viewPolygonscan')}</ExtLink>}
        </Status>
      )
      actions = (
        <Button block onClick={onClose}>
          {t('action.done')}
        </Button>
      )
      break
    }
    case 'cancelled':
      body = (
        <Status icon="no" title={t('sheet.st.cancelled')}>
          <p>{t('sheet.st.cancelledSub')}</p>
        </Status>
      )
      actions = (
        <>
          {state.draft && (
            <Button block onClick={() => dispatch({ type: 'DRAFT', draft: state.draft! })}>
              {t('action.retry')}
            </Button>
          )}
          {close}
        </>
      )
      break
    case 'failed': {
      const offer = state.offer
      const avail = offer?.kind === 'withdrawAvailable' ? offer.amount : null
      body = (
        <Status icon="no" title={t('sheet.st.failed')}>
          <p>{errorText(state.error, asset)}</p>
          {avail !== null && <p className="strong">{t('error.availableNow', { amount: tokens(avail, asset) })}</p>}
          {state.txHash && <ExtLink href={polygonTxUrl(state.txHash)}>{t('common.viewPolygonscan')}</ExtLink>}
        </Status>
      )
      actions = (
        <>
          {state.error.retry === 'resign' && state.draft && (
            <Button block onClick={() => dispatch({ type: 'RESIGN' })}>
              {t('action.signAgain')}
            </Button>
          )}
          {state.error.retry === 'same' && state.draft && (
            <Button block onClick={() => dispatch({ type: 'RETRY' })}>
              {t('action.retry')}
            </Button>
          )}
          {avail !== null && (
            <Button block onClick={() => dispatch({ type: 'DRAFT', draft: { kind: 'withdraw', asset, amount: avail } })}>
              {t('sheet.withdrawAvailable', { amount: tokens(avail, asset) })}
            </Button>
          )}
          {offer?.kind === 'selfGas' && (
            <Button block variant="ghost" onClick={() => dispatch({ type: 'SELF_GAS' })}>
              {t('sheet.selfGas', { fee: pol(offer.estimateWei) })}
            </Button>
          )}
          {state.error.retry === 'none' && (
            <Button block variant="ghost" onClick={() => dispatch({ type: 'RESET' })}>
              {t('sheet.edit')}
            </Button>
          )}
          {close}
        </>
      )
      break
    }
  }

  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="sheet-state" data-state={state.s}>
        {body}
        {note && (
          <p className="err" role="alert">
            {t(note.messageKey)}
          </p>
        )}
      </div>
      <div className="sheet-actions">{actions}</div>
    </Sheet>
  )
}
