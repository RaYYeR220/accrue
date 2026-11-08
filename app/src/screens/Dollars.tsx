import { adaptiveDecimals, LIMITS, type AssetKey } from '@accrue/shared'
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import type { ActivityRow } from '../model/activity'
import { Button, Card } from '../ui/components'
import { Facts, Notice, Spinner } from '../ui/components/Fields'
import { Ticker } from '../ui/components/Ticker'
import { useApp } from './context'
import { DollarSheet, type SheetSpec } from './DollarSheet'
import { num, SYMBOL, time, tokens } from './format'
import { ASSET_KEYS, useLiveDollars } from './live'
import { ConnectEvm, ScreenHead } from './parts'
import { rowStatus, rowTitle } from './rows'

const NAME: Record<AssetKey, string> = { USDT0: 'sym.usdt', USDC: 'sym.usdc' }

function AssetCard({ asset, onOpen }: { asset: AssetKey; onOpen: (s: SheetSpec) => void }) {
  const app = useApp()
  const live = useLiveDollars()
  const r = app.aave.data?.reserves[asset]
  const p = app.position.data?.assets[asset]
  const a = live.assets[asset]
  const inWallet = app.wallet.data?.[asset]
  const tooLittle = inWallet !== undefined && inWallet < LIMITS.minDepositUnits
  const reasonId = `dep-why-${asset}`

  return (
    <Card className="asset" role="region" aria-labelledby={`sym-${asset}`}>
      <div className="asset-head">
        <div>
          <h2 className="asset-sym" id={`sym-${asset}`}>
            {SYMBOL[asset]}
          </h2>
          <p className="asset-name">{t(NAME[asset])}</p>
        </div>
        <div className="apy">
          <span className="apy-v">{r ? `${num(r.supplyApy * 100, 2, 2)}%` : '—'}</span>
          <span className="apy-k">{t('usd.apy')}</span>
        </div>
      </div>
      {app.owner && (
        <Facts
          rows={[
            {
              key: 'in',
              k: t('usd.inAave'),
              v: a ? (
                <>
                  <Ticker text={num(a.value, adaptiveDecimals(a.perSecond), adaptiveDecimals(a.perSecond))} /> {SYMBOL[asset]}
                </>
              ) : p ? (
                tokens(p.aTokenBalance, asset)
              ) : (
                '—'
              ),
            },
            { key: 'principal', k: t('usd.principal'), v: p ? tokens(p.principal, asset) : '—' },
            { key: 'earned', k: t('usd.earned'), v: p ? tokens(p.earned > 0n ? p.earned : 0n, asset) : '—' },
            { key: 'wallet', k: t('usd.inWallet'), v: inWallet !== undefined ? tokens(inWallet, asset) : '—' },
          ]}
        />
      )}
      {app.owner && (
        <div className="asset-actions">
          <Button disabled={tooLittle} aria-describedby={tooLittle ? reasonId : undefined} onClick={() => onOpen({ kind: 'supply', asset })}>
            {t('usd.deposit')}
          </Button>
          <Button variant="ghost" disabled={!p || p.aTokenBalance === 0n} onClick={() => onOpen({ kind: 'withdraw', asset })}>
            {t('usd.withdraw')}
          </Button>
        </div>
      )}
      {tooLittle && (
        <p className="why" id={reasonId}>
          {t('usd.tooLittle', { min: tokens(LIMITS.minDepositUnits, asset), balance: tokens(inWallet, asset) })}
        </p>
      )}
    </Card>
  )
}

function Risks() {
  const app = useApp()
  const r = app.aave.data?.reserves
  const rate = (k: AssetKey) => (r ? `${num(r[k].supplyApy * 100, 2, 2)}%` : '—')
  const avail = (k: AssetKey) => (r ? tokens(r[k].availableLiquidity, k) : '—')
  return (
    <section className="block" aria-labelledby="risk-h">
      <h2 className="block-h" id="risk-h">
        {t('usd.risk.title')}
      </h2>
      <Card tone="quiet" className="risk">
        <Facts
          rows={[
            { key: 'p', k: t('usd.risk.protocol'), v: t('usd.risk.protocolV') },
            { key: 'r', k: t('usd.risk.rate'), v: t('usd.risk.rateV', { usdt: rate('USDT0'), usdc: rate('USDC') }) },
            { key: 'w', k: t('usd.risk.wrong'), v: t('usd.risk.wrongV') },
            { key: 'e', k: t('usd.risk.exit'), v: t('usd.risk.exitV', { usdt: avail('USDT0'), usdc: avail('USDC') }) },
          ]}
        />
        <p className="src">{app.aave.data ? t('usd.src', { time: time(app.aave.data.asOf) }) : app.aave.isError ? t('usd.srcDown') : t('status.loading')}</p>
      </Card>
    </section>
  )
}

function OnTheWay({ rows, onOpen }: { rows: ActivityRow[]; onOpen: (s: SheetSpec) => void }) {
  if (!rows.length) return null
  return (
    <section className="block" aria-labelledby="way-h">
      <h2 className="block-h" id="way-h">
        {t('usd.onTheWay')}
      </h2>
      <ul className="list">
        {rows.map(r => (
          <li className="list-row" key={r.id} data-status={r.status}>
            <span className="list-text">
              <span className="list-k">{rowTitle(r)}</span>
              <span className="list-status">
                <Spinner /> {rowStatus(r)}
              </span>
            </span>
            <Button variant="ghost" className="btn-sm" onClick={() => onOpen({ kind: r.kind === 'deposit' ? 'supply' : 'withdraw', asset: r.asset!, attach: r.id })}>
              {t('usd.details')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Dollars() {
  const app = useApp()
  const [sheet, setSheet] = useState<SheetSpec | null>(null)

  // a "Put to work" tap on Home opens the deposit sheet on arrival
  useEffect(() => {
    const i = app.takeIntent()
    if (i && 'deposit' in i && app.owner) setSheet({ kind: 'supply', asset: i.deposit })
  }, [])

  const open = app.activity.filter(r => r.chain === 'polygon' && (r.status === 'pending' || r.status === 'checking'))

  return (
    <div className="screen">
      <ScreenHead title={t('usd.title')} sub={t('usd.sub')} />
      {app.network === 'testnet' && <Notice>{t('usd.mainnetOnly')}</Notice>}
      {!app.owner && (
        <Card className="connect-card">
          <p className="connect-lede">{t('usd.connectLede')}</p>
          <ConnectEvm />
        </Card>
      )}
      <OnTheWay rows={open} onOpen={setSheet} />
      {ASSET_KEYS.map(k => (
        <AssetCard key={k} asset={k} onOpen={setSheet} />
      ))}
      <Risks />
      {sheet && <DollarSheet key={`${sheet.kind}:${sheet.asset}:${sheet.attach ?? ''}`} spec={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}
