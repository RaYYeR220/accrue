import type { Verdict } from '@accrue/shared'

export interface GlyphShape {
  tag: 'circle' | 'path'
  attrs: Record<string, string>
}

const ring = (extra: Record<string, string> = {}): GlyphShape => ({
  tag: 'circle',
  attrs: { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', ...extra },
})
const line = (d: string, extra: Record<string, string> = {}): GlyphShape => ({
  tag: 'path',
  attrs: { d, fill: 'none', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', ...extra },
})

// 16×16 line glyphs, one per verdict, drawn in currentColor.
export const VERDICT_GLYPHS: Record<Verdict, GlyphShape[]> = {
  PAID_AS_PROMISED: [ring(), { tag: 'circle', attrs: { cx: '8', cy: '8', r: '3', fill: 'currentColor' } }],
  BEHIND_SCHEDULE: [ring(), line('M8 4.2V8l2.6 1.7')],
  SHORT: [ring({ opacity: '.35' }), line('M8 1.8A6.2 6.2 0 1 1 1.8 8', { strokeLinecap: 'butt' })],
  NOT_ENOUGH_DATA: [ring({ strokeWidth: '1.3', strokeDasharray: '1 2.2', strokeLinecap: 'round' })],
  NO_PAYOUTS_BY_DESIGN: [ring(), line('M5.2 8h5.6')],
  CANT_VERIFY_ROUTED: [line('M12.9 5.2A6.2 6.2 0 1 0 14.2 8', { strokeLinecap: 'butt' }), line('M8 8l6-6M10.6 2h3.4v3.4', { strokeLinejoin: 'round' })],
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const kebab = (k: string) => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

// For code that builds DOM by hand (the hero's canvas overlays).
export function glyphElement(v: Verdict, className = 'vg'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  for (const s of VERDICT_GLYPHS[v]) {
    const el = document.createElementNS(SVG_NS, s.tag)
    for (const [k, val] of Object.entries(s.attrs)) el.setAttribute(kebab(k), val)
    svg.appendChild(el)
  }
  return svg
}
