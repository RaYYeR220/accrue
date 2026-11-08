import { useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { t } from '../i18n'
import { HttpError } from '../providers/errors'
import { Amount, Button, Card, Stat, VerdictBadge } from '../ui/components'
import { describeCheck, describePosition, fetchCheck, fetchPosition, type CheckView, type PositionView } from './data'
import { fmtNimLuna, fmtPct, fmtUsd6 } from './format'
import { accentDot } from './orbit/tint'
import { classifyQuery, type QueryInvalidReason } from './query'

type State =
  | { s: 'idle' }
  | { s: 'invalid'; reason: QueryInvalidReason | 'empty' }
  | { s: 'loading' }
  | { s: 'nim'; view: CheckView }
  | { s: 'evm'; view: PositionView }
  | { s: 'failed'; code: 'network' | 'rate' | 'rejected' }

function failure(e: unknown): 'network' | 'rate' | 'rejected' {
  if (e instanceof HttpError) {
    if (e.status === 429) return 'rate'
    if (e.status === 400 || e.status === 404 || e.status === 422) return 'rejected'
  }
  return 'network'
}

function NimResult({ view, poolCount }: { view: CheckView; poolCount: number }) {
  if (view.kind === 'notStaking') {
    return (
      <Card tone="quiet" className="result">
        <h4>{t('landing.checker.notStaking.title')}</h4>
        <p>{t('landing.checker.notStaking.body')}</p>
      </Card>
    )
  }
  if (view.kind === 'unlisted') {
    return (
      <Card tone="quiet" className="result">
        <h4>{t('landing.checker.unlisted.title')}</h4>
        <p>
          {t('landing.checker.unlisted.body', {
            amount: fmtNimLuna(view.activeLuna),
            validator: view.delegation ?? t('landing.checker.unlisted.someValidator'),
            n: poolCount,
          })}
        </p>
      </Card>
    )
  }
  const { pool, staker } = view
  return (
    <Card className="result result-verdict">
      <div className="result-head">
        <span className="result-pool">
          <i style={{ '--c': accentDot(pool.accent ?? '#8a8790') } as CSSProperties} />
          {pool.name}
        </span>
        <span className="result-k">{t('landing.checker.you', { days: view.windowDays })}</span>
      </div>
      <VerdictBadge verdict={view.verdict} size="lg" />
      <div className="result-stats">
        <Stat label={t('landing.checker.expected')} value={view.expectedLuna === null ? '—' : <Amount value={fmtNimLuna(view.expectedLuna)} unit="NIM" />} />
        <Stat label={t('landing.checker.received')} value={view.receivedLuna === null ? '—' : <Amount value={fmtNimLuna(view.receivedLuna)} unit="NIM" />} />
        <Stat label={t('landing.checker.share')} value={view.pct === null ? '—' : <Amount value={fmtPct(view.pct, 1)} />} />
      </div>
      <p className="result-why">{view.pct === null ? t('landing.checker.reasonNoData') : t('landing.checker.reasonPct', { pct: fmtPct(view.pct, 1) })}</p>
      {staker.inactiveLuna > 0n && <p className="result-note">{t('landing.checker.unstaking', { amount: fmtNimLuna(staker.inactiveLuna) })}</p>}
      <div className="result-pool-verdict">
        <span className="result-k">{t('landing.checker.poolOverall', { pool: pool.name })}</span>
        {pool.verdict ? <VerdictBadge verdict={pool.verdict} /> : <VerdictBadge verdict="NOT_ENOUGH_DATA" label={t('landing.board.notYet')} />}
        {pool.reasons.length > 0 && (
          <ul>
            {pool.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function EvmResult({ view }: { view: PositionView }) {
  if (view.kind === 'empty') {
    return (
      <Card tone="quiet" className="result">
        <h4>{t('landing.checker.position.emptyTitle')}</h4>
        <p>{t('landing.checker.position.emptyBody')}</p>
      </Card>
    )
  }
  return (
    <Card className="result">
      <div className="result-head">
        <span className="result-pool">{t('landing.checker.position.title')}</span>
      </div>
      {view.rows.map(r => (
        <div className="result-asset" key={r.asset}>
          <h4>{r.asset}</h4>
          <div className="result-stats">
            <Stat label={t('landing.checker.position.inAave')} value={<Amount value={fmtUsd6(r.aTokenBalance)} />} />
            <Stat label={t('landing.checker.position.viaAccrue')} value={<Amount value={fmtUsd6(r.principal)} />} />
            <Stat label={t('landing.checker.position.earned')} value={<Amount value={fmtUsd6(r.earned)} />} />
          </div>
        </div>
      ))}
      <p className="result-note">{t('landing.checker.position.note')}</p>
    </Card>
  )
}

// Read-only: nothing is fetched until the visitor presses Check.
export function Checker({ poolCount }: { poolCount: number }) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<State>({ s: 'idle' })
  const seq = useRef(0)

  async function run() {
    const q = classifyQuery(value)
    if (q.kind === 'empty') return setState({ s: 'invalid', reason: 'empty' })
    if (q.kind === 'invalid') return setState({ s: 'invalid', reason: q.reason })
    const id = ++seq.current
    setState({ s: 'loading' })
    try {
      const next: State =
        q.kind === 'nim' ? { s: 'nim', view: describeCheck(await fetchCheck(q.address)) } : { s: 'evm', view: describePosition(await fetchPosition(q.address)) }
      if (id === seq.current) setState(next)
    } catch (e) {
      if (id === seq.current) setState({ s: 'failed', code: failure(e) })
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void run()
  }

  const invalid = state.s === 'invalid'
  return (
    <div className="checker" id="checker">
      <div className="checker-head">
        <h3>{t('landing.checker.title')}</h3>
        <p>{t('landing.checker.body')}</p>
      </div>
      <form className="checker-form" onSubmit={onSubmit} noValidate>
        <label className="sr-only" htmlFor="checker-input">
          {t('landing.checker.label')}
        </label>
        <input
          id="checker-input"
          className="field"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={t('landing.checker.placeholder')}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'checker-error' : undefined}
          onChange={e => {
            setValue(e.target.value)
            if (state.s === 'invalid') setState({ s: 'idle' })
          }}
        />
        <Button type="submit" disabled={state.s === 'loading'}>
          {t('landing.checker.submit')}
        </Button>
      </form>
      {invalid && (
        <p className="checker-error" id="checker-error" role="alert">
          {t(`landing.checker.err.${state.reason}`)}
        </p>
      )}
      <div className="checker-out" aria-live="polite" aria-busy={state.s === 'loading'}>
        {state.s === 'loading' && <p className="checker-wait">{t('landing.checker.loading')}</p>}
        {state.s === 'nim' && <NimResult view={state.view} poolCount={poolCount} />}
        {state.s === 'evm' && <EvmResult view={state.view} />}
        {state.s === 'failed' && (
          <div className="checker-failed" role="alert">
            <p>{t(`landing.checker.err.${state.code}`)}</p>
            {state.code !== 'rejected' && (
              <Button variant="ghost" onClick={() => void run()}>
                {t('landing.checker.retry')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
