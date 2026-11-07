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

// Read on every call: the dev mock injects the host context after modules load.
export function currentLang(w: Window | undefined = typeof window === 'undefined' ? undefined : window): Lang {
  const raw: unknown = w?.nimiqPay?.language
  const base = typeof raw === 'string' ? (raw.toLowerCase().split(/[-_]/)[0] ?? '') : ''
  return isLang(base) ? base : 'en'
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = dicts[currentLang()][key] ?? dicts.en[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
