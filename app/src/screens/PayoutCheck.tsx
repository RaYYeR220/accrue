import { useState } from 'react'
import { t } from '../i18n'
import type { PoolRow } from '../features/nim/api'
import { noVerdictView, poolReasonLines } from '../model/pools'
import { Card } from '../ui/components'
import { Facts } from '../ui/components/Fields'
import { useApp } from './context'
import { daysText, nimAmount, pct, when } from './format'
import { PoolLine } from './nimParts'
import { ConnectNim, PoolVerdict, ScreenHead, TestnetBadge } from './parts'

// the API writes its percentages in English with one decimal, whatever the app language
const p1 = (x: number) => `${(x * 100).toFixed(1)}%`

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
      <p className="vc-window">{daysText('check.window', c.windowDays)}</p>
      <Facts
        rows={[
          { key: 'e', k: t('check.expected'), v: c.expectedLuna !== null ? nimAmount(c.expectedLuna) : '—' },
          { key: 'r', k: t('check.received'), v: c.receivedLuna !== null ? nimAmount(c.receivedLuna) : '—' },
          { key: 'p', k: t('check.pct'), v: c.pct !== null ? pct(c.pct, 1) : '—' },
        ]}
      />
      {c.verdict && <p className="vc-desc">{t(`verdict.${c.verdict}.desc`)}</p>}
      {noVerdictView(pool).reasons.length > 0 && (
        <ul className="reasons" aria-label={t('check.reasons')}>
          {poolReasonLines(noVerdictView(pool).reasons, []).map((r, i) => (
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
      <PoolLine p={p} className="sb-line" />
      {open && (
        <ul className="reasons" id={id}>
          {poolReasonLines(noVerdictView(p).reasons, [
            ...(p.ratio !== null && p.expectedRatio !== null
              ? [{ text: t('pool.ratio', { ratio: pct(p.ratio, 1), expected: pct(p.expectedRatio, 1) }), covers: [p1(p.ratio), p1(p.expectedRatio)] }]
              : []),
            ...(p.lastPayoutTs !== null ? [{ text: t('pool.lastAt', { when: when(p.lastPayoutTs) }) }] : []),
          ]).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {p.verdict ? <li>{t(`verdict.${p.verdict}.desc`)}</li> : app.network === 'testnet' ? <li>{t('check.noVerdictTestnet')}</li> : noVerdictView(p).unchecked && <li>{t('check.noVerdict')}</li>}
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
          <p className="src">{app.network === 'testnet' ? t('check.boardTestnet') : daysText('check.boardSrc', data.windowDays, { time: when(data.asOf) })}</p>
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
