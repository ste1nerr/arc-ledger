/**
 * Phase 0 probe: print the last 10 USDC movements of an address on Arc mainnet.
 *
 * Usage: pnpm probe [address]
 *
 * Source of truth for USDC movements is the EIP-7708 native Transfer log emitted by
 * the system address 0xffff…fffe (18 decimals). It covers native sends and the native
 * leg of ERC-20 USDC transfers, so the 6-decimal logs from 0x3600…0000 are ignored
 * to avoid double counting. See docs/ARC_FACTS.md.
 */
import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbiItem, type Log } from 'viem'

const RPC_URL = 'https://rpc.mainnet.arc.io'
const CHAIN_ID = 5042
const NATIVE_USDC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
const MAX_BLOCK_RANGE = 10_000n // public RPC limit per eth_getLogs call (inclusive range)
const MAX_WINDOWS = 2_000 // ~11.5 days of blocks at ~0.5 s/block
const WANT = 10
const DEFAULT_ADDRESS = '0x287a9e467808940fdb31a7fb3a48d4eeb948a048'

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

const client = createPublicClient({
  transport: http(RPC_URL, { retryCount: 8, retryDelay: 1_000 }),
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const arg = process.argv[2] ?? DEFAULT_ADDRESS
  if (!isAddress(arg, { strict: false })) throw new Error(`Not an address: ${arg}`)
  const address = getAddress(arg)

  const chainId = await client.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`Expected chain ${CHAIN_ID}, RPC returned ${chainId}`)

  const head = await client.getBlockNumber()
  console.log(`Arc mainnet (chain ${chainId}), head block ${head}`)
  console.log(`Scanning back for the last ${WANT} USDC movements of ${address}…\n`)

  const found: Log<bigint, number, false, typeof transferEvent>[] = []
  let to = head
  for (let w = 0; w < MAX_WINDOWS && found.length < WANT && to > 0n; w++) {
    const from = to >= MAX_BLOCK_RANGE - 1n ? to - (MAX_BLOCK_RANGE - 1n) : 0n
    // Topic positions are ANDed, so "from = me" and "to = me" need two calls.
    const [outLogs, inLogs] = await Promise.all([
      client.getLogs({ address: NATIVE_USDC_EMITTER, event: transferEvent, args: { from: address }, fromBlock: from, toBlock: to }),
      client.getLogs({ address: NATIVE_USDC_EMITTER, event: transferEvent, args: { to: address }, fromBlock: from, toBlock: to }),
    ])
    const windowLogs = [...outLogs, ...inLogs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
    )
    found.push(...windowLogs)
    process.stderr.write(`\r  scanned blocks ${from}–${head}  found ${found.length}   `)
    to = from - 1n
    await sleep(600) // stay under the public RPC rate limit
  }
  process.stderr.write('\n\n')

  const rows = found.slice(0, WANT)
  if (rows.length === 0) {
    console.log('No USDC movements found in the scanned range.')
    return
  }

  const blockTimes = new Map<bigint, bigint>()
  for (const l of rows) {
    if (!blockTimes.has(l.blockNumber)) {
      blockTimes.set(l.blockNumber, (await client.getBlock({ blockNumber: l.blockNumber })).timestamp)
    }
  }

  for (const l of rows) {
    const { from, to: dest, value } = l.args
    const isOut = getAddress(from!) === address
    const ts = new Date(Number(blockTimes.get(l.blockNumber)!) * 1000).toISOString()
    console.log(
      [
        ts,
        `#${l.blockNumber}:${l.logIndex}`,
        isOut ? 'OUT' : 'IN ',
        `${isOut ? '-' : '+'}${formatUnits(value!, 18)} USDC`,
        `${isOut ? 'to  ' : 'from'} ${isOut ? dest : from}`,
        l.transactionHash,
      ].join('  '),
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
