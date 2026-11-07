import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, loadMiniApp } from './App'
import { detectMode } from './boot'
import { currentLang } from './i18n'

async function start() {
  // Compiled out of production builds together with the mock module.
  if (import.meta.env.DEV && location.search.includes('mock=')) {
    const { installMock } = await import('./mock/installMock')
    installMock(location.search)
  }
  const mode = detectMode(window)
  // start fetching the wallet chunk while React renders the fallback
  if (mode === 'app') void loadMiniApp()
  document.documentElement.lang = currentLang()
  const queryClient = new QueryClient()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App mode={mode} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void start()
