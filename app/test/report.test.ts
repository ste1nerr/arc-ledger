import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReport, decodeMemo } from '../src/report/build'
import { canonicalJson, reportHash } from '../src/report/canonical'
import { checkReportConsistency, parseReportFile, ReportFileError } from '../src/report/file'
import type { CanonicalReport } from '../src/report/types'
import { EXAMPLE_HASH, exampleSource, ME } from './exampleSource'

const EXAMPLES = join(__dirname, '../../docs/examples')
const read = (f: string) => readFileSync(join(EXAMPLES, f), 'utf8')
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('canonicalJson', () => {
  it('sorts keys, drops whitespace, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: null, c: 'x' }] })).toBe('{"a":[3,1,{"c":"x","d":null}],"b":1}')
  })
  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ m: 'a"b\\c\n€' })).toBe('{"m":"a\\"b\\\\c\\n€"}')
  })
  it('rejects floats, unsafe integers, undefined and bigint', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(TypeError)
    expect(() => canonicalJson({ x: 2 ** 60 })).toThrow(TypeError)
    expect(() => canonicalJson({ x: undefined })).toThrow(TypeError)
    expect(() => canonicalJson({ x: 1n })).toThrow(TypeError)
  })
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
  })
})

describe('buildReport (example dataset)', () => {
  const report = buildReport(exampleSource)

  it('matches the golden canonical bytes and hash', () => {
    expect(canonicalJson(report)).toBe(read('report.canonical.json'))
    expect(reportHash(report)).toBe(EXAMPLE_HASH)
  })

  it('de-duplicates, sorts by (block, logIndex) and lowercases', () => {
    expect(report.rows.map((r) => `${r.blockNumber}:${r.logIndex}`)).toEqual(['17904001:0', '19121450:1', '20260880:2', '20260880:4', '20790002:0'])
    expect(report.address).toBe(ME.toLowerCase())
  })

  it('charges a fee once per tx, only when the address paid gas', () => {
    expect(report.rows.map((r) => r.feeUSDC)).toEqual([null, '0.001265', '0.002041', null, null])
    expect(report.totals.USDC!.fees).toBe('0.003306')
    expect(report.totals.EURC!.fees).toBe('0')
    expect(report.reconciliation.itemizedSentTxCount).toBe(2)
  })

  it('computes totals and reconciliation exactly', () => {
    expect(report.totals.USDC).toEqual({ in: '1250.5', out: '312.345678901234567891', fees: '0.003306', net: '938.151015098765432109' })
    expect(report.totals.EURC).toEqual({ in: '100', out: '50', fees: '0', net: '50' })
    expect(report.reconciliation.USDC!.unexplained).toBe('0')
    expect(checkReportConsistency(report)).toEqual([])
  })

  it('reports an unexplained balance change (fee-only tx)', () => {
    const withGap = buildReport({
      ...exampleSource,
      balances: { opening: exampleSource.balances.opening, closing: { ...exampleSource.balances.closing, USDC: exampleSource.balances.closing.USDC! - 4_000_000_000_000_000n } },
      nonces: { opening: 0, closing: 3 },
    })
    expect(withGap.reconciliation.USDC!.unexplained).toBe('-0.004')
    expect(withGap.reconciliation.sentTxCount).toBe(3)
  })

  it('handles a self transfer (EURC) and keeps it out of in/out totals', () => {
    const src = { ...exampleSource, transfers: [...exampleSource.transfers, { asset: 'EURC' as const, txHash: `0x${'e'.repeat(64)}` as const, logIndex: 3, blockNumber: 20790002n, from: ME, to: ME, value: 7_000_000n }] }
    src.txs = { ...src.txs, [`0x${'e'.repeat(64)}`]: { from: ME, gasUsed: 50_000n, effectiveGasPrice: 20_000_000_000n, memos: [] } }
    const r = buildReport(src)
    const self = r.rows.find((x) => x.direction === 'self')!
    expect(self.counterparty).toBe(ME.toLowerCase())
    expect(self.feeUSDC).toBe('0.001')
    expect(r.totals.EURC).toEqual({ in: '100', out: '50', fees: '0', net: '50' })
    expect(r.totals.USDC!.fees).toBe('0.004306')
  })

  it('only includes selected assets', () => {
    const r = buildReport({ ...exampleSource, assets: ['EURC'] })
    expect(r.assets).toEqual(['EURC'])
    expect(r.rows.every((x) => x.asset === 'EURC')).toBe(true)
    expect(r.totals.USDC).toBeUndefined()
    expect(r.rows.find((x) => x.logIndex === 4)!.feeUSDC).toBe('0.002041') // fee still shown on the EURC row
  })

  it('refuses an empty block range and a missing receipt', () => {
    expect(() => buildReport({ ...exampleSource, blockRange: { from: 10n, to: 9n } })).toThrow(/no blocks/)
    expect(() => buildReport({ ...exampleSource, txs: {} })).toThrow(/missing receipt/)
  })
})

describe('decodeMemo', () => {
  it('decodes UTF-8 text', () => {
    expect(decodeMemo('0x6379636c65735f7377656570')).toBe('cycles_sweep') // real mainnet memo, tx 0x00be75d9…
    expect(decodeMemo('0xe282ac20313030')).toBe('€ 100')
    expect(decodeMemo('0x')).toBe('')
  })
  it('falls back to hex for binary or control characters', () => {
    expect(decodeMemo('0xff00AA')).toBe('0xff00aa')
    expect(decodeMemo('0x610a62')).toBe('0x610a62') // "a\nb"
  })
})

describe('report file (Verify input)', () => {
  const file = read('report.json')

  it('parses the example file and re-hashes to the golden hash', () => {
    const parsed = parseReportFile(file)
    expect(reportHash(parsed.report)).toBe(EXAMPLE_HASH)
    expect(parsed.reportHash).toBe(EXAMPLE_HASH)
    expect(parsed.annotations!.counterpartyLabels['0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed']).toBe('Acme GmbH')
  })

  it('does not depend on formatting or annotations', () => {
    const data = JSON.parse(file)
    data.annotations.counterpartyLabels = {}
    data.generator.generatedAt = '2030-01-01T00:00:00Z'
    expect(reportHash(parseReportFile(JSON.stringify(data)).report)).toBe(EXAMPLE_HASH)
  })

  it('changes the hash when any canonical field changes', () => {
    const base = JSON.parse(file).report as CanonicalReport
    const edits: ((r: CanonicalReport) => void)[] = [
      (r) => (r.rows[1]!.amount = '301'),
      (r) => (r.rows[1]!.amountRaw = '301000000000000000000'),
      (r) => (r.rows[0]!.memo = 'INV-2026-015'),
      (r) => (r.rows[0]!.counterparty = '0x0000000000000000000000000000000000000001'),
      (r) => (r.rows[2]!.feeUSDC = null),
      (r) => (r.totals.USDC!.net = '0'),
      (r) => (r.periodEnd += 1),
      (r) => (r.address = '0x0000000000000000000000000000000000000002'),
      (r) => r.rows.pop(),
      (r) => (r.reconciliation.sentTxCount = 3),
    ]
    for (const edit of edits) {
      const r = clone(base)
      edit(r)
      expect(reportHash(r)).not.toBe(EXAMPLE_HASH)
    }
  })

  it('flags inconsistent totals in an edited file', () => {
    const r = clone(JSON.parse(file).report as CanonicalReport)
    r.rows[1]!.amount = '301'
    r.rows[1]!.amountRaw = '301000000000000000000'
    expect(checkReportConsistency(r).join('\n')).toMatch(/USDC total "out"/)
  })

  it('rejects malformed files with a readable message', () => {
    expect(() => parseReportFile('nope')).toThrow(ReportFileError)
    expect(() => parseReportFile('{"format":"other"}')).toThrow(/not an Arc Ledger report/)
    const data = JSON.parse(file)
    data.report.rows[0].amount = 1250.5
    expect(() => parseReportFile(JSON.stringify(data))).toThrow(/rows\[0\]\.amount/)
    const extra = JSON.parse(file)
    extra.report.rows[0].label = 'x'
    expect(() => parseReportFile(JSON.stringify(extra))).toThrow(/unexpected field "label"/)
  })
})
