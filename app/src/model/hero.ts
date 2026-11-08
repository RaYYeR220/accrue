// Home's total: only what is known is added, and a partial sum says what it leaves out.

// off: that wallet is not connected; loading: connected, but its value or its price is not known yet;
// unpriced: it has no price at all (testnet NIM)
export type Side = { state: 'off' } | { state: 'loading' } | { state: 'unpriced' } | { state: 'known'; fiat: number }

export interface Missing {
  side: 'dollars' | 'nim'
  why: 'off' | 'loading' | 'unpriced'
}

export type HeroView = { kind: 'none'; missing: Missing[] } | { kind: 'total'; value: number } | { kind: 'partial'; value: number; missing: Missing[] }

export function side(args: { connected: boolean; value: number | null; priced?: boolean }): Side {
  if (!args.connected) return { state: 'off' }
  if (args.priced === false) return { state: 'unpriced' }
  if (args.value === null || !Number.isFinite(args.value)) return { state: 'loading' }
  return { state: 'known', fiat: args.value }
}

export function heroView(dollars: Side, nim: Side): HeroView {
  const sides = [
    ['dollars', dollars],
    ['nim', nim],
  ] as const
  let value = 0
  let known = 0
  const missing: Missing[] = []
  for (const [name, s] of sides) {
    if (s.state === 'known') {
      value += s.fiat
      known += 1
    } else missing.push({ side: name, why: s.state })
  }
  if (known === 0) return { kind: 'none', missing }
  return missing.length ? { kind: 'partial', value, missing } : { kind: 'total', value }
}
