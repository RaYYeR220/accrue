import { describe, expect, it } from 'vitest'
import { detectMode } from '../src/boot'

const asWindow = (o: object) => o as unknown as Window

describe('detectMode', () => {
  it('is app when the host context object is injected', () => {
    expect(detectMode(asWindow({ nimiqPay: {} }))).toBe('app')
  })

  it('is landing outside Nimiq Pay', () => {
    expect(detectMode(asWindow({}))).toBe('landing')
  })

  it('ignores non-object host values', () => {
    expect(detectMode(asWindow({ nimiqPay: null }))).toBe('landing')
    expect(detectMode(asWindow({ nimiqPay: 'yes' }))).toBe('landing')
  })

  it('is synchronous and reads nothing but the host context', () => {
    const touched: PropertyKey[] = []
    const w = new Proxy(
      { nimiqPay: { language: 'de' } },
      {
        get(target, key) {
          touched.push(key)
          return Reflect.get(target, key)
        },
      },
    )
    const mode = detectMode(asWindow(w))
    expect(mode).toBe('app')
    expect(touched).toEqual(['nimiqPay'])
  })
})
