import { useState } from 'react'
import { t } from '../i18n'
import type { UiError } from '../providers/errors'
import { Button } from '../ui/components'
import { Spinner } from '../ui/components/Fields'
import { useApp } from './context'
import { Brand, Rings } from './icons'

// One screen, one tap. Start asks Nimiq Pay for the NIM address only; the Polygon wallet is its
// own tap later, where dollars need it, so no tap ever opens two dialogs.
export function Onboarding() {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  async function start() {
    setBusy(true)
    setError(null)
    const e = await app.start()
    setBusy(false)
    if (e) setError(e)
  }

  return (
    <main className="onb">
      <div className="onb-top">
        <Brand />
        {app.network === 'testnet' && <span className="badge">{t('status.testnet')}</span>}
      </div>
      <Rings />
      <h1 className="onb-title">{t('onb.title')}</h1>
      <p className="onb-sub">{t('onb.sub')}</p>
      <ul className="onb-list">
        <li>{t('onb.p1')}</li>
        <li>{t('onb.p2')}</li>
        <li>{t('onb.p3')}</li>
      </ul>
      <div className="onb-cta">
        <Button block onClick={start} disabled={busy} aria-busy={busy || undefined}>
          {busy && <Spinner />}
          {t('onb.start')}
        </Button>
        <p className="onb-note">{t('onb.note')}</p>
        {error && (
          <p className="onb-err" role="alert">
            {t(error.messageKey)}
          </p>
        )}
      </div>
    </main>
  )
}
