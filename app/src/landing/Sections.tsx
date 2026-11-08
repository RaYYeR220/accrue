import { POLYGON, VERDICTS } from '@accrue/shared'
import { LANGS, currentLang, t, type Lang } from '../i18n'
import { VerdictGlyph } from '../ui/components'
import { Checker } from './Checker'
import type { PoolsData } from './data'
import { InlineQr, OpenLink, useDesktop } from './OpenInApp'
import { Scoreboard } from './Scoreboard'

export const REPO_URL = 'https://github.com/RaYYeR220/accrue'

export function Brand() {
  return (
    <a className="brand" href="#top">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.4" fill="var(--accent)" />
        <circle cx="10" cy="10" r="5.8" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.6" />
      </svg>
      Accrue
    </a>
  )
}

export function Nav({ onShowQr }: { onShowQr: (from: HTMLElement) => void }) {
  return (
    <header className="wrap nav reveal" id="top">
      <Brand />
      <nav className="nav-links" aria-label={t('landing.nav.sections')}>
        <a href="#how">{t('landing.nav.how')}</a>
        <a href="#check">{t('landing.nav.check')}</a>
        <a href="#risks">{t('landing.nav.risks')}</a>
        <a href="#trust">{t('landing.nav.source')}</a>
      </nav>
      <OpenLink variant="ghost" className="nav-cta" onShowQr={onShowQr} />
    </header>
  )
}

export function PayoutCheck({ data, onShowPool }: { data: PoolsData; onShowPool: (address: string) => void }) {
  return (
    <section className="section" id="check" aria-labelledby="check-title">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <p className="eyebrow">{t('landing.check.eyebrow')}</p>
            <h2 className="h2" id="check-title">
              {t('landing.check.title')}
            </h2>
          </div>
          <p className="lede">{t('landing.check.lede')}</p>
        </div>

        <Checker poolCount={data.pools.length} />

        <div className="er">
          <div className="er-col">
            <h3>
              <i className="dash" />
              {t('landing.check.expected.title')}
            </h3>
            <p>{t('landing.check.expected.body')}</p>
            <p className="formula">{t('landing.check.expected.formula')}</p>
          </div>
          <div className="er-col">
            <h3>
              <i className="solid" />
              {t('landing.check.received.title')}
            </h3>
            <p>{t('landing.check.received.body')}</p>
            <p className="formula">{t('landing.check.received.formula')}</p>
          </div>
        </div>

        <ul className="verdicts" aria-label={t('landing.check.verdicts')}>
          {VERDICTS.map(v => (
            <li key={v}>
              <span>
                <VerdictGlyph verdict={v} />
              </span>
              <div>
                <b>{t(`verdict.${v}`)}</b>
                <p>{t(`verdict.${v}.desc`)}</p>
              </div>
            </li>
          ))}
        </ul>

        <Scoreboard data={data} onShowPool={onShowPool} />
      </div>
    </section>
  )
}

export function Risks() {
  const items = ['r1', 'r2', 'r3', 'r4', 'r5'] as const
  return (
    <section className="section" id="risks" aria-labelledby="risks-title">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <p className="eyebrow">{t('landing.risks.eyebrow')}</p>
            <h2 className="h2" id="risks-title">
              {t('landing.risks.title')}
            </h2>
          </div>
          <p className="lede">{t('landing.risks.lede')}</p>
        </div>
        <ul className="risks">
          {items.map(r => (
            <li key={r}>
              <b>{t(`landing.risks.${r}.title`)}</b>
              <p>{t(`landing.risks.${r}.body`)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export function Trust() {
  const items = ['t1', 't2', 't3', 't4'] as const
  const router = POLYGON.router
  return (
    <section className="section" id="trust" aria-labelledby="trust-title">
      <div className="wrap">
        <div className="trust">
          <div className="trust-head">
            <p className="eyebrow">{t('landing.trust.eyebrow')}</p>
            <h2 className="h2" id="trust-title">
              {t('landing.trust.title')}
            </h2>
          </div>
          <ul className="trust-list">
            {items.map(k => (
              <li key={k}>
                <b>{t(`landing.trust.${k}.title`)}</b>
                <p>{t(`landing.trust.${k}.body`)}</p>
              </li>
            ))}
          </ul>
          <p className="trust-note">
            {router ? (
              <>
                {t('landing.trust.noteLive', { address: router })}{' '}
                <a href={`https://polygonscan.com/address/${router}#code`} rel="noopener">
                  {t('landing.trust.verified')}
                </a>
                {' · '}
              </>
            ) : (
              <>{t('landing.trust.notePending')} </>
            )}
            <a href={REPO_URL} rel="noopener">
              {t('landing.trust.source')}
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}

export function Closing({ onShowQr }: { onShowQr: (from: HTMLElement) => void }) {
  const desktop = useDesktop()
  return (
    <section className="closing" id="open" aria-labelledby="open-title">
      <div className="wrap closing-in">
        <h2 className="h2" id="open-title">
          {t('landing.hero.title')}
        </h2>
        <p className="sub">{t('landing.closing.sub')}</p>
        <div className="ctas">
          <OpenLink onShowQr={onShowQr} />
          <a className="btn btn-ghost" href="#check">
            {t('landing.cta.check')}
          </a>
        </div>
        {desktop && <InlineQr />}
      </div>
    </section>
  )
}

const LANG_NAMES: Record<Lang, string> = { en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', pt: 'Português' }

export function Footer() {
  const lang = currentLang()
  return (
    <footer className="wrap foot">
      <Brand />
      <nav className="foot-links" aria-label={t('landing.foot.nav')}>
        <a href="#check">{t('landing.foot.methodology')}</a>
        <a href="#risks">{t('landing.foot.risks')}</a>
        <a href={REPO_URL} rel="noopener">
          {t('landing.foot.source')}
        </a>
      </nav>
      <p className="foot-note">
        {t('landing.foot.note')} {t('landing.foot.privacy')}
      </p>
      <nav className="foot-lang" aria-label={t('landing.foot.lang')}>
        {LANGS.map(l => (
          <a key={l} href={`?lang=${l}`} lang={l} hrefLang={l} aria-current={l === lang ? 'true' : undefined}>
            {LANG_NAMES[l]}
          </a>
        ))}
      </nav>
    </footer>
  )
}
