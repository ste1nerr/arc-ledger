# PeriodCloseRegistry

Append-only registry that stores the `keccak256` hash of a canonical Arc Ledger report (see [../docs/REPORT_SPEC.md](../docs/REPORT_SPEC.md)).

- It holds no funds, has no owner and cannot be upgraded.
- `account` is always `msg.sender`, so an account can only close its own books.
- It reverts on `reportHash == 0`, on `periodEnd <= periodStart`, and on a duplicate `(account, reportHash)`.
- Re-closing the same period with a new hash records an amendment. The newest close for a period wins, and the whole history stays readable through `closesOf` / `closesOfPaged`.
- `findClose(account, hash)` lets the Verify screen check a report with one `eth_call`, with no log scanning.

## Test

```bash
forge test          # 17 tests, including 2 fuzz tests (1024 runs each)
```

## Deploy to Arc mainnet (done by the owner, never by an agent)

The key is never read from env or files in this repo. Pick one signer option:

```bash
cd contracts
export ARC_RPC_URL=https://rpc.mainnet.arc.io

# Option A: encrypted local keystore (asks for the key once, then for a password)
cast wallet import arc-deployer --interactive
forge script script/Deploy.s.sol:Deploy --rpc-url arc --account arc-deployer --broadcast

# Option B: paste the key at the prompt, nothing is stored
forge script script/Deploy.s.sol:Deploy --rpc-url arc --interactives 1 --broadcast

# Option C: Ledger
forge script script/Deploy.s.sol:Deploy --rpc-url arc --ledger --broadcast
```

Cost, measured on 2026-09-25: about 1.27M gas at a 20 gwei base fee, so **≈ 0.025 USDC** (at most 0.05 USDC at a 40 gwei max fee). One `closePeriod` costs ≈ 150–200k gas, so **≈ 0.004 USDC**.

## Verify source (no key needed)

```bash
forge verify-contract <ADDRESS> src/PeriodCloseRegistry.sol:PeriodCloseRegistry \
  --chain-id 5042 --verifier sourcify
```

Sourcify lists Arc Mainnet (5042) as supported. Blockscout (`explorer.arc.io`) imports Sourcify-verified sources. Verifying on Etherscan (`arc.etherscan.io`) is optional and needs a free Etherscan API key.
