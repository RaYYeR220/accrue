import { lazy, Suspense } from 'react'
import type { Mode } from './boot'
import { t } from './i18n'
import { Landing } from './landing/Landing'

// The wallet side (SDK, viem, providers) is its own chunk, so the landing page
// served to ordinary browsers never downloads it.
export const loadMiniApp = () => import('./MiniApp')
const MiniApp = lazy(loadMiniApp)

export function App({ mode }: { mode: Mode }) {
  if (mode === 'landing') return <Landing />
  return (
    <Suspense fallback={<p className="shell hint">{t('status.loading')}</p>}>
      <MiniApp />
    </Suspense>
  )
}
