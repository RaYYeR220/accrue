import { useState } from 'react'
import { t } from '../i18n'
import type { PoolRow } from '../features/nim/api'
import { Card } from '../ui/components'
import { Facts } from '../ui/components/Fields'
import { useApp } from './context'
import { nimAmount, pct, when } from './format'
import { feePct, payoutLine } from './nimParts'
import { ConnectNim, PoolVerdict, ScreenHead, TestnetBadge } from './parts'

function Methodology() {
  const app = useApp()
  return (
    <a
      className="method"
      href="#about"
      onClick={e => {
        e.preventDefault()
        app.go('about', { section: 'methodology' })
      }}
    >
      {t('check.method')}
    </a>
  )
}

function Mine() {
  const app = useApp()
  const { nim } = app
  if (!nim.connected) {
    return (
      <Card className="connect-card">
        <p className="connect-lede">{t('check.connectLede')}</p>
        <ConnectNim />
      </Card>
    )
  }
  if (app.network === 'testnet') return <Card tone="quiet">{t('check.testnet')}</Card>
  const c = nim.check
  if (!c) return <p className="muted">{t('status.loading')}</p>
  if (!c.staker || c.staker.activeLuna + c.staker.inactiveLuna === 0n) return <Card tone="quiet">{t('check.notStaking')}</Card>
  const pool = c.pool ?? nim.myPool
  if (!pool) return <Card tone="quiet">{t('check.unlisted')}</Card>
  return (
    <Card className="verdict-card" role="region" aria-labelledby="vc-pool" data-verdict={c.verdict ?? 'pending'}>
      <p className="vc-pool" id="vc-pool">
        {pool.name}
      </p>
      <PoolVerdict verdict={c.verdict} size="lg" />
      <p className="vc-window">{t('check.window', { days: c.windowDays })}</p>
      <Facts
        rows={[
          { key: 'e', k: t('check.expected'), v: c.expectedLuna !== null ? nimAmount(c.expectedLuna) : '—' },
          { key: 'r', k: t('check.received'), v: c.receivedLuna !== null ? nimAmount(c.receivedLuna) : '—' },
          { key: 'p', k: t('check.pct'), v: c.pct !== null ? pct(c.pct, 1) : '—' },
        ]}
      />
      {c.verdict && <p className="vc-desc">{t(`verdict.${c.verdict}.desc`)}</p>}
      {pool.reasons.length > 0 && (
        <ul className="reasons" aria-label={t('check.reasons')}>
          {pool.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <p className="src">{t('check.src')}</p>
      <Methodology />
    </Card>
  )
}

function Row({ p }: { p: PoolRow }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const id = `why-${p.address.replace(/\s/g, '')}`
  return (
    <li className="sb-row">
      <button type="button" className="sb-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <span className="sb-name">
          <i className="dot" style={{ background: p.accent ?? 'var(--faint)' }} aria-hidden="true" />
          {p.name}
        </span>
        <PoolVerdict verdict={p.verdict} />
      </button>
      <p className="sb-line">
        {t('pool.fee', { pct: feePct(p.fee) })} · {payoutLine(p)}
      </p>
      {open && (
        <ul className="reasons" id={id}>
          {p.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {p.ratio !== null && <li>{t('pool.ratio', { ratio: pct(p.ratio, 1), expected: pct(p.expectedRatio, 1) })}</li>}
          {p.lastPayoutTs !== null && <li>{t('pool.lastAt', { when: when(p.lastPayoutTs) })}</li>}
          {p.verdict ? <li>{t(`verdict.${p.verdict}.desc`)}</li> : <li>{t(app.network === 'testnet' ? 'check.noVerdictTestnet' : 'check.noVerdict')}</li>}
        </ul>
      )}
    </li>
  )
}

function Scoreboard() {
  const app = useApp()
  const data = app.nim.pools
  return (
    <section className="block" aria-labelledby="sb-h">
      <h2 className="block-h" id="sb-h">
        {data ? t('check.board', { n: data.pools.length }) : t('check.boardLoading')}
      </h2>
      {data && (
        <>
          <p className="src">{app.network === 'testnet' ? t('check.boardTestnet') : t('check.boardSrc', { days: data.windowDays, time: when(data.asOf) })}</p>
          <ul className="sb">
            {[...data.pools].sort((a, b) => (a.balanceLuna > b.balanceLuna ? -1 : a.balanceLuna < b.balanceLuna ? 1 : 0)).map(p => (
              <Row key={p.address} p={p} />
            ))}
          </ul>
        </>
      )}
      <Methodology />
    </section>
  )
}

export function PayoutCheck() {
  return (
    <div className="screen">
      <ScreenHead title={t('check.title')} sub={t('check.sub')} badge={<TestnetBadge />} />
      <Mine />
      <Scoreboard />
    </div>
  )
}
