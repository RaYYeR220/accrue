import de from './de.json'
import en from './en.json'
import es from './es.json'
import fr from './fr.json'
import pt from './pt.json'

export const LANGS = ['en', 'de', 'es', 'fr', 'pt'] as const
export type Lang = (typeof LANGS)[number]
export type Dict = Record<string, string>

export const dicts: Record<Lang, Dict> = { en, de, es, fr, pt }

const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s)
const base = (raw: unknown) => (typeof raw === 'string' ? (raw.toLowerCase().split(/[-_]/)[0] ?? '') : '')

// On the landing (an ordinary browser) a ?lang= parameter wins, then the browser's language list.
function browserLang(w: Window): Lang {
  const param = base(new URLSearchParams(w.location?.search ?? '').get('lang'))
  if (isLang(param)) return param
  const nav = w.navigator
  const list: readonly unknown[] = nav?.languages?.length ? nav.languages : [nav?.language]
  for (const l of list) {
    const b = base(l)
    if (isLang(b)) return b
  }
  return 'en'
}

// Read on every call: the dev mock injects the host context after modules load.
// Inside Nimiq Pay only the host language counts.
export function currentLang(w: Window | undefined = typeof window === 'undefined' ? undefined : window): Lang {
  if (!w) return 'en'
  const host: unknown = w.nimiqPay
  if (typeof host === 'object' && host !== null) {
    const b = base(w.nimiqPay?.language)
    return isLang(b) ? b : 'en'
  }
  return browserLang(w)
}

// Lazily loaded surfaces (the landing) bring their own strings and merge them in.
export function extendDicts(more: Partial<Record<Lang, Dict>>): void {
  for (const lang of LANGS) {
    const d = more[lang]
    if (d) Object.assign(dicts[lang], d)
  }
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = dicts[currentLang()][key] ?? dicts.en[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
