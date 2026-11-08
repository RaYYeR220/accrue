// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFiat } from '../src/fiat/useFiat'
import { extendDicts } from '../src/i18n'
import en from '../src/landing/i18n/en.json'
import { makeOrbitCopy } from '../src/landing/orbit/copy'
import { toOrbitPool, type OrbitPool } from '../src/landing/orbit/model'
import { createOrbit, type OrbitDom, type OrbitHandle } from '../src/landing/orbit/scene'
import { SNAPSHOT } from '../src/landing/snapshot'

extendDicts({ en })

const calls = { arc: 0, stroke: 0 }
const fakeCtx = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (k === 'arc' ? () => calls.arc++ : k === 'stroke' ? () => calls.stroke++ : () => undefined),
      set: () => true,
    },
  )

let frames: FrameRequestCallback[] = []
let clock = 1000
let handle: OrbitHandle | null = null

function step(ms: number) {
  clock += ms
  const run = frames
  frames = []
  for (const cb of run) cb(clock)
}

function dom(): OrbitDom {
  const el = (tag = 'div') => document.createElement(tag)
  const disc = el()
  Object.defineProperty(disc, 'clientWidth', { value: 600 })
  return {
    disc,
    canvas: el('canvas') as HTMLCanvasElement,
    core: el(),
    coreN: el('b'),
    coreFiat: el('em'),
    chip: el(),
    chipK: el('span'),
    chipV: el('b'),
    chipW: el('span'),
    tip: el(),
    week: el('span'),
    pline: el('p'),
  }
}

const rates = (nimUsd: number) => makeFiat('USD', { asOf: 1, nimUsd, fx: { USD: 1 }, source: [] }, false, 'en')
const pools = SNAPSHOT.pools.map(toOrbitPool)
const byName = (list: OrbitPool[], n: string) => list.find(p => p.name === n)!
const ticker = (d: OrbitDom) => [...d.coreN.querySelectorAll('.slot')].map(s => s.lastChild?.textContent ?? '').join('')

function start(list: OrbitPool[], name: string, d = dom(), nimUsd = 0.00027882) {
  handle = createOrbit(d, list, byName(list, name).id, { reduce: false, copy: makeOrbitCopy(rates(nimUsd)), onSelect: () => undefined })
  return d
}

beforeEach(() => {
  calls.arc = 0
  calls.stroke = 0
  frames = []
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never
})

afterEach(() => {
  handle?.destroy()
  handle = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('orbit scene', () => {
  it('a pool whose fee keeps everything does not break the animation', () => {
    for (const name of ['NimiqPocket', 'Garuda Pool', 'NimiqHub Staking']) {
      const list = pools.map(p => (p.name === name ? { ...p, fee: 1 } : p))
      const d = start(list, name)
      expect(() => {
        for (let i = 0; i < 80; i++) step(50)
      }).not.toThrow()
      expect(ticker(d)).toBe('10,000.00')
      expect(d.coreN.textContent + d.coreFiat.textContent + d.chipV.textContent).not.toMatch(/NaN|Infinity/)
      expect(d.chipV.textContent).toBe('Nothing left to pass on')
      expect(frames.length).toBe(1)
      handle!.destroy()
    }
  })

  it('draws a bounded number of dots even when a pool claims 200,000 stakers', () => {
    const list = [...pools, { ...pools[0]!, id: 'NQ00 HUGE', name: 'Huge', stakers: 200_000 }]
    start(list, 'Garuda Pool')
    calls.arc = 0
    step(16)
    // 1,500 dots at most, plus rings, the stake disc and markers
    expect(calls.arc).toBeLessThan(1500 + 300)
  })

  it('strokes the rings of one style together, not one by one', () => {
    start(pools, 'Nimiq Marketing Pool')
    calls.stroke = 0
    step(16)
    expect(calls.stroke).toBeLessThan(60)
  })

  it('new rates refresh the text without restarting the payout week', () => {
    const d = start(pools, 'Garuda Pool')
    expect(ticker(d)).toBe('10,008.33')
    for (let i = 0; i < 60; i++) step(50)
    const landed = ticker(d)
    expect(landed).toBe('10,009.37')
    handle!.setCopy(makeOrbitCopy(rates(0.0003)))
    step(16)
    expect(ticker(d)).toBe(landed)
    expect(d.coreFiat.textContent).toBe('≈ $3.00')
  })

  it('a pool that lists no payouts is described as a fact, not with a verdict label', () => {
    const d = start(pools, 'Private Whalidator')
    step(16)
    expect([d.chipK.textContent, d.chipV.textContent, d.chipW.textContent]).toEqual(['payouts', 'None listed', 'fee not listed'])
    expect(d.chipW.textContent!.toLowerCase()).not.toContain('by design')
  })
})
