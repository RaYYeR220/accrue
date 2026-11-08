import { normalizeAddress } from '@accrue/shared'
import { useEffect, useState } from 'react'
import { NOMINAL_WINDOW_DAYS } from '../features/nim/api'
import { t } from '../i18n'
import { clearSwitchTarget, loadSwitchTarget } from '../model/switchTarget'
import { Button, Card } from '../ui/components'
import { Notice, Steps } from '../ui/components/Fields'
import { useApp } from './context'
import { about, approx, daysText, nimAmount, nimExact } from './format'
import { useNow } from './live'
import { PoolFacts, unstakeItems } from './nimParts'
import { NimSheet, type NimSpec } from './NimSheet'
import { ConnectNim, ScreenHead, TestnetBadge } from './parts'

function Unstaking({ onOpen }: { onOpen: (s: NimSpec) => void }) {
  const { nim } = useApp()
  useNow(30_000)
  const s = nim.staker
  if (!s || s.inactiveLuna + s.retiredLuna === 0n) return null
  const amount = s.inactiveLuna + s.retiredLuna
  const plan = nim.planUnstake(amount)
  const items = plan ? unstakeItems(plan.steps, amount) : null
  const retireReady = plan ? plan.steps[1]!.done && !plan.steps[2]!.done : false
  return (
    <section className="block" aria-labelledby="unstaking-h">
      <h2 className="block-h" id="unstaking-h">
        {t('stake.unstaking', { amount: nimAmount(amount) })}
      </h2>
      <Card tone="quiet">
        {items && <Steps label={t('stake.stepsLabel')} items={items} />}
        <div className="row-actions">
          {retireReady && s.inactiveLuna > 0n && <Button onClick={() => onOpen({ mode: 'retire' })}>{t('stake.do.retire', { amount: nimExact(s.inactiveLuna) })}</Button>}
          {s.retiredLuna > 0n && <Button onClick={() => onOpen({ mode: 'remove' })}>{t('stake.do.remove', { amount: nimExact(s.retiredLuna) })}</Button>}
        </div>
        <p className="sheet-note">{t('nim.wait.noRewards')}</p>
      </Card>
    </section>
  )
}

// A switch in progress: the stake stopped earning so it can move; the move is one tap once released.
function Switching({ target, onOpen, onDrop }: { target: string; onOpen: (s: NimSpec) => void; onDrop: () => void }) {
  const { nim } = useApp()
  useNow(30_000)
  const s = nim.staker
  const plan = nim.planSwitch()
  if (!s || !plan) return null
  const name = nim.pools?.pools.find(p => normalizeAddress(p.address) === normalizeAddress(target))?.name ?? t('stake.sw.newPool')
  const ready = plan.kind === 'direct'
  const wait = plan.kind === 'deactivate-first' ? plan.steps[1]! : null
  return (
    <section className="block" aria-labelledby="switching-h">
      <h2 className="block-h" id="switching-h">
        {t('stake.sw.pending', { pool: name })}
      </h2>
      <Card tone="quiet">
        <Steps
          label={t('stake.sw.plan')}
          items={[
            { title: t('stake.sw.stop', { amount: nimExact(s.inactiveLuna) }), state: 'done' },
            { title: t('nim.step.wait'), sub: ready || wait?.done ? t('nim.step.readyNow') : t('stake.readyIn', { time: about(wait?.etaMs ?? 0) }), state: ready ? 'done' : 'wait' },
            { title: t('stake.sw.move', { pool: name }), state: ready ? 'now' : 'later' },
          ]}
        />
        <p className="sheet-note">{t('stake.sw.waitNote')}</p>
        <div className="row-actions">
          {ready && <Button onClick={() => onOpen({ mode: 'switch', pool: target })}>{t('stake.do.switch', { pool: name })}</Button>}
          <Button variant="quiet" onClick={onDrop}>
            {t('stake.sw.instead')}
          </Button>
        </div>
      </Card>
    </section>
  )
}

function Stake({ onOpen }: { onOpen: (s: NimSpec) => void }) {
  const app = useApp()
  const { nim } = app
  const s = nim.staker
  if (s === undefined) return <p className="muted">{t('status.loading')}</p>
  if (s === null || s.activeLuna + s.inactiveLuna + s.retiredLuna === 0n) {
    return (
      <Card className="stake-card">
        <p className="rc-k">{t('stake.none')}</p>
        <p className="muted">{nim.stakeable !== undefined ? t('stake.noneSub', { amount: nimAmount(nim.stakeable) }) : t('status.loading')}</p>
        <div className="row-actions">
          <Button onClick={() => onOpen({ mode: 'stake' })}>{t('stake.title.stake')}</Button>
        </div>
      </Card>
    )
  }
  const pool = nim.myPool
  return (
    <Card className="stake-card">
      <div className="rc-head">
        <span className="rc-k">{t('stake.staked')}</span>
      </div>
      <div className="rc-line">
        <span className="rc-v big">{nimAmount(s.activeLuna, false)}</span>
        <span className="rc-u">NIM</span>
      </div>
      {Number.isFinite(app.fiat.nimToFiat(s.activeLuna)) && <p className="muted">{approx(app.fiat, app.fiat.nimToFiat(s.activeLuna))}</p>}
      <div className="pool-box">
        <p className="pool-name">{pool ? pool.name : s.delegation ? t('stake.unlisted') : t('stake.noPool')}</p>
        {pool && <PoolFacts p={pool} />}
      </div>
      <div className="row-actions">
        <Button variant="ghost" onClick={() => onOpen({ mode: 'add' })} disabled={s.activeLuna === 0n && s.inactiveLuna === 0n}>
          {t('stake.addShort')}
        </Button>
        <Button variant="ghost" onClick={() => onOpen({ mode: 'unstake' })} disabled={s.activeLuna === 0n}>
          {t('stake.unstakeShort')}
        </Button>
        <Button variant="ghost" onClick={() => onOpen({ mode: 'switch' })}>
          {t('stake.switchShort')}
        </Button>
      </div>
    </Card>
  )
}

function Restake({ onOpen }: { onOpen: (s: NimSpec) => void }) {
  const { nim } = useApp()
  const r = nim.restake
  if (!r) return null
  return (
    <section className="block" aria-labelledby="restake-h">
      <h2 className="block-h" id="restake-h">
        {t('stake.compound.title')}
      </h2>
      <Card tone="wash" className="compound">
        <p>{t('nim.restake.suggestion', { amount: nimAmount(r.amount, false), extra: nimAmount(r.extraPerYearLuna, false) })}</p>
        <p className="muted">{daysText('stake.compound.why', nim.check?.windowDays ?? NOMINAL_WINDOW_DAYS)}</p>
        <div className="row-actions">
          <Button onClick={() => onOpen({ mode: 'add', amount: r.amount })}>{t('stake.do.add', { amount: nimExact(r.amount) })}</Button>
        </div>
      </Card>
    </section>
  )
}

export function Nim() {
  const app = useApp()
  const { nim } = app
  const [sheet, setSheet] = useState<NimSpec | null>(null)
  const wallet = nim.accounts?.wallet ?? null
  const [target, setTarget] = useState<string | null>(() => (wallet ? loadSwitchTarget(wallet) : null))
  useEffect(() => setTarget(wallet ? loadSwitchTarget(wallet) : null), [wallet, sheet])
  const s = nim.staker
  // a switch is under way while the whole stake waits to move to a pool it is not with yet
  const switching = target !== null && !!s && s.activeLuna === 0n && s.inactiveLuna > 0n && normalizeAddress(s.delegation) !== normalizeAddress(target)
  const dropSwitch = () => {
    if (wallet) clearSwitchTarget(wallet)
    setTarget(null)
  }

  // "Stake" on Home opens the right sheet on arrival
  useEffect(() => {
    const i = app.takeIntent()
    if (i && 'stake' in i && nim.connected) setSheet({ mode: nim.staker ? 'add' : 'stake' })
  }, [])

  return (
    <div className="screen">
      <ScreenHead title={t('stake.screen')} sub={t('stake.sub')} badge={<TestnetBadge />} />
      {app.network === 'testnet' && <Notice>{t('stake.testnet')}</Notice>}
      {!nim.connected ? (
        <Card className="connect-card">
          <p className="connect-lede">{t('stake.connectLede')}</p>
          <ConnectNim />
        </Card>
      ) : (
        <>
          {nim.confirming && <Notice live>{t('nim.tx.confirming')}</Notice>}
          <Stake onOpen={setSheet} />
          {switching ? <Switching target={target} onOpen={setSheet} onDrop={dropSwitch} /> : <Unstaking onOpen={setSheet} />}
          <Restake onOpen={setSheet} />
        </>
      )}
      {sheet && <NimSheet key={sheet.mode} spec={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}
