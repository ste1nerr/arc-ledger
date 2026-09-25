# Arc facts

Every fact the app depends on, with its source. "Measured" means checked by hand against Arc mainnet on **2026-09-25** (head block ≈ 22,731,000). Official docs are the source of truth. Measurements show how public infrastructure behaves today and may change.

## 1. Network

| Fact | Value | Source |
|---|---|---|
| Chain ID (mainnet) | `5042` (`0x13b2`) | [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc), measured `eth_chainId` |
| Chain ID (testnet) | `5042002`, not used by this app | same |
| Native currency | USDC, 18 decimals | same |
| Public RPC | `https://rpc.mainnet.arc.io` | same, [Node providers](https://docs.arc.io/arc/tools/node-providers) |
| Other listed RPCs | `rpc.blockdaemon.mainnet.arc.io`, `rpc.drpc.mainnet.arc.io`, `rpc.quicknode.mainnet.arc.io`, Alchemy (key required) | [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc) |
| Explorer | `https://explorer.arc.io` (Blockscout) | same, measured |
| Public mainnet launch | 2026-09-16. Block 1 timestamp is 2026-05-15T13:58:51Z | [Circle press release](https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet), measured |

### RPC behavior (measured)

| Endpoint | Browser CORS | `eth_getLogs` max range | History | Notes |
|---|---|---|---|---|
| `rpc.mainnet.arc.io` | ✅ echoes any `Origin` | **10,000 blocks** (inclusive) and max 2,000 results | full archive (logs + state) | `-32005 rate limit exceeded` |
| `rpc.quicknode.mainnet.arc.io` | ✅ | 10,000 blocks | full archive | appears to share the rate budget with the primary |
| `rpc.blockdaemon.mainnet.arc.io` | ✅ `*` | 100,000 blocks, max 20,000 results | ❌ **pruned: only the last ~730k blocks (~4 days)** | `4444 pruned history unavailable` |
| `rpc.drpc.mainnet.arc.io` | ✅ | < 1,000 blocks on the free plan | — | not usable for history |

- **Rate limit:** about **1–2 `eth_getLogs` calls per second in total per client IP**. Bursts above ~3 calls fail. Each call inside a JSON-RPC batch counts separately, so batching does not help.
- Archive state (`eth_getBalance`, `eth_getTransactionCount` at old blocks) works on the primary RPC.

## 2. Block time and finality

| Fact | Value | Source |
|---|---|---|
| Block time | **≈ 0.507 s** (100,000 blocks in 50,741 s) | measured. Docs describe "sub-second blocks" |
| Blocks per 30 days | ≈ 5.1 million, so ≈ 511 windows of 10k blocks | derived |
| Timestamps | non-decreasing, 1-second granularity: **several blocks can share a timestamp** | [EVM differences](https://docs.arc.io/arc/references/evm-differences) |
| Ordering key | `blockNumber`, then `logIndex`. Never the timestamp | [Index Arc events](https://docs.arc.io/integrate/infrastructure/indexing-events) |
| Finality | deterministic and instant on inclusion. No reorgs, so no confirmation depth is needed | [Deterministic finality](https://docs.arc.io/arc/concepts/deterministic-finality) |

**Feasibility of `eth_getLogs` over a month from the browser:** it works, but slowly. One month for one address needs 2 filters (`from = me`, `to = me`) × ~511 windows ≈ **1,020 calls, which takes about 9–17 minutes** at the measured rate. See the decision in §8.

## 3. Tokens (mainnet)

| Asset | Address | Decimals | Source |
|---|---|---|---|
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000` | **6** | [Contract addresses](https://docs.arc.io/arc/references/contract-addresses). `decimals()`/`symbol()` measured: `6`/`USDC` |
| USDC (native, gas token) | n/a | **18** | [EVM differences](https://docs.arc.io/arc/references/evm-differences) |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | **6** | [Contract addresses](https://docs.arc.io/arc/references/contract-addresses). Measured: `6`/`EURC` |

⚠️ The code samples on the [indexing guide](https://docs.arc.io/integrate/infrastructure/indexing-events) use the **testnet** EURC (`0x89B5…D72a`) and testnet CCTP addresses. Use the mainnet addresses above.

### Native vs ERC-20 USDC

- There is **one balance** with two views: native (18 decimals) and ERC-20 (6 decimals). Dividing native by 10¹² gives USDC. ([EVM differences](https://docs.arc.io/arc/references/evm-differences), [Stablecoin native model](https://docs.arc.io/arc/concepts/stablecoin-native-model))
- Docs: *"Don't use the 6-decimal value when crediting or recording balances; truncation at the 6-decimal boundary records less than was transferred. A zero `balanceOf` doesn't mean the native balance is zero."*
- **Policy for this app:** record USDC at **18 decimals** from the native stream. Round only for display and export, and the report spec defines exactly how (Phase 1).

## 4. How USDC and EURC movements appear (the answer to Q3)

Arc implements **EIP-7708**. Every explicit USDC movement emits a standard `Transfer(address indexed from, address indexed to, uint256 value)` log from a **system emitter**. ([USDC system events](https://docs.arc.io/arc/references/usdc-system-events))

| Stream | Emitter | topic0 | Decimals | Covers |
|---|---|---|---|---|
| Native USDC (system) | `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` | `0xddf252ad…3b3ef` | 18 | plain native sends, the native leg of ERC-20 `transfer`/`transferFrom`, `CREATE` endowments, `SELFDESTRUCT`, mint/burn (to or from `0x0`) |
| ERC-20 USDC | `0x3600…0000` | same | 6 | ERC-20 interface calls only (**duplicates** the system log) |
| EURC | `0xbEf5…21c1` | same | 6 | normal ERC-20 |

Rules from the docs, confirmed on mainnet:
- An ERC-20 USDC `transfer()` emits **two** logs (system 18-dec plus contract 6-dec). **Index only the system emitter for USDC** to avoid double counting. Seen in tx `0x00be75d9…1b0f`, logs 3 and 4.
- Zero-value transfers and **self-transfers (`from == to`) emit no log.** So a `self` row can never come from a USDC log. It can only come from a self-sent tx that paid a fee.
- For EIP-3009 and relayed transfers, use the log's `from`, not `tx.from`.
- The docs say the system log is emitted first in the tx. **This is not true on mainnet when the Memo contract wraps the call** (a `BeforeMemo` log comes first). Do not rely on log order.
- **Gas fees and block rewards emit no log.** ([USDC system events](https://docs.arc.io/arc/references/usdc-system-events))

**Conclusion:** event logs are enough for all USDC and EURC movements. `eth_getLogs` on `[systemEmitter, EURC]` with topic `from = me` or `to = me` gives the complete movement set.

## 5. Memo (Q4)

| Fact | Value | Source |
|---|---|---|
| Contract | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` (mainnet and testnet), 1,228 bytes of code | [Contract addresses](https://docs.arc.io/arc/references/contract-addresses), measured `eth_getCode` |
| Mechanism | The caller sends the tx to the Memo contract. It forwards the call via the CallFrom precompile, preserving `msg.sender`, and emits an event | [Index Arc events, step 4](https://docs.arc.io/integrate/infrastructure/indexing-events) |
| Event | `Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)` | same |
| topic0 | `0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4` | computed with viem, matches mainnet logs |
| Also emits | `BeforeMemo` (topic0 `0xb252e055…`), which should be ignored | measured |
| Payload | arbitrary `bytes`, usually UTF-8 text. Example on mainnet: tx `0x00be75d9…1b0f`, memo `"cycles_sweep"`, target Multicall3 | measured |

**Decoding plan:** memos belong to a **transaction, not to one transfer**. The Memo `sender` can differ from the Transfer `from`, as in the example where the target is Multicall3 and a smart wallet moves the funds. So we attach memos by `txHash`, read them from the tx receipt (which we fetch anyway for fees), decode them as UTF-8 when valid, and fall back to hex otherwise.

## 6. Fees (Q5)

- Fee = `gasUsed × effectiveGasPrice`, in **18-decimal native USDC**. The receipt exposes both fields, plus `from`. It has **no** explicit fee field. ([USDC system events, "Out of scope: gas fees"](https://docs.arc.io/arc/references/usdc-system-events))
- Measured: tx `0x00be75d9…1b0f` had `gasUsed = 1,764,536` and `effectiveGasPrice = 23 gwei`, so the fee was `0.040584328` USDC, exact.
- The fee is paid by `receipt.from` (the tx sender), which is **not** necessarily the Transfer `from` (relayers, smart wallets, Memo wrapper).
- The base fee is paid to the block proposer, not burned. The minimum base fee is 20 gwei. ([Gas and fees](https://docs.arc.io/arc/references/gas-and-fees), [Stable fee design](https://docs.arc.io/arc/concepts/stable-fee-design))

### ⚠️ Known gap: fees on transactions without transfers
Transactions that the address sends but that move no USDC or EURC (approvals, contract calls, and **`closePeriod` itself**) produce **no Transfer log**. Plain RPC cannot list them, because there is no "transactions by sender" RPC method. Mitigations for Phase 3:
1. **Nonce check.** `eth_getTransactionCount(addr)` at the period start and end blocks gives the exact number of txs the address sent. If it is greater than the txs we found, the report shows "N sent transactions with fees not itemized".
2. **Balance reconciliation.** `opening + in − out − fees == closing`, using archive `eth_getBalance` (18 dec) and EURC `balanceOf`. Any difference is shown as an explicit "unreconciled" line. This turns the gap into a visible, exact number instead of a silent error.

## 7. Explorer (Q2)

| Fact | Value | Source |
|---|---|---|
| Type | **Blockscout** (Next.js frontend, API on the same host `explorer.arc.io`) | measured (`envs.js`: `NEXT_PUBLIC_API_HOST: "explorer.arc.io"`) |
| Public API | `/api/v2/...` and the Etherscan-style `/api?module=…` exist, but **every non-browser request gets `403` with `cf-mitigated: challenge`** (Cloudflare managed challenge), including requests sent with a browser User-Agent and Origin | measured |
| Usable from our site or a Vercel function | ❌ no. A cross-origin `fetch` cannot solve the challenge | measured |
| Etherscan (`arc.etherscan.io`) | exists. The Etherscan v2 API supports chainid 5042 with CORS `*`, but needs an API key and is **free only until 2026-10-15. From 2026-10-16 it needs a paid Lite plan.** Source-code verification endpoints stay free | [Etherscan supported chains](https://docs.etherscan.io/supported-chains), measured |
| Other indexers | Alchemy, Envio, Goldsky, Pinax, The Graph, thirdweb Insight, Zerion. All need keys or hosting | [Data indexers](https://docs.arc.io/arc/tools/data-indexers) |

## 8. Data-source decision: **C (RPC `eth_getLogs`), browser only, no proxy**

- **A is rejected.** The Blockscout API is behind a Cloudflare challenge.
- **B is rejected.** A Vercel proxy would hit the same challenge. An Etherscan-backed proxy would need a secret key and becomes **paid from 2026-10-16**, which breaks "build once, no maintenance" right after the submission deadline.
- **C is chosen.** The public RPC has CORS, a full archive, and EIP-7708 makes logs complete for USDC and EURC movements.

Plan for C:
- Map the period `[start, end)` to blocks with interpolation search on `eth_getBlockByNumber` (~0.507 s/block as the first guess, then a few refining calls).
- For each 10k-block window, make 2 calls: `address: [systemEmitter, EURC]` with `topics: [Transfer, me]` and `topics: [Transfer, null, me]`. Paging handles the `max results 2,000` error by splitting the window (the error suggests a range).
- Fetch receipts for every tx found (memo + fee), then run the nonce check and balance reconciliation (§6).
- Use a client-side rate limiter (~1.5 calls/s) with exponential backoff on `-32005`, spread over the primary and QuickNode endpoints. Show progress and ETA, and support cancel.

**Gaps and risks to accept or decide on:**
1. **Speed.** ~10–15 min for one month and ~2–3 h for a year on the public RPC. That is fine for "close last month", but slow for a reviewer clicking around. Options are in the status report.
2. **Fee-only transactions** are not itemized. They are detected and quantified via nonce and balance reconciliation (§6).
3. The Blockdaemon endpoint can speed up only the last ~4 days (100k-block windows).

## 9. Side check (Q7)

- **revoke.cash supports Arc**: <https://revoke.cash/token-approval-checker/arc> (HTTP 200, listed as Arc).

## 10. Deployed contracts (filled after Phase 2)

| Contract | Address | Explorer |
|---|---|---|
| PeriodCloseRegistry | _not deployed yet_ | |
