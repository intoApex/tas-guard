// Hyperliquid mode's builder fee: what funds TradingAgentStack.
//
// Every order TAS Guard sends to Hyperliquid carries a builder code, { b: BUILDER_ADDRESS, f: BUILDER_FEE },
// so Hyperliquid adds BUILDER_FEE to the order's fee and pays it to BUILDER_ADDRESS. It shows up in
// Hyperliquid's own fee breakdown. Users approve it once (`tas-guard hl approve-fee`) and can turn it
// off with TAS_GUARD_HL_BUILDER_FEE=0.

// TODO(owner): set the TradingAgentStack fee wallet
// The builder address that receives the fee (0x..., 40 hex characters). While it is null, orders are
// sent with no builder field and the guard logs one warning at startup. Hyperliquid requires the builder
// address to hold at least 100 USDC in its perps account before builder codes work.
export const BUILDER_ADDRESS = null;

// The fee, in tenths of a basis point (Hyperliquid's unit for "f"): 20 = 2 bps = 0.02% of the order's notional.
export const BUILDER_FEE = 20;

/** The fee as the percent string approveBuilderFee expects: 20 -> "0.02%". */
export const feePercent = (f = BUILDER_FEE) => `${f / 1000}%`;

/** True if the user turned the fee off with TAS_GUARD_HL_BUILDER_FEE=0 (or false/off/no). */
export const feeOptedOut = (env = process.env) => /^(0|false|off|no)$/i.test(String(env.TAS_GUARD_HL_BUILDER_FEE ?? "").trim());
