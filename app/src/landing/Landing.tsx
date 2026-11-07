import { t } from '../i18n'

// Outside Nimiq Pay. Nimiq Pay opens mini apps by host name only.
export function Landing() {
  const href = `https://nimpay.app/miniapps/open/${location.host}`
  return (
    <main className="shell landing">
      <h1>{t('app.name')}</h1>
      <p>{t('app.tagline')}</p>
      <h2>{t('landing.title')}</h2>
      <p>{t('landing.body')}</p>
      <a className="button" href={href}>
        {t('landing.open')}
      </a>
    </main>
  )
}
