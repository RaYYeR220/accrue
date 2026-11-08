import type { ReactNode } from 'react'

// An amount input that accepts what the parser accepts and nothing is rewritten while typing.
// The unit sits inside the field; Max (or another quick fill) sits beside it.
export function AmountField({
  id,
  label,
  unit,
  value,
  onChange,
  quick,
  hint,
  error,
  disabled,
}: {
  id: string
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  quick?: ReactNode
  hint?: ReactNode
  error?: string | null
  disabled?: boolean
}) {
  const msg = `${id}-msg`
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className={error ? 'field-row field-bad' : 'field-row'}>
        <div className="field-box">
          <input
            id={id}
            className="field-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            placeholder="0"
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={msg}
            onChange={e => onChange(e.target.value)}
          />
          <span className="field-unit" aria-hidden="true">
            {unit}
          </span>
        </div>
        {quick}
      </div>
      <p className={error ? 'field-msg field-err' : 'field-msg'} id={msg} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </p>
    </div>
  )
}

export type StepState = 'done' | 'now' | 'wait' | 'later'

export interface StepItem {
  title: ReactNode
  sub?: ReactNode
  state: StepState
}

// A numbered plan: what is done, what the next tap does, what waits on the network.
export function Steps({ items, label }: { items: StepItem[]; label: string }) {
  return (
    <ol className="steps" aria-label={label}>
      {items.map((s, i) => (
        <li key={i} className={`step step-${s.state}`}>
          <span className="step-n" aria-hidden="true">
            {s.state === 'done' ? (
              <svg viewBox="0 0 16 16">
                <path d="M4 8.4l2.6 2.4L12 5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              i + 1
            )}
          </span>
          <span className="step-body">
            <span className="step-title">{s.title}</span>
            {s.sub && <span className="step-sub">{s.sub}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

// Links that leave the app open in the system browser.
export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a className={['ext', className ?? ''].filter(Boolean).join(' ')} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4 2.5h5.5V8M9.2 2.8L3 9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </a>
  )
}

// Label / value rows; values carry their own units and sources.
export function Facts({ rows, className }: { rows: { k: ReactNode; v: ReactNode; key?: string }[]; className?: string }) {
  return (
    <dl className={['facts', className ?? ''].filter(Boolean).join(' ')}>
      {rows.map((r, i) => (
        <div className="fact" key={r.key ?? i}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Notice({ tone = 'plain', children, live }: { tone?: 'plain' | 'accent' | 'warn'; children: ReactNode; live?: boolean }) {
  return (
    <div className={`notice notice-${tone}`} role={live ? 'status' : undefined}>
      {children}
    </div>
  )
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />
}
