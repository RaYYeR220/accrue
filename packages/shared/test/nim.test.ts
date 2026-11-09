import { describe, expect, it } from 'vitest'
import { COINBASE_ADDRESS, STAKING_CONTRACT, addressFromBytesHex, formatNim, formatNimAddress, isValidNimAddress, lunaToNim, nimToLuna, normalizeAddress } from '../src/index'

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
  it('formatNim: whole NIM with thousands separators and at most two decimals', () => {
    expect(formatNim(462_997_721n)).toBe('4,629.98')
    expect(formatNim(0n)).toBe('0')
    expect(formatNim(10_000_000n)).toBe('100')
    expect(formatNim(150_000n)).toBe('1.5')
    expect(formatNim(123_456_789_012_345n)).toBe('1,234,567,890.12')
    expect(formatNim(999n)).toBe('0.01')
    expect(formatNim(499n)).toBe('0')
    expect(formatNim(99_999_500n)).toBe('1,000')
    expect(formatNim(-462_997_721n)).toBe('-4,629.98')
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

describe('isValidNimAddress', () => {
  it('accepts real addresses with or without spaces, in any case', () => {
    expect(isValidNimAddress('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe(true)
    expect(isValidNimAddress('NQ94UUV1JPTMXN2K5AH9SH6YMGUAMDHKF3ST')).toBe(true)
    expect(isValidNimAddress('  nq94 uuv1 jptm xn2k 5ah9 sh6y mgua mdhk f3st ')).toBe(true)
    expect(isValidNimAddress(STAKING_CONTRACT)).toBe(true)
    expect(isValidNimAddress(COINBASE_ADDRESS)).toBe(true)
  })

  it('rejects a single mistyped character', () => {
    expect(isValidNimAddress('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3SU')).toBe(false)
    expect(isValidNimAddress('NQ95 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe(false)
  })

  it('rejects letters outside the Nimiq alphabet, wrong length and other prefixes', () => {
    // I, O, W and Z are not part of the address alphabet
    expect(isValidNimAddress('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3SO')).toBe(false)
    expect(isValidNimAddress('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3S')).toBe(false)
    expect(isValidNimAddress('DE94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')).toBe(false)
    expect(isValidNimAddress('')).toBe(false)
    expect(isValidNimAddress('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')).toBe(false)
  })
})

describe('formatNimAddress', () => {
  it('groups a compact address in blocks of four', () => {
    expect(formatNimAddress('nq94uuv1jptmxn2k5ah9sh6ymguamdhkf3st')).toBe('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST')
  })
})
