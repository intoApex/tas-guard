// Base Builder Code (ERC-8021): attribution only, no fee.
//
// On Base, apps tag their transactions with a Builder Code so Base can count which app sent them
// (https://docs.base.org/apps/builder-codes/app-developers). The tag is a short suffix appended to the
// transaction's calldata; contracts ignore the extra bytes, and nothing is charged to the user.
//
// Onchain mode adds TradingAgentStack's Builder Code to eth_sendTransaction calls on Base (8453) and
// Base Sepolia (84532), the calls where the guard still sees the transaction before it is signed. It
// can't tag eth_sendRawTransaction: that transaction is already signed. A transaction that already ends
// in an ERC-8021 suffix (another app's code) is left exactly as it is.
//
// Turn it off with TAS_GUARD_BASE_BUILDER_CODE=0 (or false/off/no), or set it to your own Builder Code.
// Bots that sign locally can add the code themselves with tasDataSuffix() (opt-in, see the README).

// TradingAgentStack's Builder Code, registered on base.dev for the "TAS Guard" project (Settings > Builder Code).
export const BASE_BUILDER_CODE = "bc_t9780fwl"; // TAS Guard project on base.dev

/** Chains where the code is added: Base and Base Sepolia. */
export const BASE_CHAIN_IDS = new Set([8453, 84532]);

// ERC-8021: codes (ASCII, comma-separated) || codes length (1 byte) || schema id 0 (1 byte) || 16-byte marker.
const MARKER = "80218021802180218021802180218021";
const CODE = /^[\x21-\x2b\x2d-\x7e]{1,32}$/; // printable ASCII, no spaces or commas

/** The ERC-8021 (schema 0) calldata suffix for one or more Builder Codes, as 0x-hex. */
export function dataSuffix(codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).map((c) => String(c ?? "").trim());
  if (!list.length || list.some((c) => !CODE.test(c))) throw new Error(`invalid Builder Code: ${JSON.stringify(codes)} (printable ASCII, no spaces or commas, up to 32 characters)`);
  const body = Buffer.from(list.join(","), "ascii");
  if (body.length > 255) throw new Error("Builder Codes too long for one suffix");
  return "0x" + body.toString("hex") + body.length.toString(16).padStart(2, "0") + "00" + MARKER;
}

/** True if calldata already ends in an ERC-8021 suffix. */
export const hasAttribution = (data) => typeof data === "string" && data.toLowerCase().endsWith(MARKER);

/** True if the user turned attribution off. */
export const attributionOptedOut = (env = process.env) => /^(0|false|off|no)$/i.test(String(env.TAS_GUARD_BASE_BUILDER_CODE ?? "").trim());

/**
 * The Builder Code the guard adds, or null: the user's own code from TAS_GUARD_BASE_BUILDER_CODE if they set
 * one, nothing if they turned it off, otherwise TradingAgentStack's code (null until it is configured).
 */
export function builderCode(env = process.env, fallback = BASE_BUILDER_CODE) {
  if (attributionOptedOut(env)) return null;
  const own = String(env.TAS_GUARD_BASE_BUILDER_CODE ?? "").trim();
  if (own) {
    if (!CODE.test(own)) throw new Error(`TAS_GUARD_BASE_BUILDER_CODE='${own}' isn't a Builder Code (or 0 to turn attribution off)`);
    return own;
  }
  return fallback;
}

/** The suffix for TradingAgentStack's code, for bots that sign locally (viem: createWalletClient({ ..., dataSuffix })). */
export function tasDataSuffix() {
  if (!BASE_BUILDER_CODE) throw new Error("TradingAgentStack's Builder Code isn't set in this version of tas-guard");
  return dataSuffix(BASE_BUILDER_CODE);
}

// Gas for calldata: 16 per non-zero byte, 4 per zero byte (EIP-2028).
const calldataGas = (hex) => { let g = 0; for (let i = 0; i < hex.length; i += 2) g += hex.slice(i, i + 2) === "00" ? 4 : 16; return g; };

/**
 * Add a Builder Code to an unsigned transaction object (eth_sendTransaction params[0]).
 * Returns { tx, applied, why }: tx is a new object when applied, the same object otherwise.
 * A set gas limit is raised by exactly the calldata gas of the suffix, so a tight limit still fits.
 */
export function attribute(tx, chainId, code) {
  if (!code) return { tx, applied: false, why: "no Builder Code" };
  if (!BASE_CHAIN_IDS.has(Number(chainId))) return { tx, applied: false, why: "not Base" };
  if (!tx || typeof tx !== "object") return { tx, applied: false, why: "no transaction" };
  const data = tx.input ?? tx.data ?? "0x";
  if (typeof data !== "string" || !/^0x([0-9a-f]{2})*$/i.test(data)) return { tx, applied: false, why: "calldata isn't hex" };
  if (hasAttribution(data)) return { tx, applied: false, why: "already has a Builder Code" };
  const suffix = dataSuffix(code).slice(2);
  const out = { ...tx };
  const next = data + suffix;
  if (tx.input !== undefined) out.input = next;
  if (tx.data !== undefined || tx.input === undefined) out.data = next;
  if (tx.gas !== undefined && tx.gas !== null) out.gas = "0x" + (BigInt(tx.gas) + BigInt(calldataGas(suffix))).toString(16);
  return { tx: out, applied: true, why: "added" };
}
