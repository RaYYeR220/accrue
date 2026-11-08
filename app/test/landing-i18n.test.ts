import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANGS } from '../src/i18n'
import mainEn from '../src/i18n/en.json'
import de from '../src/landing/i18n/de.json'
import en from '../src/landing/i18n/en.json'
import es from '../src/landing/i18n/es.json'
import fr from '../src/landing/i18n/fr.json'
import pt from '../src/landing/i18n/pt.json'

const dicts: Record<string, Record<string, string>> = { en, de, es, fr, pt }
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
const landingDir = fileURLToPath(new URL('../src/landing/', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [readFileSync(join(dir, e.name), 'utf8')] : [],
  )
}

describe('landing dictionaries', () => {
  it('cover all five languages with the same keys and placeholders, none empty', () => {
    for (const lang of LANGS) {
      const d = dicts[lang]!
      expect(Object.keys(d).sort(), lang).toEqual(Object.keys(en).sort())
      for (const [k, v] of Object.entries(en)) {
        expect(d[k], `${lang}:${k}`).not.toBe('')
        expect(placeholders(d[k] ?? ''), `${lang}:${k}`).toEqual(placeholders(v))
      }
    }
  })

  it('every literal key the landing asks for exists', () => {
    const known = { ...mainEn, ...en } as Record<string, string>
    const used = new Set(sources(landingDir).flatMap(src => [...src.matchAll(/\bt\(\s*'([\w.]+)'/g)].map(m => m[1]!)))
    expect(used.size).toBeGreaterThan(50)
    const missing = [...used].filter(k => !(k in known))
    expect(missing).toEqual([])
  })

  it("the explainers around the checker give no fixed number of days: the staker's window is measured per check", () => {
    for (const lang of LANGS) {
      for (const k of ['landing.checker.body', 'landing.check.expected.body', 'landing.check.received.formula']) {
        expect(dicts[lang]![k], `${lang}:${k}`).toBeTruthy()
        expect(dicts[lang]![k], `${lang}:${k}`).not.toMatch(/\b\d+\b/)
      }
    }
  })

  it('copy that counts days has a one-day form in every language, without the number', () => {
    const counted = Object.keys(en).filter(k => !k.endsWith('.one') && placeholders((en as Record<string, string>)[k]!).includes('days'))
    expect(counted.sort()).toEqual(['landing.board.foot.live', 'landing.board.live', 'landing.checker.you'])
    for (const lang of LANGS) {
      for (const k of counted) {
        const one = dicts[lang]![`${k}.one`]
        expect(one?.trim(), `${lang}:${k}.one`).toBeTruthy()
        expect(placeholders(one ?? ''), `${lang}:${k}.one`).toEqual(placeholders(dicts[lang]![k]!).filter(p => p !== 'days'))
        expect(one, `${lang}:${k}.one`).not.toMatch(/\b\d+\b/)
      }
    }
  })

  it('the landing keys do not collide with the app dictionary', () => {
    const clash = Object.keys(en).filter(k => k in mainEn)
    expect(clash).toEqual([])
  })
})
