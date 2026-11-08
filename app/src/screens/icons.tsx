import type { Route } from './context'

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

// 22×22 line icons for the tab bar; the active tab fills its accent part.
export function TabIcon({ route }: { route: Exclude<Route, 'about'> }) {
  return (
    <svg viewBox="0 0 22 22" aria-hidden="true" className="tab-ico">
      {route === 'home' && (
        <>
          <circle cx="11" cy="11" r="7.6" {...P} strokeDasharray="2.2 2" />
          <circle cx="11" cy="11" r="4.4" {...P} />
          <circle cx="11" cy="11" r="1.8" className="ico-fill" />
        </>
      )}
      {route === 'dollars' && (
        <>
          <ellipse cx="11" cy="6.6" rx="6.4" ry="2.6" {...P} />
          <path d="M4.6 6.6v4.4c0 1.4 2.9 2.6 6.4 2.6s6.4-1.2 6.4-2.6V6.6" {...P} />
          <path d="M4.6 11v4.4c0 1.4 2.9 2.6 6.4 2.6s6.4-1.2 6.4-2.6V11" {...P} />
          <ellipse cx="11" cy="6.6" rx="2.2" ry=".9" className="ico-fill" />
        </>
      )}
      {route === 'nim' && (
        <>
          <path d="M7.2 3.6h7.6l3.8 7.4-3.8 7.4H7.2L3.4 11z" {...P} />
          <circle cx="11" cy="11" r="2.2" className="ico-fill" />
        </>
      )}
      {route === 'payouts' && (
        <>
          <circle cx="11" cy="11" r="7.6" {...P} />
          <path d="M7.6 11.2l2.3 2.2 4.6-4.8" {...P} className="ico-stroke" />
        </>
      )}
      {route === 'activity' && (
        <>
          <path d="M8.4 6.4h9M8.4 11h9M8.4 15.6h9" {...P} />
          <circle cx="4.8" cy="6.4" r="1.3" className="ico-fill" />
          <circle cx="4.8" cy="11" r="1.3" fill="currentColor" />
          <circle cx="4.8" cy="15.6" r="1.3" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

export function Brand() {
  return (
    <span className="brand">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.4" fill="var(--accent)" />
        <circle cx="10" cy="10" r="5.8" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.6" />
      </svg>
      Accrue
    </span>
  )
}

export function InfoIcon() {
  return (
    <svg viewBox="0 0 22 22" aria-hidden="true" className="info-ico">
      <circle cx="11" cy="11" r="8" {...P} />
      <path d="M11 10v5" {...P} />
      <circle cx="11" cy="7.2" r="1" fill="currentColor" />
    </svg>
  )
}

// The rings of the landing's orbit, still: a staked balance and its payouts.
export function Rings() {
  return (
    <svg viewBox="0 0 240 240" aria-hidden="true" className="rings">
      {[118, 104, 96, 90, 85, 81].map((r, i) => (
        <circle key={r} cx="120" cy="120" r={r} fill="none" stroke={i < 1 ? 'var(--hair-strong)' : 'var(--accent)'} strokeWidth={i < 1 ? 1 : 1.2} opacity={i < 1 ? 1 : 0.25 + i * 0.13} strokeDasharray={i < 1 ? '2 4' : undefined} />
      ))}
      <circle cx="120" cy="120" r="60" fill="var(--accent-wash)" stroke="var(--violet-300)" strokeWidth="1" />
      <circle cx="120" cy="120" r="9" fill="var(--accent)" />
      <circle cx="203" cy="62" r="3" fill="var(--ink)" />
    </svg>
  )
}
