import { POLYGON, VERDICTS } from '@accrue/shared'
import { useEffect, useRef } from 'react'
import { t } from '../i18n'
import { Card, VerdictGlyph } from '../ui/components'
import { ExtLink } from '../ui/components/Fields'
import { useApp } from './context'
import { ScreenHead } from './parts'

export const REPO_URL = 'https://github.com/RaYYeR220/accrue'

const RISKS = ['contract', 'rate', 'exit', 'unstake', 'pools'] as const

export function About() {
  const app = useApp()
  const method = useRef<HTMLElement>(null)

  useEffect(() => {
    const i = app.takeIntent()
    if (i && 'section' in i) method.current?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <div className="screen about">
      <ScreenHead title={t('about.title')} sub={t('about.sub')} />

      <section className="block" aria-labelledby="risks-h">
        <h2 className="block-h" id="risks-h">
          {t('about.risks')}
        </h2>
        <Card tone="quiet">
          <dl className="prose-list">
            {RISKS.map(r => (
              <div key={r}>
                <dt>{t(`about.risk.${r}`)}</dt>
                <dd>{t(`about.risk.${r}.body`)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <section className="block" aria-labelledby="data-h">
        <h2 className="block-h" id="data-h">
          {t('about.data')}
        </h2>
        <Card tone="quiet">
          <dl className="prose-list">
            <div>
              <dt>{t('about.data.phone')}</dt>
              <dd>{t('about.data.phoneBody')}</dd>
            </div>
            <div>
              <dt>{t('about.data.server')}</dt>
              <dd>{t('about.data.serverBody')}</dd>
            </div>
            <div>
              <dt>{t('about.data.never')}</dt>
              <dd>{t('about.data.neverBody')}</dd>
            </div>
          </dl>
        </Card>
      </section>

      <section className="block" aria-labelledby="method-h" ref={method}>
        <h2 className="block-h" id="method-h">
          {t('about.method')}
        </h2>
        <Card tone="quiet">
          <p>{t('about.methodBody')}</p>
          <ul className="legend">
            {VERDICTS.map(v => (
              <li key={v}>
                <VerdictGlyph verdict={v} />
                <span>
                  <b>{t(`verdict.${v}`)}</b> {t(`verdict.${v}.desc`)}
                </span>
              </li>
            ))}
            <li>
              <VerdictGlyph verdict="NOT_ENOUGH_DATA" />
              <span>
                <b>{t('verdict.pending')}</b> {t('about.pendingDesc')}
              </span>
            </li>
          </ul>
          <ExtLink href={`${REPO_URL}/blob/main/METHODOLOGY.md`}>{t('about.methodFull')}</ExtLink>
        </Card>
      </section>

      <section className="block" aria-labelledby="src-h">
        <h2 className="block-h" id="src-h">
          {t('about.source')}
        </h2>
        <Card tone="quiet">
          <p>{t('about.sourceBody')}</p>
          <p className="links">
            <ExtLink href={REPO_URL}>{t('about.repo')}</ExtLink>
            {POLYGON.router && <ExtLink href={`https://polygonscan.com/address/${POLYGON.router}#code`}>{t('about.router')}</ExtLink>}
          </p>
        </Card>
      </section>
    </div>
  )
}
