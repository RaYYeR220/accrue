import { useState, type ReactNode } from 'react'
import { t } from '../i18n'
import type { UiError } from '../providers/errors'
import type { Verdict } from '@accrue/shared'
import { Button, VerdictBadge } from '../ui/components'
import { Spinner } from '../ui/components/Fields'
import { useApp } from './context'

export function ScreenHead({ title, sub, badge }: { title: string; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="scr-head">
      <div className="scr-title-row">
        <h1 className="scr-title" tabIndex={-1}>
          {title}
        </h1>
        {badge}
      </div>
      {sub && <p className="scr-sub">{sub}</p>}
    </header>
  )
}

function ConnectButton({ label, hint, run }: { label: string; hint: string; run: () => Promise<UiError | null> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)
  return (
    <div className="connect">
      <Button
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const e = await run()
          setBusy(false)
          if (e) setError(e)
        }}
      >
        {busy && <Spinner />}
        {label}
      </Button>
      <p className="connect-hint">{hint}</p>
      {error && (
        <p className="err" role="alert">
          {t(error.messageKey)}
        </p>
      )}
    </div>
  )
}

// Asking for the Polygon address is a tap of its own, never folded into another dialog.
export function ConnectEvm() {
  const app = useApp()
  return <ConnectButton label={t('connect.evm')} hint={t('connect.evmHint')} run={app.connectEvm} />
}

export function ConnectNim() {
  const app = useApp()
  return <ConnectButton label={t('connect.nim')} hint={t('connect.nimHint')} run={app.connectNim} />
}

export function TestnetBadge() {
  const app = useApp()
  return app.network === 'testnet' ? <span className="badge">{t('status.testnet')}</span> : null
}

// Testnet has no Payout Check, so a pool there is "not checked", not "not enough data yet".
export function PoolVerdict({ verdict, size }: { verdict: Verdict | null; size?: 'md' | 'lg' }) {
  const app = useApp()
  const label = app.network === 'testnet' && !verdict ? t('check.testnetBadge') : undefined
  return <VerdictBadge verdict={verdict} {...(size ? { size } : {})} {...(label ? { label } : {})} />
}
