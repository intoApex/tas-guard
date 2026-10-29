// Hyperliquid wire formats and signing, following the official Python SDK (hyperliquid-python-sdk 0.24.0,
// hyperliquid/utils/signing.py and exchange.py) exactly: msgpack action hashing, the L1 "phantom agent"
// EIP-712 signature, user-signed actions (approveBuilderFee), float_to_wire and the SDK's price rounding.
// test/hl.test.js checks every byte against vectors the SDK itself produced (test/fixtures/hl-vectors.json).
import { keccak256, signTypedData, typedDataDigest } from "./eth-crypto.js";

// ---------- msgpack (the subset Python's msgpack.packb emits for Hyperliquid actions) ----------
/**
 * Encode like Python msgpack.packb(v) with its defaults (use_bin_type=True, float64, smallest int form).
 * Object keys keep their insertion order, which must be the SDK's order. Integer-like keys are refused,
 * because JavaScript would silently move them to the front.
 */
export function msgpackEncode(value) {
  const out = [];
  const byte = (...b) => out.push(Buffer.from(b));
  const be = (n, len) => { const b = Buffer.alloc(len); b.writeUIntBE(Number(n), 0, Math.min(len, 6)); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt.asUintN(64, n)); return b; };
  const head = (fix, max, c8, c16, c32, n) => {
    if (fix !== null && n <= max) return byte(fix | n);
    if (c8 !== null && n <= 0xff) return out.push(Buffer.from([c8, n]));
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = c16; b.writeUInt16BE(n, 1); return out.push(b); }
    const b = Buffer.alloc(5); b[0] = c32; b.writeUInt32BE(n, 1); out.push(b);
  };
  const int = (n) => {
    if (n >= 0n) {
      if (n < 128n) return byte(Number(n));
      if (n < 0x100n) return byte(0xcc, Number(n));
      if (n < 0x10000n) return out.push(Buffer.concat([Buffer.from([0xcd]), be(n, 2)]));
      if (n < 0x100000000n) { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(Number(n), 1); return out.push(b); }
      if (n < 1n << 64n) return out.push(Buffer.concat([Buffer.from([0xcf]), u64(n)]));
      throw new Error("msgpack: integer too large");
    }
    if (n >= -32n) return byte(Number(n) & 0xff);
    if (n >= -128n) return byte(0xd0, Number(n) & 0xff);
    if (n >= -32768n) { const b = Buffer.alloc(3); b[0] = 0xd1; b.writeInt16BE(Number(n), 1); return out.push(b); }
    if (n >= -2147483648n) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(Number(n), 1); return out.push(b); }
    if (n >= -(1n << 63n)) return out.push(Buffer.concat([Buffer.from([0xd3]), u64(n)]));
    throw new Error("msgpack: integer too small");
  };
  const enc = (v) => {
    if (v === null) return byte(0xc0);
    if (v === true) return byte(0xc3);
    if (v === false) return byte(0xc2);
    if (typeof v === "bigint") return int(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("msgpack: non-finite number");
      if (Number.isInteger(v)) return int(BigInt(v));
      const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(v, 1); return out.push(b);
    }
    if (typeof v === "string") {
      const s = Buffer.from(v, "utf8");
      head(0xa0, 31, 0xd9, 0xda, 0xdb, s.length);
      return out.push(s);
    }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      head(null, 0, 0xc4, 0xc5, 0xc6, v.length);
      return out.push(Buffer.from(v));
    }
    if (Array.isArray(v)) { head(0x90, 15, null, 0xdc, 0xdd, v.length); v.forEach(enc); return; }
    if (typeof v === "object") {
      const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
      if (!(v instanceof Map) && entries.some(([k]) => /^(0|[1-9]\d*)$/.test(k))) throw new Error("msgpack: integer-like object keys would be reordered");
      head(0x80, 15, null, 0xde, 0xdf, entries.length);
      for (const [k, x] of entries) {
        if (typeof k !== "string") throw new Error("msgpack: map keys must be strings");
        if (x === undefined) throw new Error(`msgpack: '${k}' is undefined`);
        enc(k); enc(x);
      }
      return;
    }
    throw new Error(`msgpack: can't encode ${typeof v}`);
  };
  enc(value);
  return Buffer.concat(out);
}

// ---------- numbers on the wire ----------
/** The SDK's float_to_wire: 8 decimals, trailing zeros stripped, and refuse values that would be rounded. */
export function floatToWire(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`float_to_wire: ${x} is not a finite number`);
  if (x < 0 || Object.is(x, -0)) throw new Error(`float_to_wire: negative value ${x}`);
  if (x >= 1e21) throw new Error(`float_to_wire: ${x} is too large`);
  const rounded = x.toFixed(8); // exact decimal rounding of the double, like Python's f"{x:.8f}" (ties can't pass the check below)
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`float_to_wire causes rounding: ${x}`);
  return rounded.replace(/0+$/, "").replace(/\.$/, "");
}

/** The exact decimal value of a double: x = (neg ? -1 : 1) * digits / 10^scale. */
function exactDecimal(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const neg = bits >> 63n === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e;
  if (expBits === 0) e = -1074;
  else { mant |= 1n << 52n; e = expBits - 1075; }
  if (e >= 0) return { neg, digits: mant << BigInt(e), scale: 0 };
  return { neg, digits: mant * 5n ** BigInt(-e), scale: -e };
}

/** Round {digits, scale} to nd decimals. mode: "half-even" | "down" (toward zero) | "up" (away from zero). */
function roundDec({ neg = false, digits, scale }, nd, mode) {
  const drop = scale - nd;
  if (drop <= 0) return { neg, digits, scale };
  const div = 10n ** BigInt(drop);
  let q = digits / div;
  const rem = digits % div;
  if (rem !== 0n) {
    if (mode === "up") q += 1n;
    else if (mode === "half-even") { const twice = rem * 2n; if (twice > div || (twice === div && q % 2n === 1n)) q += 1n; }
  }
  return nd >= 0 ? { neg, digits: q, scale: nd } : { neg, digits: q * 10n ** BigInt(-nd), scale: 0 };
}
function decToString({ neg, digits, scale }) {
  let s = digits.toString();
  if (scale > 0) { s = s.padStart(scale + 1, "0"); s = s.slice(0, -scale) + "." + s.slice(-scale); s = s.replace(/0+$/, "").replace(/\.$/, ""); }
  return (neg && digits !== 0n ? "-" : "") + s;
}
const leadingExp = ({ digits, scale }) => digits.toString().length - 1 - scale; // x is in [10^e, 10^(e+1))

/** Python's round(x, nd) for a float: exact half-even rounding of the binary value. */
export function pyRound(x, nd) { return Number(decToString(roundDec(exactDecimal(x), nd, "half-even"))); }
/** Python's float(f"{x:.{sig}g}"): round to sig significant figures (half-even, exact). */
export function pySig(x, sig) {
  if (x === 0) return 0;
  const d = exactDecimal(x);
  return Number(decToString(roundDec(d, sig - 1 - leadingExp(d), "half-even")));
}

/** The SDK's market-order price (Exchange._slippage_price): mid moved by slippage, 5 significant figures, then 6 (perp) or 8 (spot) minus szDecimals decimals. */
export function slippagePrice(mid, isBuy, slippage, szDecimals, isSpot) {
  const px = mid * (isBuy ? 1 + slippage : 1 - slippage);
  return pyRound(pySig(px, 5), (isSpot ? 8 : 6) - szDecimals);
}

/** Parse a user-supplied decimal (number or plain decimal string) into {digits, scale}. Refuses junk, negatives and exponents in strings. */
export function parseDecimal(v, what = "value") {
  let s;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${what} must be a positive number`);
    s = String(v);
    const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
    if (m) { // 1e-7 -> 0.0000001, 1e+21 -> 1000...
      const ds = m[1] + (m[2] || ""), exp = Number(m[3]) - (m[2] || "").length;
      return exp >= 0 ? { digits: BigInt(ds) * 10n ** BigInt(exp), scale: 0 } : { digits: BigInt(ds), scale: -exp };
    }
  } else if (typeof v === "string") s = v.trim();
  else throw new Error(`${what} must be a number`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s) || /^\.(\d+)$/.exec(s) && [s, "0", s.slice(1)];
  if (!m) throw new Error(`${what} must be a plain positive decimal number (got '${v}')`);
  return { digits: BigInt(m[1] + (m[2] || "")), scale: (m[2] || "").length };
}

/**
 * Fit a limit price to Hyperliquid's tick rules: at most 5 significant figures and at most
 * (6 for perps, 8 for spot) - szDecimals decimals; integer prices are always valid. Rounds in the
 * direction that never makes the order worse for the user: buys down, sells up.
 */
export function fitLimitPrice(v, { isBuy, szDecimals, isSpot }) {
  const d = parseDecimal(v, "price");
  if (d.digits === 0n) throw new Error("price must be greater than 0");
  const maxDec = Math.max(0, (isSpot ? 8 : 6) - szDecimals);
  const nd = Math.max(0, Math.min(4 - leadingExp(d), maxDec));
  return Number(decToString(roundDec(d, nd, isBuy ? "down" : "up")));
}

/** Size rounded down to the asset's szDecimals (never trade more than asked). */
export function fitSize(v, szDecimals) {
  const d = parseDecimal(v, "size");
  return Number(decToString(roundDec(d, szDecimals, "down")));
}

// ---------- actions (keys in the SDK's order: the hash depends on it) ----------
const TIFS = new Set(["Gtc", "Ioc", "Alo"]);

/** order_request_to_order_wire: {a, b, p, s, r, t: {limit: {tif}}}. */
export function orderWire({ asset, isBuy, price, size, reduceOnly = false, tif = "Gtc" }) {
  if (!Number.isInteger(asset) || asset < 0) throw new Error("order: bad asset index");
  if (!TIFS.has(tif)) throw new Error(`order: tif must be Gtc, Ioc or Alo (got ${tif})`);
  return { a: asset, b: !!isBuy, p: floatToWire(price), s: floatToWire(size), r: !!reduceOnly, t: { limit: { tif } } };
}

/** order_wires_to_order_action, with the builder address lowercased as Exchange.bulk_orders does. */
export function orderAction(wires, builder = null) {
  const action = { type: "order", orders: wires, grouping: "na" };
  if (builder) action.builder = { b: String(builder.b).toLowerCase(), f: builder.f };
  return action;
}

export const cancelAction = (cancels) => ({ type: "cancel", cancels: cancels.map(({ asset, oid }) => ({ a: asset, o: oid })) });
export const updateLeverageAction = ({ asset, isCross, leverage }) => ({ type: "updateLeverage", asset, isCross: !!isCross, leverage });

// ---------- signing ----------
/** action_hash: keccak256(msgpack(action) || nonce (8 bytes BE) || vault flag [|| vault] [|| 0x00 || expiresAfter]). */
export function actionHash(action, vaultAddress, nonce, expiresAfter = null) {
  const parts = [msgpackEncode(action)];
  const n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(nonce)); parts.push(n);
  if (vaultAddress == null) parts.push(Buffer.from([0]));
  else parts.push(Buffer.from([1]), Buffer.from(String(vaultAddress).replace(/^0x/i, ""), "hex"));
  if (expiresAfter != null) { const e = Buffer.alloc(8); e.writeBigUInt64BE(BigInt(expiresAfter)); parts.push(Buffer.from([0]), e); }
  return keccak256(Buffer.concat(parts));
}

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The typed data for an L1 action (l1_payload with the phantom agent). */
export function l1TypedData(connectionId, mainnet) {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }], EIP712Domain: DOMAIN_TYPE },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId },
  };
}

/** sign_l1_action. Returns { connectionId, signature: {r, s, v} }. */
export function signL1Action(privateKey, action, { nonce, mainnet, vaultAddress = null, expiresAfter = null }) {
  const connectionId = actionHash(action, vaultAddress, nonce, expiresAfter);
  return { connectionId, signature: signTypedData(l1TypedData(connectionId, mainnet), privateKey) };
}

export const SIGNATURE_CHAIN_ID = "0x66eee"; // what the SDK uses; hyperliquidChain is what binds the network
export const APPROVE_BUILDER_FEE_TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "maxFeeRate", type: "string" },
  { name: "builder", type: "address" },
  { name: "nonce", type: "uint64" },
];

/** The typed data for a user-signed action (user_signed_payload). `action` must already carry signatureChainId and hyperliquidChain. */
export function userSignedTypedData(primaryType, payloadTypes, action) {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(action.signatureChainId, 16), verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: payloadTypes, EIP712Domain: DOMAIN_TYPE },
    primaryType,
    message: action,
  };
}

/** sign_user_signed_action: adds signatureChainId and hyperliquidChain to a copy of the action, then signs it. */
export function signUserSignedAction(privateKey, action, payloadTypes, primaryType, mainnet) {
  const a = { ...action, signatureChainId: SIGNATURE_CHAIN_ID, hyperliquidChain: mainnet ? "Mainnet" : "Testnet" };
  return { action: a, signature: signTypedData(userSignedTypedData(primaryType, payloadTypes, a), privateKey) };
}

/** Exchange.approve_builder_fee, signed with the user's MAIN wallet key. maxFeeRate is a percent string, e.g. "0.02%". */
export function signApproveBuilderFee(privateKey, { builder, maxFeeRate, nonce, mainnet }) {
  return signUserSignedAction(privateKey, { maxFeeRate, builder: String(builder).toLowerCase(), nonce, type: "approveBuilderFee" }, APPROVE_BUILDER_FEE_TYPES, "HyperliquidTransaction:ApproveBuilderFee", mainnet);
}

/** The EIP-712 digest for an action, for tests and debugging. */
export function digestFor(kind, action, { nonce, mainnet } = {}) {
  if (kind === "user") return typedDataDigest(userSignedTypedData("HyperliquidTransaction:ApproveBuilderFee", APPROVE_BUILDER_FEE_TYPES, action));
  return typedDataDigest(l1TypedData(actionHash(action, null, nonce), mainnet));
}
