import { t } from '../i18n'
import type { ActivityRow } from '../model/activity'
import { Card } from '../ui/components'
import { ExtLink, Spinner } from '../ui/components/Fields'
import { useApp } from './context'
import { when } from './format'
import { ConnectEvm, ConnectNim, ScreenHead } from './parts'
import { rowStatus, rowTitle } from './rows'

function Item({ r }: { r: ActivityRow }) {
  return (
    <li className="act" data-status={r.status} data-chain={r.chain}>
      <div className="act-main">
        <span className="act-title">{rowTitle(r)}</span>
        <span className={`act-st act-st-${r.status}`}>
          {(r.status === 'pending' || r.status === 'checking') && <Spinner />}
          {rowStatus(r)}
        </span>
      </div>
      <div className="act-meta">
        <span>
          {when(r.at)} · {r.chain === 'polygon' ? t('act.onPolygon') : t('act.onNimiq')}
          {r.selfPaid && ` · ${t('act.selfPaid')}`}
        </span>
        {r.url && <ExtLink href={r.url}>{r.chain === 'polygon' ? t('common.polygonscan') : t('common.nimiqExplorer')}</ExtLink>}
      </div>
      {r.errorKey && <p className="act-err">{t(r.errorKey)}</p>}
      {r.elsewhere && <p className="act-err">{t('act.landedNote')}</p>}
    </li>
  )
}

export function Activity() {
  const app = useApp()
  const rows = app.activity
  return (
    <div className="screen">
      <ScreenHead title={t('act.title')} sub={t('act.sub')} />
      {rows.length === 0 ? <Card tone="quiet">{t('act.empty')}</Card> : <ul className="acts">{rows.map(r => <Item key={`${r.chain}:${r.id}`} r={r} />)}</ul>}
      {(!app.owner || !app.nim.connected) && (
        <Card tone="quiet" className="act-more">
          <p className="muted">{t('act.more')}</p>
          {!app.owner && <ConnectEvm />}
          {!app.nim.connected && <ConnectNim />}
        </Card>
      )}
      <p className="src">{t('act.src')}</p>
      {rows.some(r => r.status === 'checking') && (
        <p className="src">
          <Spinner /> {t('act.checkingNote')}
        </p>
      )}
    </div>
  )
}
