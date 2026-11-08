import { lazy, Suspense } from 'react'
import type { Mode } from './boot'
import { t } from './i18n'

// Two separate chunks: the wallet side (SDK, viem, providers) for Nimiq Pay, and the landing
// for ordinary browsers. Neither ever downloads the other.
export const loadMiniApp = () =>
  import('./MiniApp').then(async m => {
    await m.ready()
    return m
  })
export const loadLanding = () =>
  import('./landing/Landing').then(async m => {
    await m.ready()
    return m
  })

const MiniApp = lazy(loadMiniApp)
const Landing = lazy(() => loadLanding().then(m => ({ default: m.Landing })))

export function App({ mode }: { mode: Mode }) {
  if (mode === 'landing') {
    return (
      <Suspense fallback={null}>
        <Landing />
      </Suspense>
    )
  }
  return (
    <Suspense fallback={<p className="boot-hint">{t('status.loading')}</p>}>
      <MiniApp />
    </Suspense>
  )
}
