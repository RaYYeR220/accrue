import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import type { FiatApi } from '../fiat/useFiat'
import { t } from '../i18n'
import { Chip } from '../ui/components'
import { fmtFee, fmtNum } from './format'
import { makeOrbitCopy, schedText } from './orbit/copy'
import { chipPools, defaultPoolId, type OrbitPool } from './orbit/model'
import { createOrbit, type OrbitHandle } from './orbit/scene'

export interface OrbitApi {
  select(id: string): void
}

const SLIDER_START = 100
// 1,000 to 1,000,000 NIM on a log scale, snapped to 1 / 2 / 2.5 / 5
const nice = (x: number) => {
  const q = Math.pow(10, Math.floor(Math.log10(x)))
  const m = x / q
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * q
}
const stakeOf = (v: number) => Math.min(1e6, nice(1000 * Math.pow(10, v / 100)))

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function Orbit({ pools, fiat, apiRef }: { pools: OrbitPool[]; fiat: FiatApi; apiRef: MutableRefObject<OrbitApi | null> }) {
  const disc = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const core = useRef<HTMLDivElement>(null)
  const coreN = useRef<HTMLElement>(null)
  const coreFiat = useRef<HTMLElement>(null)
  const chip = useRef<HTMLDivElement>(null)
  const chipK = useRef<HTMLSpanElement>(null)
  const chipV = useRef<HTMLElement>(null)
  const chipW = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const week = useRef<HTMLSpanElement>(null)
  const pline = useRef<HTMLParagraphElement>(null)
  const handle = useRef<OrbitHandle | null>(null)

  const [selected, setSelected] = useState<string | null>(() => defaultPoolId(pools))
  const [slider, setSlider] = useState(SLIDER_START)
  // the rates refetch every few minutes; the copy only changes when the price of a NIM does
  const nimPrice = fiat.nimToFiat(100_000n)
  const copy = useMemo(() => makeOrbitCopy(fiat), [fiat.fiat, nimPrice])
  const chips = useMemo(() => chipPools(pools), [pools])
  const stake = stakeOf(slider)
  const stakeText = `${fmtNum(stake)} NIM`
  const inChips = chips.some(c => c.pool.id === selected)

  useEffect(() => {
    const els = [disc, canvas, core, coreN, coreFiat, chip, chipK, chipV, chipW, tip, week, pline].map(r => r.current)
    if (els.some(e => !e)) return
    const h = createOrbit(
      {
        disc: disc.current!,
        canvas: canvas.current!,
        core: core.current!,
        coreN: coreN.current!,
        coreFiat: coreFiat.current!,
        chip: chip.current!,
        chipK: chipK.current!,
        chipV: chipV.current!,
        chipW: chipW.current!,
        tip: tip.current!,
        week: week.current!,
        pline: pline.current!,
      },
      pools,
      selected,
      { reduce: reducedMotion(), copy, onSelect: setSelected },
    )
    handle.current = h
    apiRef.current = { select: id => h.select(id) }
    return () => {
      h.destroy()
      handle.current = null
      apiRef.current = null
    }
    // created once; later prop changes are pushed into the running scene below
  }, [])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    handle.current?.setPools(pools, null)
  }, [pools])

  useEffect(() => {
    handle.current?.setCopy(copy)
  }, [copy])

  return (
    <div className="obj reveal" style={{ '--d': '.3s' } as CSSProperties} role="group" aria-label={t('landing.orbit.aria', { n: pools.length })}>
      <div className="disc" ref={disc}>
        <canvas ref={canvas} className="orbit-canvas" />
        <div className="core" ref={core} aria-hidden="true">
          <b ref={coreN} />
          <span>{t('landing.orbit.core')}</span>
          <em ref={coreFiat} />
        </div>
        <div className="ring-chip" ref={chip} aria-hidden="true">
          <span className="k" ref={chipK} />
          <b ref={chipV} />
          <span className="w" ref={chipW} />
        </div>
        <div className="tip" ref={tip} aria-live="polite" />
        <span className="week" ref={week} aria-hidden="true">
          {t('landing.orbit.week', { n: 7 })}
        </span>
      </div>
      <div className="ctl">
        <div className="pools" role="group" aria-label={t('landing.orbit.poolGroup')}>
          {chips.map(c => (
            <Chip key={c.pool.id} pressed={selected === c.pool.id} title={`${fmtFee(c.pool.fee)} · ${schedText(c.pool)}`} onClick={() => handle.current?.select(c.pool.id)}>
              {c.short}
            </Chip>
          ))}
          <select
            className={inChips ? 'pool-sel' : 'pool-sel on'}
            aria-label={t('landing.orbit.allPools', { n: pools.length })}
            value={inChips || !selected ? '' : selected}
            onChange={e => {
              if (e.target.value) handle.current?.select(e.target.value)
            }}
          >
            <option value="">{t('landing.orbit.allPools', { n: pools.length })}</option>
            {pools.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <p className="pline" ref={pline} aria-live="polite" />
        <label className="stake">
          <span>{t('landing.orbit.stake')}</span>
          <input
            type="range"
            min={0}
            max={300}
            value={slider}
            aria-label={t('landing.orbit.stakeAria')}
            aria-valuetext={stakeText}
            onChange={e => {
              const v = Number(e.target.value)
              setSlider(v)
              handle.current?.setStake(stakeOf(v))
            }}
          />
          <output>{stakeText}</output>
        </label>
        <p className="legend">
          <span>
            <i className="solid" />
            {t('landing.orbit.legendLanded')}
          </span>
          <span>
            <i className="dash" />
            {t('landing.orbit.legendExpected')}
          </span>
        </p>
      </div>
    </div>
  )
}
