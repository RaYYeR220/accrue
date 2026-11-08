import type { Verdict } from '@accrue/shared'
import { createElement } from 'react'
import { t } from '../../i18n'
import { VERDICT_GLYPHS } from './glyphs'

export function VerdictGlyph({ verdict, className = 'vg' }: { verdict: Verdict; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      {VERDICT_GLYPHS[verdict].map((s, i) => createElement(s.tag, { key: i, ...s.attrs }))}
    </svg>
  )
}

// The neutral verdict label with its glyph. `label` overrides the text, e.g. "Not enough data yet"
// for a pool the indexer hasn't reached.
export function VerdictBadge({ verdict, label, size = 'md' }: { verdict: Verdict; label?: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`vd vd-${size}`} data-verdict={verdict}>
      <VerdictGlyph verdict={verdict} />
      <span>{label ?? t(`verdict.${verdict}`)}</span>
    </span>
  )
}
