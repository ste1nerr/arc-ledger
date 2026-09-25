# Arc Ledger report spec (version 1)

This document defines the ledger model, the canonical report and its hash, and the four export formats. Code must follow it. If code and spec disagree, fix one of them in the same commit.

Arc facts used here (addresses, decimals, event streams) are sourced in [ARC_FACTS.md](ARC_FACTS.md). The JSON schema of the export file is [report.schema.json](report.schema.json). The example files are in [examples/](examples/).

---

## 1. Money rules

1. **No JavaScript `number` for money, anywhere.** Amounts are `bigint` in raw units, or canonical decimal strings (§1.2). The only `number`s in the model are `chainId`, `logIndex`, `decimals`, `periodStart` and `periodEnd`. A lint rule (`no-restricted-syntax` against `parseFloat`, `Number(`, unary `+` and `toFixed` in `src/money/**` and `src/report/**`) and a test that scans those directories enforce this.
2. **Canonical decimal string.** Written as `format(raw, decimals)`:
   - no exponent, no `+`, no thousands separators, and `.` is the decimal separator
   - no leading zeros (`0.5`, not `.5` or `00.5`), and **no trailing fractional zeros** (`300`, not `300.000000`)
   - zero is `"0"`, never `"-0"`
   - `parse(format(x, d), d) === x` for every bigint `x` (property-tested).
3. **USDC is recorded at 18 decimals.** It comes from the native EIP-7708 stream. The 6-decimal ERC-20 view is never used to record amounts, because it truncates (ARC_FACTS §3).
4. **The 18 ↔ 6 conversion lives in exactly one module** (`src/money/usdc.ts`):
   - `nativeToErc20(raw18) = raw18 / 10^12`, **truncating toward zero**. This matches what `balanceOf` returns on chain.
   - `erc20ToNative(raw6) = raw6 * 10^12` (exact).
   - Property tests: `erc20ToNative(nativeToErc20(x)) <= x`, the difference is `< 10^12`, and `nativeToErc20(erc20ToNative(y)) === y`.
   - The app uses this module only to compare with on-chain `balanceOf` in reconciliation. Ledger amounts never pass through it.
5. **Rounding to 2 decimals** happens only in the Xero and QuickBooks exports (§6.3), always **half away from zero**, and a rounding-adjustment line keeps the file total exact to the cent.

---

## 2. Ledger row (internal model)

One row per **Transfer log that involves the queried address**.

| field | type | notes |
|---|---|---|
| `chainId` | `number` | always `5042` |
| `txHash` | `0x` + 64 hex, lowercase | |
| `logIndex` | `number` | log index within the block. **Never null on Arc**: native transfers have EIP-7708 logs too (the brief assumed `null`, which does not apply) |
| `blockNumber` | `bigint` | |
| `timestamp` | ISO-8601 UTC, seconds precision, `Z` suffix | block timestamp. Several blocks can share one |
| `direction` | `in` \| `out` \| `self` | `out` if `from == me`, `in` if `to == me`, `self` if both (only possible for EURC: USDC self-transfers emit no log) |
| `asset` | `USDC` \| `EURC` | USDC is taken **only** from emitter `0xffff…fffe`, EURC only from `0xbEf5…21c1`. The ERC-20 USDC logs from `0x3600…0000` are ignored (they duplicate the native log) |
| `amount` | canonical decimal string | unsigned. `direction` gives the sign |
| `amountRaw` | bigint as decimal string | |
| `decimals` | `18` (USDC) \| `6` (EURC) | |
| `counterparty` | address, lowercase | `to` for `out`, `from` for `in`, own address for `self`. Mint and burn show `0x000…000` |
| `counterpartyLabel` | `string` | **private**, from localStorage, not hashed |
| `memo` | `string \| null` | §2.2 |
| `feeUSDC` | canonical decimal string \| `null` | §2.1 |
| `category` | `income` \| `expense` \| `transfer` \| `fee` \| `uncategorized` | **private**, from localStorage, default `uncategorized`, not hashed |

**Sorting:** by `(blockNumber, logIndex)` ascending. The brief's `(blockNumber, logIndex ?? -1, txHash)` reduces to this, because `logIndex` is unique within a block and never null.

**De-duplication:** the `from = me` and `to = me` queries can both return the same log (a `self` transfer). The key is `(blockNumber, logIndex)`.

### 2.1 Fees
- A tx's fee is `receipt.gasUsed × receipt.effectiveGasPrice`, in raw 18-decimal USDC.
- The fee counts for the queried address **only if `receipt.from == me`**. Relayed or sponsored txs are paid by someone else.
- It goes on the **first row of that tx** (lowest `logIndex`) and **nowhere else**. Other rows of the same tx have `feeUSDC: null`. This holds even if that first row is EURC or `in`.
- Fees always count toward `totals.USDC.fees`, even when the fee sits on an EURC row. If the report excludes USDC, the fees still appear in the rows but in no totals, and the UI warns about this.
- **Fee-only txs** (sent by `me`, but no Transfer involves `me`) cannot be listed with plain RPC. They are quantified in `reconciliation` (§3.3) and never silently dropped.

### 2.2 Memos
- Source: `Memo(...)` events from `0x5294…e505` found in the **receipt** of each tx in the ledger. They are matched **by `txHash`**, not by sender, because the Memo `sender` can differ from the Transfer `from`.
- Decoding: if the `memo` bytes are valid UTF-8 and contain no C0 control characters other than `\t`, use the text as-is (no trimming). Otherwise use the `0x`-prefixed lowercase hex.
- A tx with several memos gets them joined by `" | "` in `logIndex` order.
- The memo is copied onto **every row of that tx**.
- `BeforeMemo` events are ignored.

---

## 3. Canonical report and hash

This is what `closePeriod` commits on chain.

### 3.1 Shape

```jsonc
{
  "version": 1,
  "chainId": 5042,
  "address": "0x…",              // lowercase
  "periodStart": 1788220800,     // unix seconds UTC, inclusive
  "periodEnd":   1790812800,     // unix seconds UTC, exclusive:  [start, end)
  "blockRange": { "from": "17540166", "to": "22651305" },   // first/last block with start <= timestamp < end
  "assets": ["EURC", "USDC"],    // sorted, the assets the user included
  "rows": [ /* canonical rows, sorted per §2 */ ],
  "totals": { "USDC": { "in": "…", "out": "…", "fees": "…", "net": "…" }, "EURC": { … } },
  "reconciliation": {
    "sentTxCount": 2,            // nonce(blockRange.to) - nonce(blockRange.from - 1)
    "itemizedSentTxCount": 2,    // distinct txs in rows with receipt.from == me
    "USDC": { "opening": "…", "closing": "…", "unexplained": "…" },
    "EURC": { … }
  }
}
```

- **Canonical row** = the ledger row **without** `chainId` (it is at the top level), `counterpartyLabel` and `category`. Its fields: `amount, amountRaw, asset, blockNumber, counterparty, decimals, direction, feeUSDC, logIndex, memo, timestamp, txHash`.
- Rows include only assets listed in `assets`.
- `totals[asset]`: `in` = sum of `in` rows, `out` = sum of `out` rows (`self` rows are in neither), `fees` = sum of `feeUSDC` (USDC only, `"0"` for EURC), `net = in − out − fees`.
- `reconciliation[asset]`: `opening` = balance at the end of block `blockRange.from − 1`, `closing` = balance at the end of block `blockRange.to`, `unexplained = closing − opening − net`. USDC balances come from `eth_getBalance` (18 dec) and EURC from `balanceOf` via `eth_call` at that block. A non-zero `unexplained` usually means fee-only txs, or incoming fees if the address is a block proposer. The UI and every export show it.
- **Additions to the brief:** `blockRange` and `reconciliation`. Both are deterministic chain facts. They let an auditor confirm the report is complete, not just unaltered.
- **Empty period:** `blockRange` is still set. If no block falls inside the period, the report is rejected with "period contains no blocks". An empty `rows` array is valid.

### 3.2 Serialization (deterministic JSON)
A strict subset of [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785):
- Object keys sorted by UTF-16 code units (JS default `sort()`). All keys are ASCII.
- No whitespace anywhere.
- Strings escaped exactly as `JSON.stringify` does.
- Numbers: **safe integers only**. Any non-integer or unsafe number throws, and all money is strings.
- `null` is allowed. `undefined` and absent optional fields are not: every field is always present.
- Array order is preserved: rows are pre-sorted and `assets` is pre-sorted.

`reportHash = keccak256(utf8Bytes(canonicalJson(report)))`, as a `bytes32` hex string in lowercase.

### 3.3 Export file (`*.report.json`)
```json
{ "format": "arc-ledger-report", "reportHash": "0x…", "report": { … }, "annotations": { … }, "generator": { … } }
```
- The file itself is pretty-printed. **Only `report` is hashed**: Verify parses the file, re-canonicalizes `report` and recomputes the hash. It never trusts the `reportHash` field and only shows it if it differs.
- `annotations` holds `counterpartyLabels` (lowercase address → string) and `categories` (`"<txHash>:<logIndex>"` → category). They are private and non-canonical: editing them does not change the hash.
- A golden-file test pins `examples/report.json` → `0xb10af9fe7785f38eef5791119ee2b092d36ad44aaf7db2c021f727764d516f7a`, and checks that changing any single canonical field changes the hash while changing annotations does not.

---

## 4. Period → block range
- `blockRange.from` = the lowest block with `timestamp >= periodStart`.
- `blockRange.to` = the highest block with `timestamp < periodEnd`.
- Found by interpolation search on `eth_getBlockByNumber` (≈0.507 s/block as the first guess), then a binary refine. Timestamps are non-decreasing, so the search is well defined even when several blocks share a timestamp.
- The UI builds periods in **UTC**: "last month" means `[first day 00:00:00Z, first day of the next month 00:00:00Z)`.

---

## 5. Common export rules
- **Dates are UTC.** The generic CSV says so in the column name (`timestamp_utc`). For Xero and QBO the date carries no time. The README and the Export screen state "All dates are UTC".
- `.` is the decimal separator, with no thousands separators and no currency symbols.
- CSV follows RFC 4180: comma separator, CRLF line endings, fields quoted when they contain `,` `"` CR or LF, and `"` doubled.
- **CSV-injection guard:** any **text** field (label, memo, category, payee, description) that starts with `= + - @ \t \r` gets a leading `'`. Memos are written by whoever sends you money, so they are untrusted input. Numeric columns are never prefixed.
- File name: `arc-ledger_<first 8 hex of address>_<YYYY-MM-DD>_<YYYY-MM-DD>_<format>[_<ASSET>][_part<N>].csv`. The second date is the **last included day** (`periodEnd − 1s`).

---

## 6. Export formats

### 6.1 Generic CSV
UTF-8 **with BOM**, so Excel reads non-ASCII memos correctly. Google Sheets ignores the BOM. One row per movement, plus one **separate `fee` row** right after each row that carries a fee. There is **no** fee column, so summing `signed_amount` per asset never double-counts.

Columns: `row_type` (`transfer` \| `fee` \| `unexplained`), `chain_id`, `timestamp_utc`, `block_number`, `tx_hash`, `log_index` (empty on fee rows), `direction`, `asset`, `amount` (unsigned, exact), `signed_amount` (`-` for out and fee), `decimals`, `amount_raw`, `counterparty` (EIP-55 checksummed), `counterparty_label`, `memo`, `category`.

If `reconciliation[asset].unexplained != 0`, a final row with `row_type = unexplained` is added for that asset, dated `periodEnd − 1s`. Then Σ `signed_amount` = `closing − opening` exactly.

### 6.2 Xero bank statement CSV
Source: [Xero Central: Import a bank statement in CSV format](https://central.xero.com/0/article/Import-a-CSV-bank-statement). Only Date and Amount are required. Income and expenses go in **one** Amount column, expenses negative with `-`. No commas in amounts. Accepted dates are `DD/MM/YYYY`, `MM/DD/YYYY` or `YYYY/MM/DD`. Payee must match the Xero contact name exactly to avoid duplicates. Xero shows a column-mapping step on import.

- **One file per asset.** A Xero bank account has one currency: map the USDC file to a USD account and the EURC file to a EUR account.
- Header `Date,Amount,Payee,Description,Reference`.
- `Date`: `YYYY/MM/DD`, the only unambiguous option Xero lists.
- `Amount`: signed, 2 decimals (§6.3).
- `Payee`: the counterparty label if set, otherwise the checksummed address.
- `Description`: `Arc <ASSET> received from|sent to <address>[ - memo: <memo>] - tx <full tx hash>`, ASCII-folded.
- `Reference`: `<first 10 chars of txHash>:<logIndex>`, a short hash that stays unique per line.
- Fee lines: **one per UTC day** (`Payee = Arc network`, `Description = Arc network fees (N tx) exact <exact> USDC`, `Reference = fees:<date>`). Days whose total fee rounds to `0.00` get no line; the adjustment line absorbs them.

### 6.3 Rounding to cents (Xero and QBO)
- Each line is rounded half away from zero to 2 decimals.
- Adjustment = `round2(exact net for the asset) − Σ rounded lines`. If it is non-zero, one last line is added: `Payee = Arc Ledger`, `Description = Rounding adjustment: 2-decimal lines vs exact on-chain net <exact> <ASSET>`, `Reference = rounding`, dated the last day of the period.
- If `unexplained != 0`, one more line with `Reference = unexplained` is added. This makes the imported statement end at the real on-chain balance rounded to the cent.

### 6.4 QuickBooks Online CSV: **4-column variant**
Sources: [Manually upload transactions into QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US) and [Common errors importing bank transactions using CSV](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/common-errors-importing-bank-transactions-using/L02IgW462_US_en_US). They say:
- a file uses 3 columns (Date, Description, Amount) or 4 columns (Date, Description, Credit, Debit)
- headers must not contain the word "amount"
- use one date format for all dates (dd/mm/yyyy recommended)
- zero-only amount cells must be left blank
- remove currency symbols and commas from amounts
- special characters in descriptions can break the import
- max **1,000 lines** and **350 KB** per file, in English.

**Why 4 columns:** Credit and Debit are always positive, which avoids sign-convention confusion. At import the user maps Credit to "money received" and Debit to "money spent".

- **One file per asset**, and files are split into `_part<N>` of at most 1,000 transaction lines (plus a header) and 350 KB.
- Header `Date,Description,Credit,Debit`.
- `Date`: `dd/mm/yyyy` (UTC day).
- `Credit` = money in, `Debit` = money out: positive, 2 decimals, and the other cell blank.
- `Description`: `Received from|Paid to <label or checksummed address>[ - <memo>]`, reduced to `[A-Za-z0-9 .,-]`.
- Fee, rounding and unexplained lines follow the same rules as Xero (§6.2, §6.3).
- ⚠️ Intuit's page also says "Remove numbers from cells in the Description column". We read this as "cells that contain only a number" (a bank artifact), because addresses and invoice memos contain digits and removing them would destroy the audit trail. **We have not tested this against a real QBO account.**

### 6.5 JSON
The export file from §3.3. It is also the input of the Verify screen.

---

## 7. Examples (illustrative data: fake tx hashes, real formats)
Generated from one dataset by the prototype that the Phase 3 modules will replace:

| File | What it shows |
|---|---|
| [examples/report.json](examples/report.json) | export file: 5 rows, a multi-transfer tx (`0xccc…`: USDC and EURC with one fee), memos, labels and categories |
| [examples/report.canonical.json](examples/report.canonical.json) | the exact bytes that are hashed, `0xb10af9fe…516f7a` |
| [examples/generic.csv](examples/generic.csv) | transfer and fee rows, full precision |
| [examples/xero_USDC.csv](examples/xero_USDC.csv), [examples/xero_EURC.csv](examples/xero_EURC.csv) | Xero, one file per asset |
| [examples/qbo_USDC.csv](examples/qbo_USDC.csv), [examples/qbo_EURC.csv](examples/qbo_EURC.csv) | QBO 4-column, one file per asset |

In this dataset every fee is below half a cent (0.001265 and 0.002041 USDC), so no fee line appears in Xero or QBO. The rounded lines already add up to the exact net (938.15), so no adjustment line appears either.
