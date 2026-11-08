import { lunaToNim } from '@accrue/shared'
import { useRef, useState } from 'react'
import './app.css'
import { useFiat } from './fiat/useFiat'
import { t } from './i18n'
import { toUiError, type UiError } from './providers/errors'
import { evm } from './providers/evm'
import { nimiq, type NimBalances } from './providers/nimiq'

// Placeholder shell: proves the provider plumbing end to end. Screens replace it later.
export default function MiniApp() {
  const fiat = useFiat()
  const [nim, setNim] = useState<NimBalances | null>(null)
  const [usdt, setUsdt] = useState<bigint | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [busy, setBusy] = useState(false)
  const last = useRef<() => Promise<void>>(async () => {})
  const testnet = window.nimiqPay?.network === 'testnet'

  // Provider calls happen only inside tap handlers, never on mount.
  async function run(action: () => Promise<void>) {
    last.current = action
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(toUiError(e))
    } finally {
      setBusy(false)
    }
  }

  const showNim = () =>
    run(async () => {
      await nimiq.connect()
      setNim(await nimiq.balances())
    })

  const showDollars = () =>
    run(async () => {
      const owner = await evm.connect()
      setUsdt(await evm.tokenBalance('USDT0', owner))
    })

  return (
    <main className="shell">
      <header>
        <h1>{t('app.name')}</h1>
        {testnet && <span className="badge">{t('status.testnet')}</span>}
      </header>
      <h2>{t('onboarding.title')}</h2>
      <p>{t('onboarding.body')}</p>
      <p className="hint">{t('onboarding.noPromptYet')}</p>

      <section>
        <button type="button" disabled={busy} onClick={showNim}>
          {t('action.connectNim')}
        </button>
        <p className="hint">{t('onboarding.nimHint')}</p>
        {nim && (
          <p>
            {t('status.nimBalance', { amount: lunaToNim(nim.total) })}{' '}
            <span className="hint">{t('status.worth', { amount: fiat.format(fiat.nimToFiat(nim.total)) })}</span>
          </p>
        )}
      </section>

      <section>
        <button type="button" disabled={busy} onClick={showDollars}>
          {t('action.connectDollars')}
        </button>
        <p className="hint">{t('onboarding.dollarsHint')}</p>
        {usdt !== null && (
          <p>
            {t('status.tokenBalance', { amount: (Number(usdt) / 1e6).toFixed(2), asset: 'USDT' })}{' '}
            <span className="hint">{t('status.worth', { amount: fiat.format(fiat.toFiat(Number(usdt) / 1e6)) })}</span>
          </p>
        )}
      </section>

      {busy && <p className="hint">{t('status.loading')}</p>}
      {error && (
        <div role="alert" className="error">
          <p>{t(error.messageKey)}</p>
          {error.retry === 'same' && (
            <button type="button" onClick={() => run(last.current)}>
              {t('action.retry')}
            </button>
          )}
        </div>
      )}
    </main>
  )
}
