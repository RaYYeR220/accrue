import type { ReactNode } from 'react'

// A figure with its unit. Digits are tabular so live values don't jitter as they change.
export function Amount({ value, unit, size = 'md', className }: { value: string; unit?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  return (
    <span className={['amount', `amount-${size}`, className ?? ''].filter(Boolean).join(' ')}>
      <span className="amount-v">{value}</span>
      {unit && <span className="amount-u">{unit}</span>}
    </span>
  )
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-k">{label}</span>
      <span className="stat-v">{value}</span>
      {sub && <span className="stat-s">{sub}</span>}
    </div>
  )
}
