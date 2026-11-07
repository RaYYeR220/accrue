import { describe, expect, it } from 'vitest'
import { lunaToNim, nimToLuna, addressFromBytesHex, normalizeAddress } from '../src/index'

describe('luna conversion', () => {
  it('nimToLuna', () => {
    expect(nimToLuna('100')).toBe(10_000_000n)
    expect(nimToLuna('0.12345')).toBe(12345n)
    expect(nimToLuna('1.5')).toBe(150_000n)
  })
  it('lunaToNim', () => {
    expect(lunaToNim(12345n)).toBe('0.12345')
    expect(lunaToNim(10_000_000n)).toBe('100')
    expect(lunaToNim(150_000n)).toBe('1.5')
    expect(lunaToNim(0n)).toBe('0')
  })
  it('rejects bad input', () => {
    expect(() => nimToLuna('1.123456')).toThrow()
    expect(() => nimToLuna('abc')).toThrow()
  })
})

describe('address encoding', () => {
  it('matches the known Siam staker', () => {
    expect(addressFromBytesHex('e73a195f75f58532aa29d44dfac38aab63378f5b')).toBe('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')
  })
  it('encodes the staking contract (0x00..01)', () => {
    expect(addressFromBytesHex('0000000000000000000000000000000000000001')).toBe('NQ77 0000 0000 0000 0000 0000 0000 0000 0001')
  })
  it('normalizes spacing and case', () => {
    expect(normalizeAddress('nq77 0000 0000 0000 0000 0000 0000 0000 0001')).toBe('NQ77' + '0'.repeat(31) + '1')
  })
})
