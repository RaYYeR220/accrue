import { adaptiveDecimals, type AssetKey } from '@accrue/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import { baselineFrom, loadVisit, nextVisit, saveVisit, sinceView, type Snapshot } from '../model/visit'
import { dayEstimate, nextPayout } from '../model/pools'
import { Button, Card, VerdictBadge } from '../ui/components'
import { Ticker } from '../ui/components/Ticker'
import { Spinner } from '../ui/components/Fields'
import { useApp } from './context'
import { about, every, nimAmount, num, signed, SYMBOL, time, tokens, when } from './format'
import { ASSET_KEYS, useLiveDollars, useNow } from './live'
import { ConnectEvm, ConnectNim } from './parts'

// Since-last-visit is saved at most this often while Home is open.
const SAVE_EVERY_MS = 30_000

function Hero() {
  const app = useApp()
  const live = useLiveDollars()
  const staked = app.nim.staker?.activeLuna ?? null
  const usd = live.total
  const nimFiat = staked !== null ? app.fiat.nimToFiat(staked) : null
  const total = (usd !== null ? app.fiat.toFiat(usd) : 0) + (nimFiat !== null && Number.isFinite(nimFiat) ? nimFiat : 0)
  const anything = usd !== null || staked !== null
  // enough digits that the last one moves about once a second
  const decimals = live.perSecond > 0 ? adaptiveDecimals(app.fiat.toFiat(live.perSecond)) : 2

  return (
    <section className="hero-card" aria-labelledby="home-title">
      <h1 className="eyebrow" id="home-title" tabIndex={-1}>
        {t('home.title', { fiat: app.fiat.fiat })}
      </h1>
      {anything ? <Ticker className="hero-num" text={app.fiat.format(total, decimals)} /> : <p className="hero-num hero-empty">{app.fiat.format(0, 2)}</p>}
      <p className="hero-sub">
        {usd !== null && live.perSecond > 0
          ? t('home.ticking', { rate: app.fiat.format(app.fiat.toFiat(live.perSecond * 86_400), 4) })
          : staked !== null
            ? t('home.nimOnly')
            : t('home.notYet')}
      </p>
      <p className="src">
        {app.fiat.asOf !== null ? t('home.src', { price: app.fiat.format(app.fiat.nimToFiat(100_000n), 6), time: time(app.fiat.asOf) }) : t('home.srcPending')}
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
              {app.aave.data && <span className="rc-meta">{t('home.apy', { pct: (app.aave.data.reserves[k].supplyApy * 100).toFixed(2) })}</span>}
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
              <span className="rc-meta">≈ {app.fiat.format(app.fiat.nimToFiat(staked))}</span>
            </div>
            {nim.myPool && (
              <button type="button" className="rc-verdict" onClick={() => app.go('payouts')}>
                <VerdictBadge verdict={nim.check?.verdict ?? null} />
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
    windowDays: app.nim.check?.windowDays ?? 7,
  })
  const v = sinceView({ base, now, dollars, nimStakedLuna: stakedAll, day })
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
          <span className="since-k">{v.mode === 'visit' ? t('home.since.staked') : t('home.since.payoutsDay')}</span>
        </div>
        <p className="src">{v.mode === 'visit' ? t('home.since.srcVisit') : t('home.since.srcDay')}</p>
      </Card>
    </section>
  )
}

function Idle() {
  const app = useApp()
  const rows: { key: string; text: string; cta: string; go: () => void }[] = []
  for (const k of ASSET_KEYS) {
    const b = app.wallet.data?.[k] ?? 0n
    if (b > 0n) rows.push({ key: k, text: t('home.idle.token', { amount: tokens(b, k) }), cta: t('home.putToWork'), go: () => app.go('dollars', { deposit: k }) })
  }
  const nimIdle = app.nim.stakeable ?? 0n
  if (nimIdle > 0n) rows.push({ key: 'nim', text: t('home.idle.nim', { amount: nimAmount(nimIdle) }), cta: t('home.stakeIt'), go: () => app.go('nim', { stake: true }) })
  if (!app.owner && !app.nim.connected) return null

  return (
    <section className="block" aria-labelledby="idle-h">
      <h2 className="block-h" id="idle-h">
        {t('home.idle.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="muted">{t('home.idle.none')}</p>
      ) : (
        <ul className="list">
          {rows.map(r => (
            <li className="list-row" key={r.key}>
              <span className="list-text">{r.text}</span>
              <Button variant="ghost" className="btn-sm" onClick={r.go}>
                {r.cta}
              </Button>
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
              <VerdictBadge verdict={nim.check?.verdict ?? null} />
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
