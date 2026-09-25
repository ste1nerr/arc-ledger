import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatCents, formatUnitsExact, isCanonicalDecimal, parseUnitsExact, roundToCents } from '../src/money/decimal'
import { erc20ToNative, erc20TruncationRemainder, nativeToErc20 } from '../src/money/usdc'

const bigints = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n })
const decimalsArb = fc.constantFrom(0, 2, 6, 8, 18)

describe('formatUnitsExact / parseUnitsExact', () => {
  it('formats canonical decimals', () => {
    expect(formatUnitsExact(0n, 18)).toBe('0')
    expect(formatUnitsExact(1n, 18)).toBe('0.000000000000000001')
    expect(formatUnitsExact(300n * 10n ** 18n, 18)).toBe('300')
    expect(formatUnitsExact(1250500000000000000000n, 18)).toBe('1250.5')
    expect(formatUnitsExact(-1265000000000000n, 18)).toBe('-0.001265')
    expect(formatUnitsExact(50_000_000n, 6)).toBe('50')
    expect(formatUnitsExact(123n, 0)).toBe('123')
  })

  it('parses plain decimals and rejects junk', () => {
    expect(parseUnitsExact('12.345678901234567891', 18)).toBe(12345678901234567891n)
    expect(parseUnitsExact('-0.5', 6)).toBe(-500000n)
    expect(parseUnitsExact('7', 6)).toBe(7_000_000n)
    expect(() => parseUnitsExact('1e3', 6)).toThrow()
    expect(() => parseUnitsExact('1,5', 6)).toThrow()
    expect(() => parseUnitsExact('0.0000001', 6)).toThrow(RangeError)
    expect(() => parseUnitsExact('', 6)).toThrow()
  })

  it('round-trips every bigint (property)', () => {
    fc.assert(
      fc.property(bigints, decimalsArb, (raw, d) => {
        const s = formatUnitsExact(raw, d)
        expect(isCanonicalDecimal(s)).toBe(true)
        expect(parseUnitsExact(s, d)).toBe(raw)
      }),
      { numRuns: 2000 },
    )
  })

  it('never produces -0', () => {
    expect(formatUnitsExact(-0n, 18)).toBe('0')
  })
})

describe('roundToCents (half away from zero)', () => {
  it('rounds at the half-cent boundary', () => {
    expect(roundToCents(parseUnitsExact('12.345678901234567891', 18), 18)).toBe(1235n)
    expect(roundToCents(parseUnitsExact('0.005', 18), 18)).toBe(1n)
    expect(roundToCents(parseUnitsExact('0.004999999999999999', 18), 18)).toBe(0n)
    expect(roundToCents(parseUnitsExact('-0.005', 18), 18)).toBe(-1n)
    expect(roundToCents(parseUnitsExact('-0.004', 6), 6)).toBe(0n)
    expect(roundToCents(5n, 0)).toBe(500n)
  })

  it('is within half a cent of the exact value (property)', () => {
    fc.assert(
      fc.property(bigints, fc.constantFrom(6, 18), (raw, d) => {
        const cents = roundToCents(raw, d)
        const back = cents * 10n ** BigInt(d - 2)
        const diff = raw - back
        const half = 10n ** BigInt(d - 2) / 2n
        expect(diff <= half && diff >= -half).toBe(true)
        expect(roundToCents(-raw, d)).toBe(-cents) // symmetric
      }),
    )
  })

  it('formats cents', () => {
    expect(formatCents(125050n)).toBe('1250.50')
    expect(formatCents(-1235n)).toBe('-12.35')
    expect(formatCents(0n)).toBe('0.00')
    expect(formatCents(-5n)).toBe('-0.05')
  })
})

describe('USDC 18 <-> 6 decimals', () => {
  const nonNeg = fc.bigInt({ min: 0n, max: 10n ** 36n })

  it('erc20 -> native -> erc20 is the identity (property)', () => {
    fc.assert(
      fc.property(nonNeg, (raw6) => {
        expect(nativeToErc20(erc20ToNative(raw6))).toBe(raw6)
      }),
    )
  })

  it('native -> erc20 -> native truncates by less than 1e-6 USDC (property)', () => {
    fc.assert(
      fc.property(nonNeg, (raw18) => {
        const back = erc20ToNative(nativeToErc20(raw18))
        expect(back <= raw18).toBe(true)
        expect(raw18 - back < 10n ** 12n).toBe(true)
        expect(erc20TruncationRemainder(raw18)).toBe(raw18 - back)
      }),
    )
  })

  it('truncates like on-chain balanceOf', () => {
    expect(nativeToErc20(997145000000000000n)).toBe(997145n) // tx 0x00be75d9… logs 3 and 4
    expect(nativeToErc20(999_999_999_999n)).toBe(0n) // "a zero balanceOf does not mean zero native balance"
  })
})
