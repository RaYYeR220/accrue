import { describe, expect, it } from 'vitest'
import { classifyQuery } from '../src/landing/query'

const SIAM_STAKER = 'NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3ST'
const EVM = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'

describe('classifyQuery', () => {
  it('is empty for blank input', () => {
    expect(classifyQuery('')).toEqual({ kind: 'empty' })
    expect(classifyQuery('   \n')).toEqual({ kind: 'empty' })
  })

  it('accepts a NIM address in any spacing and case, normalised to groups of four', () => {
    expect(classifyQuery(SIAM_STAKER)).toEqual({ kind: 'nim', address: SIAM_STAKER })
    expect(classifyQuery(' nq94uuv1jptmxn2k5ah9sh6ymguamdhkf3st ')).toEqual({ kind: 'nim', address: SIAM_STAKER })
  })

  it('flags a NIM address with a typo as a checksum error, not as unknown input', () => {
    expect(classifyQuery('NQ94 UUV1 JPTM XN2K 5AH9 SH6Y MGUA MDHK F3SU')).toEqual({ kind: 'invalid', reason: 'nimChecksum' })
  })

  it('flags a NIM-looking string of the wrong length', () => {
    expect(classifyQuery('NQ94 UUV1 JPTM XN2K')).toEqual({ kind: 'invalid', reason: 'nimFormat' })
  })

  it('accepts a checksummed or all-lowercase 0x address and returns it checksummed', () => {
    expect(classifyQuery(EVM)).toEqual({ kind: 'evm', address: EVM })
    expect(classifyQuery(EVM.toLowerCase())).toEqual({ kind: 'evm', address: EVM })
    expect(classifyQuery(` ${EVM} `)).toEqual({ kind: 'evm', address: EVM })
  })

  it('treats an all-uppercase 0x address (a phone keyboard in caps) as unchecksummed', () => {
    expect(classifyQuery(EVM.toUpperCase())).toEqual({ kind: 'evm', address: EVM })
    expect(classifyQuery(`0x${EVM.slice(2).toUpperCase()}`)).toEqual({ kind: 'evm', address: EVM })
  })

  it('rejects a mixed-case 0x address whose checksum is wrong', () => {
    const broken = EVM.slice(0, -1) + 'f'
    expect(classifyQuery(broken)).toEqual({ kind: 'invalid', reason: 'evmChecksum' })
  })

  it('rejects 0x strings of the wrong length', () => {
    expect(classifyQuery('0x1234')).toEqual({ kind: 'invalid', reason: 'evmFormat' })
  })

  it('rejects anything else', () => {
    expect(classifyQuery('hello')).toEqual({ kind: 'invalid', reason: 'unknown' })
    expect(classifyQuery('alice.eth')).toEqual({ kind: 'invalid', reason: 'unknown' })
  })
})
