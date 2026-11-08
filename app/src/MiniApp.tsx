import { useEffect, useRef } from 'react'
import { flowConfig } from './features/dollars/flow'
import { currentLang, t } from './i18n'
import { Activity } from './screens/Activity'
import { AppProvider, useApp, type Route } from './screens/context'
import { Dollars } from './screens/Dollars'
import { Home } from './screens/Home'
import { Brand, InfoIcon, TabIcon } from './screens/icons'
import { Nim } from './screens/Nim'
import { Onboarding } from './screens/Onboarding'
import { PayoutCheck } from './screens/PayoutCheck'
import { loadAppStrings } from './screens/strings'
import './screens/app.css'

// The dev mock stands in for the router until one is deployed (compiled out of production).
if (import.meta.env.DEV && window.__accrueMock && !flowConfig.router) flowConfig.router = window.__accrueMock.router

export function ready(): Promise<void> {
  return loadAppStrings(currentLang())
}

const TABS: Exclude<Route, 'about'>[] = ['home', 'dollars', 'nim', 'payouts', 'activity']

function Screen({ route }: { route: Route }) {
  switch (route) {
    case 'about':
    case 'home':
      return <Home />
    case 'dollars':
      return <Dollars />
    case 'nim':
      return <Nim />
    case 'payouts':
      return <PayoutCheck />
    case 'activity':
      return <Activity />
  }
}

function Shell() {
  const app = useApp()
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)

  useEffect(() => {
    document.title = t('app.name')
  }, [])

  // moving between tabs puts focus on the new screen's heading, not back at the top of the page
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [app.route])

  if (!app.started) return <Onboarding />

  return (
    <div className="app">
      <header className="top">
        <a className="top-brand" href="#" aria-label={t('top.home')} onClick={e => (e.preventDefault(), app.go('home'))}>
          <Brand />
        </a>
        <div className="top-end">
          {app.network === 'testnet' && <span className="badge">{t('status.testnet')}</span>}
          <a
            className={app.route === 'about' ? 'top-about is-on' : 'top-about'}
            href="#about"
            aria-label={t('top.about')}
            aria-current={app.route === 'about' ? 'page' : undefined}
            onClick={e => (e.preventDefault(), app.go('about'))}
          >
            <InfoIcon />
          </a>
        </div>
      </header>
      <main className="main" ref={main}>
        <Screen route={app.route} />
      </main>
      <nav className="tabbar" aria-label={t('tab.label')}>
        {TABS.map(r => (
          <a key={r} className="tab" href={r === 'home' ? '#' : `#${r}`} aria-current={app.route === r ? 'page' : undefined} onClick={e => (e.preventDefault(), app.go(r))}>
            <TabIcon route={r} />
            <span>{t(`tab.${r}`)}</span>
          </a>
        ))}
      </nav>
    </div>
  )
}

export default function MiniApp() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
