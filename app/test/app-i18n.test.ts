import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANGS } from '../src/i18n'
import mainEn from '../src/i18n/en.json'
import landingEn from '../src/landing/i18n/en.json'
import de from '../src/screens/i18n/de.json'
import en from '../src/screens/i18n/en.json'
import es from '../src/screens/i18n/es.json'
import fr from '../src/screens/i18n/fr.json'
import pt from '../src/screens/i18n/pt.json'

const dicts: Record<string, Record<string, string>> = { en, de, es, fr, pt }
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
const src = fileURLToPath(new URL('../src/', import.meta.url))
const files = [
  ...readdirSync(join(src, 'screens')).filter(f => /\.tsx?$/.test(f)).map(f => join(src, 'screens', f)),
  join(src, 'MiniApp.tsx'),
  join(src, 'ui/components/Fields.tsx'),
]
const code = files.map(f => readFileSync(f, 'utf8')).join('\n')
const known = { ...mainEn, ...en } as Record<string, string>

describe('in-app dictionaries', () => {
  it('cover all five languages with the same keys and placeholders, none empty', () => {
    for (const lang of LANGS) {
      const d = dicts[lang]!
      expect(Object.keys(d).sort(), lang).toEqual(Object.keys(en).sort())
      for (const [k, v] of Object.entries(en)) {
        expect(d[k]?.trim(), `${lang}:${k}`).toBeTruthy()
        expect(placeholders(d[k] ?? ''), `${lang}:${k}`).toEqual(placeholders(v))
      }
    }
  })

  it('are translated, not copied: most strings differ from English in every other language', () => {
    for (const lang of LANGS.filter(l => l !== 'en')) {
      const same = Object.keys(en).filter(k => dicts[lang]![k] === (en as Record<string, string>)[k])
      expect(same.length / Object.keys(en).length, `${lang}: ${same.join(', ')}`).toBeLessThan(0.12)
    }
  })

  it('every literal key the screens ask for exists', () => {
    const literals = [...code.matchAll(/'((?:tab|top|onb|connect|common|fmt|sym|home|usd|amount|sheet|stake|pool|check|act|about|nim|error|verdict|status|action|dollars|app)\.[\w.]+)'/g)].map(m => m[1]!)
    expect(literals.length).toBeGreaterThan(50)
    expect([...new Set(literals)].filter(k => !(k in known))).toEqual([])
  })

  it('keys built at runtime exist for every value they can take', () => {
    const families: Record<string, readonly string[]> = {
      'tab.': ['home', 'dollars', 'nim', 'payouts', 'activity'],
      'act.nim.': ['stake', 'add', 'switch', 'deactivate', 'retire', 'remove'],
      'stake.done.': ['stake', 'add', 'switch', 'deactivate', 'retire', 'remove'],
      'stake.title.': ['stake', 'add', 'unstake', 'switch', 'retire', 'remove'],
      'about.risk.': ['contract', 'rate', 'exit', 'unstake', 'pools'],
      'home.partial.': ['dollars.off', 'dollars.loading', 'nim.off', 'nim.loading', 'nim.unpriced'],
    }
    for (const [prefix, values] of Object.entries(families)) for (const v of values) expect(known, prefix + v).toHaveProperty([prefix + v])
    for (const v of ['contract', 'rate', 'exit', 'unstake', 'pools']) expect(known).toHaveProperty([`about.risk.${v}.body`])
  })

  it('do not collide with the main or the landing dictionary', () => {
    expect(Object.keys(en).filter(k => k in mainEn || k in landingEn)).toEqual([])
  })
})
