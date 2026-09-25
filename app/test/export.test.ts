import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { csvField } from '../src/export/csv'
import { bankLines, exportGeneric, exportJson, exportQbo, exportXero, qboDescription } from '../src/export/formats'
import { buildReport } from '../src/report/build'
import { exampleAnnotations, exampleSource, ME } from './exampleSource'

const EXAMPLES = join(__dirname, '../../docs/examples')
const read = (f: string) => readFileSync(join(EXAMPLES, f), 'utf8')
const report = buildReport(exampleSource)

describe('golden export files (docs/examples)', () => {
  it('generic CSV', () => {
    const f = exportGeneric(report, exampleAnnotations)
    expect(f.name).toBe('arc-ledger_287a9e46_2026-09-01_2026-09-30_generic.csv')
    expect(f.content).toBe(read('generic.csv'))
  })
  it('Xero, one file per asset', () => {
    const files = exportXero(report, exampleAnnotations)
    expect(files.map((f) => f.name)).toEqual(['arc-ledger_287a9e46_2026-09-01_2026-09-30_xero_EURC.csv', 'arc-ledger_287a9e46_2026-09-01_2026-09-30_xero_USDC.csv'])
    expect(files[0]!.content).toBe(read('xero_EURC.csv'))
    expect(files[1]!.content).toBe(read('xero_USDC.csv'))
  })
  it('QuickBooks 4-column, one file per asset', () => {
    const files = exportQbo(report, exampleAnnotations)
    expect(files[0]!.content).toBe(read('qbo_EURC.csv'))
    expect(files[1]!.content).toBe(read('qbo_USDC.csv'))
  })
  it('JSON', () => {
    const f = exportJson(report, exampleAnnotations, new Date('2026-10-01T08:00:00Z'))
    expect(f.content).toBe(read('report.json'))
  })
})

describe('CSV rules', () => {
  it('uses CRLF, a header and the BOM only on the generic file', () => {
    expect(exportGeneric(report, exampleAnnotations).content.startsWith('﻿row_type,')).toBe(true)
    const xero = exportXero(report, exampleAnnotations)[1]!.content
    expect(xero.startsWith('Date,Amount,Payee,Description,Reference\r\n')).toBe(true)
    expect(xero.endsWith('\r\n')).toBe(true)
    expect(xero).not.toMatch(/[^\r]\n/)
  })

  it('guards text fields against CSV injection but leaves numbers alone', () => {
    expect(csvField('=HYPERLINK("http://evil")', true)).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvField('@SUM(A1)', true)).toBe(`'@SUM(A1)`)
    expect(csvField('-300.00', false)).toBe('-300.00')
    expect(csvField('a,b', false)).toBe('"a,b"')
  })

  it('neutralizes a malicious memo in every format', () => {
    const src = structuredClone(exampleSource)
    src.txs[`0x${'a'.repeat(64)}`]!.memos = [{ logIndex: 1, memo: '0x3d636d647c272f432063616c6327' }] // =cmd|'/C calc'
    const r = buildReport(src)
    expect(exportGeneric(r, exampleAnnotations).content).toContain(`'=cmd|'/C calc'`)
    for (const f of [...exportXero(r, exampleAnnotations), ...exportQbo(r, exampleAnnotations)]) {
      expect(f.content).not.toMatch(/(^|,)"?=/m)
    }
  })

  it('never uses thousands separators and always uses a dot', () => {
    const big = structuredClone(exampleSource)
    for (const t of big.transfers) if (t.txHash === `0x${'a'.repeat(64)}`) t.value = 1_234_567_891_000_000_000_000_000n // 1,234,567.891 USDC (the tx appears twice, like a duplicate log query)
    big.balances.closing.USDC = big.balances.closing.USDC! + 1_234_567_891_000_000_000_000_000n - 1250500000000000000000n
    const xero = exportXero(buildReport(big), exampleAnnotations)[1]!.content
    expect(xero).toContain(',1234567.89,')
  })
})

describe('bank lines: fees, rounding, unexplained', () => {
  it('sums every statement to the exact change rounded to the cent', () => {
    const src = structuredClone(exampleSource)
    // a 0.046 USDC fee becomes a -0.05 daily line; the sub-cent fee of 0.002041 gets no line
    src.txs[`0x${'b'.repeat(64)}`]!.gasUsed = 2_000_000n // 0.046 USDC at 23 gwei
    src.balances.closing.USDC = src.balances.closing.USDC! - (2_000_000n - 55_000n) * 23_000_000_000n
    const r = buildReport(src)
    const lines = bankLines(r, exampleAnnotations, 'USDC')
    const fee = lines.find((l) => l.kind === 'fees')!
    expect(fee.cents).toBe(-5n)
    expect(fee.description).toBe('Arc network fees (1 tx) exact 0.046 USDC')
    // exact net = 1250.5 − 312.345678901234567891 − 0.048041 = 938.106280… → 938.11,
    // while the rounded lines give 1250.50 − 300.00 − 12.35 − 0.05 = 938.10 → +0.01 rounding line
    expect(r.totals.USDC!.net).toBe('938.106280098765432109')
    expect(lines.find((l) => l.kind === 'rounding')!.cents).toBe(1n)
    expect(lines.reduce((s, l) => s + l.cents, 0n)).toBe(93811n)
  })

  it('adds an unexplained line and a rounding line when needed', () => {
    const src = structuredClone(exampleSource)
    src.balances.closing.USDC = src.balances.closing.USDC! - 1_234_567_000_000_000_000n // 1.234567 USDC gone without a log
    const r = buildReport(src)
    expect(r.reconciliation.USDC!.unexplained).toBe('-1.234567')
    const lines = bankLines(r, exampleAnnotations, 'USDC')
    const unexplained = lines.find((l) => l.kind === 'unexplained')!
    expect(unexplained.cents).toBe(-123n)
    expect(unexplained.date).toBe('2026-09-30')
    // exact change = 938.151015… − 1.234567 = 936.916448… → 936.92
    expect(lines.reduce((s, l) => s + l.cents, 0n)).toBe(93692n)
  })

  it('QBO description keeps only safe characters', () => {
    const [line] = bankLines(report, exampleAnnotations, 'USDC')
    expect(qboDescription({ ...line!, payee: 'Müller & Söhne <GmbH>', memo: 'Réf #42; "Q3"' })).toBe('Received from Muller Sohne GmbH - Ref 42 Q3')
  })

  it('splits QBO files at 1000 lines', () => {
    const src = structuredClone(exampleSource)
    const txs: typeof src.txs = {}
    src.transfers = []
    for (let i = 0; i < 1500; i++) {
      const txHash = `0x${i.toString(16).padStart(64, '0')}` as const
      src.transfers.push({ asset: 'EURC', txHash, logIndex: 0, blockNumber: 18_000_000n + BigInt(i), from: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', to: ME, value: 1_000_000n })
      txs[txHash] = { from: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', gasUsed: 1n, effectiveGasPrice: 1n, memos: [] }
      src.blockTimestamps[(18_000_000n + BigInt(i)).toString()] = Date.UTC(2026, 8, 2) / 1000 + i
    }
    src.txs = txs
    src.assets = ['EURC']
    src.balances = { opening: { EURC: 0n }, closing: { EURC: 1_500_000_000n } }
    const files = exportQbo(buildReport(src), exampleAnnotations)
    expect(files.map((f) => f.name.replace(/^.*_qbo_/, ''))).toEqual(['EURC_part1.csv', 'EURC_part2.csv'])
    expect(files[0]!.content.trimEnd().split('\r\n')).toHaveLength(1001)
    expect(files[1]!.content.trimEnd().split('\r\n')).toHaveLength(501)
  })
})
