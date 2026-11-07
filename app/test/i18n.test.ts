// @vitest-environment jsdom
import { RELAY_ERROR_CODES } from '@accrue/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { currentLang, dicts, LANGS, t } from '../src/i18n'
import { toUiError } from '../src/providers/errors'

const en = dicts.en
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

function setHost(ctx: object | undefined) {
  if (ctx === undefined) delete (window as { nimiqPay?: unknown }).nimiqPay
  else Object.defineProperty(window, 'nimiqPay', { value: ctx, configurable: true, writable: true })
}

afterEach(() => setHost(undefined))

describe('dictionaries', () => {
  it('every en key exists in de, es, fr and pt', () => {
    for (const lang of LANGS) {
      const missing = Object.keys(en).filter(k => typeof dicts[lang][k] !== 'string' || dicts[lang][k] === '')
      expect(missing, `${lang} is missing keys`).toEqual([])
    }
  })

  it('no dictionary has keys that en lacks', () => {
    for (const lang of LANGS) {
      const extra = Object.keys(dicts[lang]).filter(k => !(k in en))
      expect(extra, `${lang} has extra keys`).toEqual([])
    }
  })

  it('translations keep the same placeholders', () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(en)) {
        expect(placeholders(dicts[lang][k] ?? ''), `${lang}:${k}`).toEqual(placeholders(v))
      }
    }
  })

  it('every message key the error mapper can produce exists', () => {
    const samples: unknown[] = [
      ...RELAY_ERROR_CODES.map(error => ({ error })),
      { type: 'PERMISSION_DENIED', code: 4001 },
      { type: 'NETWORK_ERROR', code: -32000, message: 'x' },
      { type: 'TRANSACTION_OUTCOME_UNKNOWN', message: 'x' },
      { type: 'INVALID_TRANSACTION', code: -32602, message: 'Insufficient funds' },
      { type: 'INVALID_TRANSACTION', code: -32602, message: 'bad' },
      { type: 'DUPLICATE_PAYMENT', message: 'x' },
      { type: 'UNKNOWN_REQUEST', code: 4200, message: 'x' },
      { type: 'INVALID_REQUEST', message: 'x' },
      { type: 'INTERNAL_ERROR', code: -32603, message: 'x' },
      { type: 'UNKNOWN_ERROR', message: 'x' },
      { code: 4100, message: 'x' },
      { code: 4900, message: 'x' },
      { code: 4902, message: 'x' },
      { code: -32002, message: 'x' },
      { code: -32000, message: 'insufficient funds for gas' },
      { status: 503 },
      new TypeError('Failed to fetch'),
      new DOMException('x', 'TimeoutError'),
      new Error('Nimiq provider was not injected'),
      'nothing',
    ]
    for (const s of samples) {
      const { messageKey } = toUiError(s)
      expect(en[messageKey], messageKey).toBeTypeOf('string')
    }
  })
})

describe('t', () => {
  it('uses en outside Nimiq Pay', () => {
    expect(currentLang()).toBe('en')
    expect(t('action.retry')).toBe(en['action.retry'])
  })

  it('uses the host language', () => {
    setHost({ language: 'de' })
    expect(currentLang()).toBe('de')
    expect(t('action.retry')).toBe(dicts.de['action.retry'])
  })

  it('accepts a region suffix and falls back to en for unknown languages', () => {
    setHost({ language: 'pt-BR' })
    expect(currentLang()).toBe('pt')
    setHost({ language: 'ja' })
    expect(currentLang()).toBe('en')
  })

  it('falls back to the en string when a key is missing in the host language', () => {
    setHost({ language: 'fr' })
    const key = 'action.retry'
    const saved = dicts.fr[key]!
    delete dicts.fr[key]
    try {
      expect(t(key)).toBe(en[key])
    } finally {
      dicts.fr[key] = saved
    }
  })

  it('returns the key itself when nobody knows it', () => {
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('fills placeholders', () => {
    const key = Object.keys(en).find(k => placeholders(en[k]!).length > 0)!
    const vars = Object.fromEntries(placeholders(en[key]!).map(p => [p, 'XYZ']))
    const out = t(key, vars)
    expect(out).toContain('XYZ')
    expect(out).not.toMatch(/\{\w+\}/)
  })
})
