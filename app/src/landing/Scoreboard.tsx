import { Fragment, useState, type CSSProperties } from 'react'
import { t } from '../i18n'
import { poolReasonLines } from '../model/pools'
import { VerdictBadge } from '../ui/components'
import type { PoolRow, PoolsData } from './data'
import { fmtAgo, fmtCompact, fmtDate, fmtDateTime, fmtDaysText, fmtNum, fmtPct } from './format'
import { accentDot } from './orbit/tint'
import { scheduleInfo } from './schedule'

// the API writes its percentages in English with one decimal, whatever the app language
const p1 = (x: number) => `${(x * 100).toFixed(1)}%`
const feePct = (fee: number | null) => (fee === null ? t('landing.board.feeNA') : fmtPct(fee))

function sched(p: PoolRow) {
  const s = scheduleInfo(p.schedule, p.payoutType)
  return t(s.label.key, s.label.vars)
}

function Reasons({ p, id }: { p: PoolRow; id: string }) {
  return (
    <tr className="reasons-row" id={id}>
      <td colSpan={7}>
        <ul>
          {poolReasonLines(p.reasons, [
            ...(p.ratio !== null && p.expectedRatio !== null
              ? [{ text: t('landing.board.ratio', { ratio: fmtPct(p.ratio, 1), expected: fmtPct(p.expectedRatio, 1) }), covers: [p1(p.ratio), p1(p.expectedRatio)] }]
              : []),
            ...(p.lastPayoutTs !== null ? [{ text: t('landing.board.lastPayout', { when: fmtAgo(p.lastPayoutTs) }) }] : []),
          ]).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </td>
    </tr>
  )
}

export function Scoreboard({ data, onShowPool }: { data: PoolsData; onShowPool: (address: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const live = data.source === 'live'

  return (
    <div className="board" data-source={data.source}>
      <div className="board-head">
        <h3>{t('landing.board.title', { n: data.pools.length })}</h3>
        <p>
          {live
            ? fmtDaysText('landing.board.live', data.windowDays, { date: fmtDateTime(data.asOf) })
            : t('landing.board.snapshot', { date: fmtDate(data.asOf) })}
        </p>
      </div>
      <div className="board-scroll" role="region" aria-label={t('landing.board.scroll')} tabIndex={0}>
        <table className="board-t">
          <thead>
            <tr>
              <th scope="col">{t('landing.board.col.pool')}</th>
              <th scope="col" className="num">
                {t('landing.board.col.fee')}
              </th>
              <th scope="col">{t('landing.board.col.payout')}</th>
              <th scope="col">{t('landing.board.col.schedule')}</th>
              <th scope="col" className="num">
                {t('landing.board.col.stake')}
              </th>
              <th scope="col" className="num">
                {t('landing.board.col.stakers')}
              </th>
              <th scope="col">{t('landing.board.col.verdict')}</th>
            </tr>
          </thead>
          <tbody>
            {data.pools.map((p, i) => {
              const rid = `why-${i}`
              const isOpen = open === p.address
              const nim = Number(p.balanceLuna / 100_000n)
              return (
                <Fragment key={p.address}>
                  <tr>
                    <td className="c-pool">
                      <button type="button" className="pool-btn" aria-label={t('landing.board.showPool', { pool: p.name })} onClick={() => onShowPool(p.address)}>
                        <i style={{ '--c': accentDot(p.accent ?? '#8a8790') } as CSSProperties} />
                        <span>{p.name}</span>
                      </button>
                    </td>
                    <td className="c-fee num">{feePct(p.fee)}</td>
                    <td className="c-type" data-fee={p.fee === null ? t('landing.board.feeNA') : t('landing.board.feeOf', { pct: fmtPct(p.fee) })}>
                      {t(`landing.board.type.${p.payoutType}`)}
                    </td>
                    <td className="c-sched">{sched(p)}</td>
                    <td className="c-stake num" data-post=" NIM">
                      {fmtCompact(nim)}
                    </td>
                    <td className="c-stakers num" data-post={` ${t('landing.board.stakersSuffix')}`}>
                      {fmtNum(p.stakers)}
                    </td>
                    <td className="c-verdict">
                      {p.verdict ? (
                        <button
                          type="button"
                          className="vd-btn"
                          aria-expanded={isOpen}
                          aria-controls={rid}
                          aria-label={t('landing.board.why', { pool: p.name, verdict: t(`verdict.${p.verdict}`) })}
                          onClick={() => setOpen(isOpen ? null : p.address)}
                        >
                          <VerdictBadge verdict={p.verdict} />
                        </button>
                      ) : (
                        <VerdictBadge verdict={null} />
                      )}
                    </td>
                  </tr>
                  {isOpen && p.verdict && <Reasons p={p} id={rid} />}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="board-foot">{live ? fmtDaysText('landing.board.foot.live', data.windowDays) : t('landing.board.foot.snapshot')}</p>
    </div>
  )
}
