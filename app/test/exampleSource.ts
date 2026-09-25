/** The illustrative dataset behind docs/examples (REPORT_SPEC §7), as a LedgerSource. */
import { stringToHex, type Address, type Hex } from 'viem'
import type { LedgerSource } from '../src/report/build'
import type { Annotations } from '../src/report/types'

const H = (c: string) => `0x${c.repeat(64)}` as Hex
export const ME = '0x287a9E467808940FDB31A7fB3a48d4eEB948A048' as Address
const CLIENT = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' as Address
const iso = (s: string) => Date.parse(s) / 1000

export const exampleSource: LedgerSource = {
  chainId: 5042,
  address: ME,
  periodStart: Date.UTC(2026, 8, 1) / 1000,
  periodEnd: Date.UTC(2026, 9, 1) / 1000,
  blockRange: { from: 17540166n, to: 22651305n },
  assets: ['USDC', 'EURC'],
  transfers: [
    // deliberately unsorted and with a duplicate, like the two log queries return them
    { asset: 'EURC', txHash: H('d'), logIndex: 0, blockNumber: 20790002n, from: CLIENT, to: ME, value: 100_000_000n },
    { asset: 'USDC', txHash: H('a'), logIndex: 0, blockNumber: 17904001n, from: CLIENT, to: ME, value: 1250500000000000000000n },
    { asset: 'USDC', txHash: H('b'), logIndex: 1, blockNumber: 19121450n, from: ME, to: '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', value: 300n * 10n ** 18n },
    { asset: 'EURC', txHash: H('c'), logIndex: 4, blockNumber: 20260880n, from: ME, to: '0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb', value: 50_000_000n },
    { asset: 'USDC', txHash: H('c'), logIndex: 2, blockNumber: 20260880n, from: ME, to: '0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb', value: 12345678901234567891n },
    { asset: 'USDC', txHash: H('a'), logIndex: 0, blockNumber: 17904001n, from: CLIENT, to: ME, value: 1250500000000000000000n },
  ],
  txs: {
    [H('a')]: { from: CLIENT, gasUsed: 55_000n, effectiveGasPrice: 20_000_000_000n, memos: [{ logIndex: 1, memo: stringToHex('INV-2026-014') }] },
    [H('b')]: { from: ME, gasUsed: 55_000n, effectiveGasPrice: 23_000_000_000n, memos: [{ logIndex: 2, memo: stringToHex('Design work, Sept') }] },
    [H('c')]: { from: ME, gasUsed: 102_050n, effectiveGasPrice: 20_000_000_000n, memos: [] },
    [H('d')]: { from: CLIENT, gasUsed: 60_000n, effectiveGasPrice: 20_000_000_000n, memos: [] },
  },
  blockTimestamps: {
    '17904001': iso('2026-09-03T09:15:02Z'),
    '19121450': iso('2026-09-10T14:02:40Z'),
    '20260880': iso('2026-09-17T00:41:17Z'),
    '20790002': iso('2026-09-20T03:12:59Z'),
  },
  balances: {
    opening: { USDC: 500_250000000000000000n, EURC: 0n },
    closing: { USDC: 1438_401015098765432109n, EURC: 50_000_000n },
  },
  nonces: { opening: 0, closing: 2 },
}

export const exampleAnnotations: Annotations = {
  counterpartyLabels: { '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed': 'Acme GmbH' },
  categories: { [`${H('a')}:0`]: 'income', [`${H('b')}:1`]: 'expense' },
}

export const EXAMPLE_HASH = '0xb10af9fe7785f38eef5791119ee2b092d36ad44aaf7db2c021f727764d516f7a'
