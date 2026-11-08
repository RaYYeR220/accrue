import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { t } from '../i18n'
import { ButtonLink, type ButtonVariant } from '../ui/components'
import { Qr } from './Qr'

// Nimiq Pay opens a mini app by its host name.
export const deepLink = () => `https://nimpay.app/miniapps/open/${location.host}`

const DESKTOP = '(hover: hover) and (pointer: fine)'
const subscribe = (cb: () => void) => {
  const m = matchMedia(DESKTOP)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}
export const useDesktop = () => useSyncExternalStore(subscribe, () => matchMedia(DESKTOP).matches, () => false)

// On a phone the link opens Nimiq Pay. On a computer there is no Nimiq Pay to open, so a click
// shows the same link as a QR code to scan instead.
export function OpenLink({
  variant = 'primary',
  className,
  onShowQr,
  children,
}: {
  variant?: ButtonVariant
  className?: string
  onShowQr: (from: HTMLElement) => void
  children?: ReactNode
}) {
  return (
    <ButtonLink
      variant={variant}
      className={className}
      href={deepLink()}
      onClick={e => {
        if (!matchMedia(DESKTOP).matches || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        onShowQr(e.currentTarget)
      }}
    >
      {children ?? t('landing.cta.open')}
    </ButtonLink>
  )
}

export function QrDialog({ open, onClose, returnTo }: { open: boolean; onClose: () => void; returnTo: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null)
  const url = deepLink()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) {
      d.close()
      returnTo?.focus()
    }
  }, [open, returnTo])

  return (
    <dialog
      ref={ref}
      className="qr-dialog"
      aria-labelledby="qr-title"
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {open && (
        <div className="qr-card">
          <Qr text={url} label={t('landing.qr.label', { url })} className="qr-lg" />
          <div className="qr-text">
            <h2 id="qr-title">{t('landing.qr.title')}</h2>
            <p>{t('landing.qr.body')}</p>
            <a className="qr-link" href={url}>
              {t('landing.qr.orOpen')}
            </a>
          </div>
          <button type="button" className="qr-close" onClick={onClose} aria-label={t('landing.qr.close')}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </dialog>
  )
}

// The closing section on a computer: the code is simply there, no click needed.
export function InlineQr() {
  const url = deepLink()
  return (
    <div className="qr-inline">
      <Qr text={url} label={t('landing.qr.label', { url })} />
      <p>
        <b>{t('landing.qr.title')}</b>
        <span>{t('landing.qr.body')}</span>
      </p>
    </div>
  )
}
