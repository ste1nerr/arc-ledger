/**
 * The only place that converts between Arc's two USDC views (docs/ARC_FACTS.md §3):
 *   - native interface: 18 decimals (gas, msg.value, EIP-7708 system Transfer logs)
 *   - ERC-20 interface at 0x3600…0000: 6 decimals (balanceOf, ERC-20 Transfer logs)
 * Both views share one balance.
 *
 * Truncation policy: native → ERC-20 truncates toward zero, exactly like `balanceOf`
 * on chain. Ledger amounts are always recorded at 18 decimals and never go through
 * `nativeToErc20`; it exists to compare against on-chain ERC-20 values.
 */

export const USDC_NATIVE_DECIMALS = 18
export const USDC_ERC20_DECIMALS = 6
export const NATIVE_PER_ERC20_UNIT = 10n ** 12n

/** 18-dec raw → 6-dec raw, truncating toward zero (loses < 1e-6 USDC). */
export function nativeToErc20(raw18: bigint): bigint {
  return raw18 / NATIVE_PER_ERC20_UNIT
}

/** 6-dec raw → 18-dec raw. Exact. */
export function erc20ToNative(raw6: bigint): bigint {
  return raw6 * NATIVE_PER_ERC20_UNIT
}

/** Sub-micro-USDC remainder that the ERC-20 view hides. Same sign as the input. */
export function erc20TruncationRemainder(raw18: bigint): bigint {
  return raw18 - erc20ToNative(nativeToErc20(raw18))
}
