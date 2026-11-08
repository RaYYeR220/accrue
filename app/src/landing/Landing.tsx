import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useFiat } from '../fiat/useFiat'
import { currentLang, t } from '../i18n'
import '../ui/components'
import { fetchPools, type PoolsData } from './data'
import { HowItWorks } from './HowItWorks'
import './landing.css'
import { Orbit, type OrbitApi } from './Orbit'
import { toOrbitPool } from './orbit/model'
import { OpenLink, QrDialog } from './OpenInApp'
import { Closing, Footer, Nav, PayoutCheck, Risks, Trust } from './Sections'
import { SNAPSHOT } from './snapshot'
import { loadLandingStrings } from './strings'

// Live pool rows from our API; until it answers (or if it can't), the dated snapshot.
function usePools(): PoolsData {
  const q = useQuery({ queryKey: ['pools'], queryFn: fetchPools, staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false })
  return q.data ?? SNAPSHOT
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function ready(): Promise<void> {
  return loadLandingStrings(currentLang())
}

export function Landing() {
  const data = usePools()
  const fiat = useFiat()
  const orbitPools = useMemo(() => data.pools.map(toOrbitPool), [data])
  const orbit = useRef<OrbitApi | null>(null)
  const [qrFrom, setQrFrom] = useState<HTMLElement | null>(null)
  const [qrOpen, setQrOpen] = useState(false)

  useEffect(() => {
    document.title = t('landing.meta.title')
  }, [])

  const showQr = useCallback((from: HTMLElement) => {
    setQrFrom(from)
    setQrOpen(true)
  }, [])

  const showPool = useCallback((address: string) => {
    document.getElementById('top')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
    window.setTimeout(() => orbit.current?.select(address), reduceMotion() ? 0 : 350)
  }, [])

  return (
    <div className="landing">
      <div className="grain" aria-hidden="true" />
      <Nav onShowQr={showQr} />
      <main>
        <section className="hero wrap" aria-labelledby="hero-title">
          <div className="hero-text">
            <h1 className="display reveal" id="hero-title" style={{ '--d': '.05s' } as CSSProperties}>
              {t('landing.hero.title')}
            </h1>
            <p className="sub reveal" style={{ '--d': '.12s' } as CSSProperties}>
              {t('landing.hero.sub')}
              <span className="hide-s">{t('landing.hero.subTail')}</span>
              {t('landing.hero.subEnd')}
            </p>
            <div className="ctas reveal" style={{ '--d': '.18s' } as CSSProperties}>
              <OpenLink onShowQr={showQr} />
              <a className="btn btn-ghost" href="#check">
                {t('landing.cta.check')}
              </a>
            </div>
            <p className="proof reveal" style={{ '--d': '.24s' } as CSSProperties}>
              {t('landing.hero.proof', { n: data.pools.length })}
            </p>
          </div>
          <Orbit pools={orbitPools} fiat={fiat} apiRef={orbit} />
        </section>
        <HowItWorks poolCount={data.pools.length} />
        <PayoutCheck data={data} onShowPool={showPool} />
        <Risks />
        <Trust />
        <Closing onShowQr={showQr} />
      </main>
      <Footer />
      <QrDialog open={qrOpen} onClose={() => setQrOpen(false)} returnTo={qrFrom} />
    </div>
  )
}
