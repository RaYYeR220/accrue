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

// The neutral verdict label with its glyph. `null` means the API has given no verdict yet: it
// reads "Not enough data yet" and carries no verdict code.
export function VerdictBadge({ verdict, label, size = 'md' }: { verdict: Verdict | null; label?: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`vd vd-${size}`} data-verdict={verdict ?? 'pending'}>
      <VerdictGlyph verdict={verdict ?? 'NOT_ENOUGH_DATA'} />
      <span>{label ?? (verdict ? t(`verdict.${verdict}`) : t('verdict.pending'))}</span>
    </span>
  )
}
