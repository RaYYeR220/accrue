import { adaptiveDecimals, LIMITS, MIN_STAKE_LUNA, type AssetKey } from '@accrue/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NOMINAL_WINDOW_DAYS } from '../features/nim/api'
import { t } from '../i18n'
import { baselineFrom, loadVisit, nextVisit, saveVisit, sinceView, type Snapshot } from '../model/visit'
import { heroView, side } from '../model/hero'
import { idleOffers } from '../model/idle'
import { dayEstimate, nextPayout } from '../model/pools'
import { Button, Card } from '../ui/components'
import { Ticker } from '../ui/components/Ticker'
import { Spinner } from '../ui/components/Fields'
import { useApp } from './context'
import { about, approx, daysText, every, exactTokens, nimAmount, num, pct, signed, SYMBOL, time, tokens, when } from './format'
import { ASSET_KEYS, useLiveDollars, useNow } from './live'
import { ConnectEvm, ConnectNim, PoolVerdict } from './parts'

// Since-last-visit is saved at most this often while Home is open.
const SAVE_EVERY_MS = 30_000

function Hero() {
  const app = useApp()
  const live = useLiveDollars()
  const { nim } = app
  // a connected wallet without a staker has a known 0 staked
  const staked = nim.staker === null ? 0n : (nim.staker?.activeLuna ?? null)
  const dollars = side({ connected: app.owner !== null, value: live.total === null ? null : app.fiat.toFiat(live.total) })
  const nimSide = side({ connected: nim.connected, value: staked === null ? null : app.fiat.nimToFiat(staked), priced: app.network !== 'testnet' })
  const view = heroView(dollars, nimSide)
  const ticking = dollars.state === 'known' && live.perSecond > 0
  // enough digits that the last one moves about once a second
  const decimals = ticking ? adaptiveDecimals(app.fiat.toFiat(live.perSecond)) : 2
  const gap = view.kind === 'total' ? null : view.missing[0]!

  return (
    <section className="hero-card" aria-labelledby="home-title">
      <h1 className="eyebrow" id="home-title" tabIndex={-1}>
        {t('home.title', { fiat: app.fiat.fiat })}
      </h1>
      {view.kind === 'none' ? <p className="hero-num hero-empty">—</p> : <Ticker className="hero-num" text={app.fiat.format(view.value, decimals)} />}
      {view.kind === 'none' ? (
        <p className="hero-partial">{view.missing.every(m => m.why === 'off') ? t('home.notYet') : t('status.loading')}</p>
      ) : (
        gap && <p className="hero-partial">{t(`home.partial.${gap.side}.${gap.why}`)}</p>
      )}
      <p className="hero-sub">
        {ticking
          ? t('home.ticking', { rate: app.fiat.format(app.fiat.toFiat(live.perSecond * 86_400), 4) })
          : nimSide.state === 'known'
            ? t('home.payoutsArrive')
            : null}
      </p>
      <p className="src">
        {app.fiat.asOf === null
          ? t(app.fiat.unavailable ? 'home.srcDown' : 'home.srcPending')
          : app.fiat.stale
            ? t(app.fiat.priceStale ? 'home.srcStale' : 'home.srcFxStale', { price: app.fiat.format(app.fiat.nimToFiat(100_000n), 6), source: app.fiat.priceSource, note: app.fiat.note })
            : t('home.src', { price: app.fiat.format(app.fiat.nimToFiat(100_000n), 6), source: app.fiat.priceSource, time: time(app.fiat.asOf) })}
      </p>
    </section>
  )
}

function Earning() {
  const app = useApp()
  const live = useLiveDollars()
  const { nim } = app
  const staked = nim.staker?.activeLuna ?? null
  const decimals = (k: AssetKey) => adaptiveDecimals(live.assets[k]?.perSecond ?? 0)

  return (
    <section className="block" aria-labelledby="earning-h">
      <h2 className="block-h" id="earning-h">
        {t('home.earning')}
      </h2>
      <Card className="rowcard">
        <div className="rc-head">
          <span className="rc-k">{t('home.dollars')}</span>
          <span className="rc-meta">{t('home.dollarsWhere')}</span>
        </div>
        {!app.owner ? (
          <ConnectEvm />
        ) : live.total === null ? (
          <p className="muted">{t('status.loading')}</p>
        ) : Object.keys(live.assets).length === 0 ? (
          <p className="muted">{t('home.noDollars')}</p>
        ) : (
          ASSET_KEYS.filter(k => live.assets[k]).map(k => (
            <div className="rc-line" key={k}>
              <Ticker className="rc-v" text={num(live.assets[k]!.value, decimals(k), decimals(k))} />
              <span className="rc-u">{SYMBOL[k]}</span>
              {app.aave.data && <span className="rc-meta">{t('home.apy', { pct: pct(app.aave.data.reserves[k].supplyApy) })}</span>}
            </div>
          ))
        )}
      </Card>
      <Card className="rowcard">
        <div className="rc-head">
          <span className="rc-k">{t('home.nim')}</span>
          {nim.myPool && <span className="rc-meta">{nim.myPool.name}</span>}
        </div>
        {!nim.connected ? (
          <ConnectNim />
        ) : staked === null ? (
          nim.staker === null ? (
            <p className="muted">{t('home.noStake')}</p>
          ) : (
            <p className="muted">{t('status.loading')}</p>
          )
        ) : (
          <>
            <div className="rc-line">
              <span className="rc-v">{nimAmount(staked, false)}</span>
              <span className="rc-u">NIM</span>
              {Number.isFinite(app.fiat.nimToFiat(staked)) && <span className="rc-meta">{approx(app.fiat, app.fiat.nimToFiat(staked))}</span>}
            </div>
            {nim.myPool && (
              <button type="button" className="rc-verdict" onClick={() => app.go('payouts')}>
                <PoolVerdict verdict={nim.check?.verdict ?? null} />
                <span className="sr-only">{t('home.seeCheck', { pool: nim.myPool.name })}</span>
              </button>
            )}
          </>
        )}
      </Card>
    </section>
  )
}

function SinceVisit() {
  const app = useApp()
  const live = useLiveDollars(false)
  const now = useNow(60_000)
  const [base] = useState(() => baselineFrom(loadVisit(), Date.now()))
  const lastSave = useRef(0)
  const stakedAll = app.nim.staker === null ? 0n : app.nim.staker ? app.nim.staker.activeLuna + app.nim.staker.inactiveLuna : null

  const dollars = useMemo(() => {
    if (live.total === null) return null
    const out: Partial<Record<AssetKey, { scaled: bigint; index: bigint }>> = {}
    for (const k of ASSET_KEYS) {
      const a = live.assets[k]
      if (a) out[k] = { scaled: a.scaled, index: a.index }
    }
    return out
  }, [live])

  // best effort: what this visit saw becomes the next visit's comparison
  useEffect(() => {
    if (dollars === null && stakedAll === null) return
    if (Date.now() - lastSave.current < SAVE_EVERY_MS) return
    lastSave.current = Date.now()
    const snap: Snapshot = {
      at: Date.now(),
      dollars: dollars ? Object.fromEntries(Object.entries(dollars).map(([k, v]) => [k, { scaled: v.scaled.toString(), index: v.index.toString() }])) : null,
      nimStakedLuna: stakedAll === null ? null : stakedAll.toString(),
    }
    saveVisit(nextVisit(base, snap))
  }, [dollars, stakedAll, base])

  const day = dayEstimate({
    balances: live.total === null ? null : ASSET_KEYS.flatMap(k => (live.assets[k] ? [{ units: live.assets[k]!.balance, rateRay: live.assets[k]!.reserve.liquidityRateRay }] : [])),
    receivedLuna: app.nim.check?.receivedLuna ?? null,
    windowDays: app.nim.check?.windowDays ?? 0,
  })
  const v = sinceView({ base, now, dollars, nimStakedLuna: stakedAll, day })
  // the window the NIM figure was averaged over; before a check answers, the pool window
  const windowDays = app.nim.check?.windowDays ?? app.nim.pools?.windowDays ?? NOMINAL_WINDOW_DAYS
  const dollarsText = v.dollarsUsd === null ? null : signed(app.fiat.format(app.fiat.toFiat(Math.abs(v.dollarsUsd)), 4), v.dollarsUsd < 0)
  const nimText = v.nimLuna === null ? null : signed(nimAmount(v.nimLuna < 0n ? -v.nimLuna : v.nimLuna), v.nimLuna < 0n)

  return (
    <section className="block" aria-labelledby="since-h">
      <h2 className="block-h" id="since-h">
        {v.mode === 'visit' ? t('home.since.visit', { when: when(v.since) }) : t('home.since.day')}
      </h2>
      <Card tone="quiet" className="since">
        <div className="since-row">
          <span className="since-v">{dollarsText ?? '—'}</span>
          <span className="since-k">{v.mode === 'visit' ? t('home.since.interest') : t('home.since.interestDay')}</span>
        </div>
        <div className="since-row">
          <span className="since-v">{nimText ?? '—'}</span>
          <span className="since-k">{v.mode === 'visit' ? t('home.since.staked') : daysText('home.since.payoutsDay', windowDays)}</span>
        </div>
        <p className="src">{v.mode === 'visit' ? t('home.since.srcVisit') : daysText('home.since.srcDay', windowDays)}</p>
      </Card>
    </section>
  )
}

function Idle() {
  const app = useApp()
  if (!app.owner && !app.nim.connected) return null
  const staking = app.nim.staker === undefined ? undefined : app.nim.staker !== null && app.nim.staker.activeLuna + app.nim.staker.inactiveLuna > 0n
  const offers = idleOffers({ wallet: app.wallet.data, stakeable: app.nim.stakeable, staking })

  return (
    <section className="block" aria-labelledby="idle-h">
      <h2 className="block-h" id="idle-h">
        {t('home.idle.title')}
      </h2>
      {offers.length === 0 ? (
        <p className="muted">{t('home.idle.none')}</p>
      ) : (
        <ul className="list">
          {offers.map(o => (
            <li className="list-row" key={o.key}>
              <span className="list-text">
                {o.key === 'nim' ? t('home.idle.nim', { amount: nimAmount(o.units) }) : t('home.idle.token', { amount: tokens(o.units, o.key) })}
                {!o.ok && (
                  <span className="list-why">
                    {o.reason === 'MIN_DEPOSIT' ? t('home.idle.minDeposit', { min: exactTokens(LIMITS.minDepositUnits, o.key as AssetKey) }) : t('home.idle.minStake', { min: nimAmount(MIN_STAKE_LUNA) })}
                  </span>
                )}
              </span>
              {o.ok && (
                <Button variant="ghost" className="btn-sm" onClick={() => (o.key === 'nim' ? app.go('nim', { stake: true }) : app.go('dollars', { deposit: o.key }))}>
                  {o.key === 'nim' ? t('home.stakeIt') : t('home.putToWork')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DueNext() {
  const app = useApp()
  const now = useNow(30_000)
  const { nim } = app
  const items: { key: string; k: string; v: string }[] = []
  const pool = nim.myPool
  if (pool) {
    const n = nextPayout(pool, now)
    const v =
      n.kind === 'at'
        ? n.late
          ? t('home.due.late', { time: when(n.at, now), every: every(n.intervalMs) })
          : t('home.due.in', { in: about(n.at - now), every: every(n.intervalMs) })
        : n.kind === 'every'
          ? every(n.intervalMs)
          : n.kind === 'none'
            ? t('home.due.none')
            : t('home.due.unknown')
    items.push({ key: 'payout', k: t('home.due.payout', { pool: pool.name }), v })
  }
  const s = nim.staker
  if (s && s.inactiveLuna > 0n) {
    const plan = nim.planUnstake(s.inactiveLuna + s.retiredLuna)
    const wait = plan?.steps[1]
    const v = !wait ? t('status.loading') : wait.done ? t('nim.step.readyNow') : t('stake.readyIn', { time: about(wait.etaMs ?? 0) })
    items.push({ key: 'unstake', k: t('home.due.unstake', { amount: nimAmount(s.inactiveLuna) }), v })
  }
  if (s && s.retiredLuna > 0n) items.push({ key: 'remove', k: t('home.due.remove', { amount: nimAmount(s.retiredLuna) }), v: t('nim.step.readyNow') })
  if (!items.length && !pool) return null

  return (
    <section className="block" aria-labelledby="due-h">
      <h2 className="block-h" id="due-h">
        {t('home.due.title')}
      </h2>
      <ul className="list">
        {items.map(i => (
          <li className="list-row list-kv" key={i.key}>
            <span className="list-k">{i.k}</span>
            <span className="list-v">{i.v}</span>
          </li>
        ))}
        {pool && (
          <li className="list-row list-kv">
            <span className="list-k">{t('home.due.verdict')}</span>
            <button type="button" className="rc-verdict" onClick={() => app.go('payouts')}>
              <PoolVerdict verdict={nim.check?.verdict ?? null} />
              <span className="sr-only">{t('home.seeCheck', { pool: pool.name })}</span>
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}

function OnTheWay() {
  const app = useApp()
  const open = app.activity.filter(r => r.status === 'pending' || r.status === 'checking')
  if (!open.length) return null
  return (
    <button type="button" className="strip" onClick={() => app.go('activity')}>
      <Spinner />
      <span>{t('home.onTheWay', { n: open.length })}</span>
    </button>
  )
}

export function Home() {
  return (
    <div className="screen">
      <Hero />
      <OnTheWay />
      <SinceVisit />
      <Earning />
      <Idle />
      <DueNext />
    </div>
  )
}
