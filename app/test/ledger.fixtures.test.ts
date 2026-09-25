/**
 * fetchLedger against real Arc mainnet responses recorded by scripts/record-fixtures.ts.
 * Covers: in/out, multi-transfer tx, native transfer, memo tx, fee attribution, EURC,
 * relayer-paid outflows, CCTP mints and reconciliation of fee-only transactions.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchLedger, type Progress } from '../src/chain/ledger'
import { replayRpc, type RpcFixture } from '../src/chain/replay'
import { nativeToErc20 } from '../src/money/usdc'
import { reportHash } from '../src/report/canonical'
import { checkReportConsistency } from '../src/report/file'
import type { CanonicalRow } from '../src/report/types'

const load = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')) as RpcFixture
const run = async (f: RpcFixture, extra: Partial<Parameters<typeof fetchLedger>[3]> = {}) => {
  const rpc = replayRpc(f)
  const result = await fetchLedger(f.address as `0x${string}`, f.periodStart, f.periodEnd, { rpc, assets: f.assets, ...extra })
  expect(rpc.misses).toEqual([])
  return result
}
const rowsOf = (rows: CanonicalRow[], txPrefix: string) => rows.filter((r) => r.txHash.startsWith(txPrefix))

describe('fixture: business (real mainnet, ~24h)', async () => {
  const f = load('business')
  const { report, partial } = await run(f)

  it('finds every movement once, sorted by (block, logIndex)', () => {
    expect(report.rows).toHaveLength(32)
    expect(partial).toBe(false)
    const keys = report.rows.map((r) => `${r.blockNumber}:${r.logIndex}`)
    expect(new Set(keys).size).toBe(32)
    const sorted = [...report.rows].sort((a, b) => (BigInt(a.blockNumber) === BigInt(b.blockNumber) ? a.logIndex - b.logIndex : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1))
    expect(report.rows).toEqual(sorted)
    expect(checkReportConsistency(report)).toEqual([])
  })

  it('maps the period to blocks (timestamps may repeat)', () => {
    expect(report.blockRange).toEqual({ from: '22551999', to: '22725999' })
  })

  it('multi-transfer tx (USDC out + EURC in): fee charged once, on the first row', () => {
    const rows = rowsOf(report.rows, '0x9a061f9f15')
    expect(rows.map((r) => [r.logIndex, r.direction, r.asset, r.amount, r.decimals])).toEqual([
      [17, 'out', 'USDC', '0.1', 18],
      [34, 'in', 'EURC', '0.08766', 6],
    ])
    expect(rows.map((r) => r.feeUSDC)).toEqual(['0.01039604', null])
  })

  it('fee sits on an EURC row when that is the first row of the tx', () => {
    const rows = rowsOf(report.rows, '0x9a7ad7a7e7')
    expect(rows.map((r) => [r.asset, r.direction, r.feeUSDC])).toEqual([
      ['EURC', 'out', '0.0102874212'],
      ['USDC', 'in', null],
    ])
  })

  it('memo tx: memo decoded and copied to every row, fee once', () => {
    const rows = rowsOf(report.rows, '0x0f5b2e566c')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.memo === 'ELLIGENTE|SEND|0xBBE4Bf|USDC|0.01')).toBe(true)
    expect(rows.map((r) => r.feeUSDC)).toEqual(['0.002577498', null])
    expect(rowsOf(report.rows, '0xf3363698dd')[0]!.memo).toBe('ELLIGENTE|SEND|0x01dE54|USDC|0.01')
  })

  it('relayer-paid outflow: no fee for the queried address', () => {
    const [row] = rowsOf(report.rows, '0x797210c377')
    expect(row).toMatchObject({ direction: 'out', asset: 'USDC', amount: '0.1002', feeUSDC: null })
  })

  it('CCTP mint shows up as an inflow from the zero address', () => {
    const [row] = rowsOf(report.rows, '0x325f5c91dc')
    expect(row).toMatchObject({ direction: 'in', counterparty: '0x0000000000000000000000000000000000000000', amount: '4.9875' })
  })

  it('totals are exact', () => {
    expect(report.totals).toEqual({
      EURC: { in: '0.96473', out: '0.9', fees: '0', net: '0.06473' },
      USDC: { in: '6.718462', out: '1.51096', fees: '0.0361292080488', net: '5.1713727919512' },
    })
  })

  it('reconciliation exposes 12 fee-only txs that no Transfer log lists', () => {
    expect(report.reconciliation.sentTxCount).toBe(19)
    expect(report.reconciliation.itemizedSentTxCount).toBe(7)
    expect(report.reconciliation.EURC).toEqual({ opening: '0.007612', closing: '0.072342', unexplained: '0' })
    expect(report.reconciliation.USDC).toEqual({ opening: '1.147980378908', closing: '6.30595786831024574', unexplained: '-0.01339530254895426' })
  })

  it('has a stable report hash', () => {
    expect(reportHash(report)).toMatchInlineSnapshot(`"0x1ec7d478c90f1d6a9e2fe4592f8ef3bfa17bc349efd5b9eeb74c5db68fb9c2b6"`)
  })

  it('reports progress through every phase', async () => {
    const seen: Progress[] = []
    await run(f, { onProgress: (p) => seen.push(p) })
    expect([...new Set(seen.map((p) => p.phase))]).toEqual(['range', 'logs', 'receipts', 'blocks', 'balances', 'done'])
    const lastLogs = seen.filter((p) => p.phase === 'logs').at(-1)!
    expect(lastLogs.blocksScanned).toBe(lastLogs.blocksTotal)
    expect(lastLogs.done).toBe(18) // 174,001 blocks in 10k-block windows
  })

  it('can be cancelled', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(run(f, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('fixture: native (plain native USDC send, real mainnet)', async () => {
  const f = load('native')
  const { report } = await run(f)

  it('records the native transfer at 18 decimals from the EIP-7708 log', () => {
    expect(report.rows).toHaveLength(1)
    const [row] = report.rows
    expect(row).toMatchObject({
      direction: 'out',
      asset: 'USDC',
      amount: '0.000004696512057275',
      amountRaw: '4696512057275',
      decimals: 18,
      counterparty: '0xd9c6c84b1d89377145f922d54ebf6d5bbce49062',
      feeUSDC: '0.000527625',
      memo: null,
    })
    expect(typeof row!.logIndex).toBe('number')
    // the 6-decimal ERC-20 view would have recorded 0.000004 USDC
    expect(nativeToErc20(BigInt(row!.amountRaw))).toBe(4n)
  })

  it('reconciles to the wei: opening + net == closing', () => {
    expect(report.reconciliation).toEqual({
      sentTxCount: 1,
      itemizedSentTxCount: 1,
      EURC: { opening: '5.662774', closing: '5.662774', unexplained: '0' },
      USDC: { opening: '0.88212650905720064', closing: '0.881594187545143365', unexplained: '0' },
    })
  })
})
