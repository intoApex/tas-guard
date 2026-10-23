// EVM decoding for the onchain guard: hex helpers, a strict RLP decoder, signed transaction decoding
// (legacy, EIP-2930, EIP-1559), calldata for the money-moving calls we know by 4-byte selector,
// EIP-712 permits (ERC-2612, DAI, Uniswap Permit2) and revert reasons. No keccak, no secp256k1.

export const MAX_UINT256 = (1n << 256n) - 1n;
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const HEX = /^0x([0-9a-fA-F]{2})*$/;
export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const lowerAddr = (a) => (isAddress(a) ? a.toLowerCase() : undefined);

export function hexToBytes(hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new Error("not a 0x-prefixed, even-length hex string");
  return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}
export const bytesToHex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytesToBig = (b) => (b.length ? BigInt(bytesToHex(b)) : 0n);

/** A JSON-RPC quantity ("0x1a", a number or a decimal string) as a BigInt. */
export function toBig(v, fallback = 0n) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") { if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bad quantity ${v}`); return BigInt(v); }
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new Error(`bad quantity ${JSON.stringify(v)}`);
}

// ---------- RLP (strict: rejects non-canonical encodings, which nodes reject too) ----------

export function rlpDecode(bytes) {
  const [item, end] = rlpAt(bytes, 0, 0);
  if (end !== bytes.length) throw new Error("RLP: trailing bytes");
  return item;
}

function rlpLength(b, i, n) {
  if (n > 4) throw new Error("RLP: length too large");
  if (i + n > b.length) throw new Error("RLP: truncated");
  if (b[i] === 0) throw new Error("RLP: leading zero in length");
  let len = 0;
  for (let k = 0; k < n; k++) len = len * 256 + b[i + k];
  if (len <= 55) throw new Error("RLP: non-canonical long length");
  return len;
}

function rlpAt(b, i, depth) {
  if (depth > 16) throw new Error("RLP: nested too deep");
  if (i >= b.length) throw new Error("RLP: truncated");
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (p < 0xc0) {
    let start, len;
    if (p <= 0xb7) { len = p - 0x80; start = i + 1; }
    else { const n = p - 0xb7; len = rlpLength(b, i + 1, n); start = i + 1 + n; }
    if (start + len > b.length) throw new Error("RLP: truncated");
    if (len === 1 && b[start] < 0x80) throw new Error("RLP: non-canonical single byte");
    return [b.subarray(start, start + len), start + len];
  }
  let start, len;
  if (p <= 0xf7) { len = p - 0xc0; start = i + 1; }
  else { const n = p - 0xf7; len = rlpLength(b, i + 1, n); start = i + 1 + n; }
  const end = start + len;
  if (end > b.length) throw new Error("RLP: truncated");
  const items = [];
  let j = start;
  while (j < end) { const [it, nx] = rlpAt(b, j, depth + 1); items.push(it); j = nx; }
  if (j !== end) throw new Error("RLP: list length mismatch");
  return [items, end];
}

const rlpInt = (x, name) => {
  if (Array.isArray(x)) throw new Error(`tx field ${name} must be a number`);
  if (x.length > 32) throw new Error(`tx field ${name} is too large`);
  if (x.length && x[0] === 0) throw new Error(`tx field ${name} has a leading zero`);
  return bytesToBig(x);
};
const rlpTo = (x) => {
  if (Array.isArray(x)) throw new Error("tx field to must be bytes");
  if (x.length === 0) return null; // contract creation
  if (x.length !== 20) throw new Error("tx field to must be 20 bytes");
  return bytesToHex(x);
};
const rlpData = (x) => { if (Array.isArray(x)) throw new Error("tx field data must be bytes"); return bytesToHex(x); };

/**
 * Decode a signed raw transaction (what eth_sendRawTransaction carries).
 * Returns { type, chainId (BigInt|null), nonce, gas, to, value, data, ... }. The sender is NOT
 * recovered (that would need secp256k1 public-key recovery and keccak).
 */
export function decodeRawTx(hex) {
  const b = hexToBytes(hex);
  if (!b.length) throw new Error("empty transaction");
  if (b[0] >= 0xc0) {
    const f = rlpDecode(b);
    if (!Array.isArray(f) || f.length !== 9) throw new Error("legacy transaction must have 9 fields");
    const v = rlpInt(f[6], "v");
    const chainId = v >= 35n ? (v - 35n) / 2n : null; // v = 27/28: pre-EIP-155, no replay protection
    return { type: 0, chainId, nonce: rlpInt(f[0], "nonce"), gasPrice: rlpInt(f[1], "gasPrice"), gas: rlpInt(f[2], "gas"), to: rlpTo(f[3]), value: rlpInt(f[4], "value"), data: rlpData(f[5]), v };
  }
  const type = b[0];
  if (type !== 1 && type !== 2) {
    const what = { 3: " (EIP-4844 blob)", 4: " (EIP-7702 set-code: delegates the wallet to a contract)" }[type] || "";
    throw new Error(`transaction type 0x${type.toString(16).padStart(2, "0")}${what} isn't supported`);
  }
  const f = rlpDecode(b.subarray(1));
  const n = type === 1 ? 11 : 12;
  if (!Array.isArray(f) || f.length !== n) throw new Error(`type ${type} transaction must have ${n} fields`);
  if (!Array.isArray(f[n - 4])) throw new Error("accessList must be a list");
  const common = { type, chainId: rlpInt(f[0], "chainId"), nonce: rlpInt(f[1], "nonce") };
  if (type === 1) return { ...common, gasPrice: rlpInt(f[2], "gasPrice"), gas: rlpInt(f[3], "gas"), to: rlpTo(f[4]), value: rlpInt(f[5], "value"), data: rlpData(f[6]), yParity: rlpInt(f[8], "yParity") };
  return { ...common, maxPriorityFeePerGas: rlpInt(f[2], "maxPriorityFeePerGas"), maxFeePerGas: rlpInt(f[3], "maxFeePerGas"), gas: rlpInt(f[4], "gas"), to: rlpTo(f[5]), value: rlpInt(f[6], "value"), data: rlpData(f[7]), yParity: rlpInt(f[9], "yParity") };
}

/** A transaction object from eth_sendTransaction, normalized like decodeRawTx's output. */
export function normalizeTxObject(tx) {
  if (!tx || typeof tx !== "object") throw new Error("transaction object missing");
  if (tx.to !== undefined && tx.to !== null && !isAddress(tx.to)) throw new Error("tx.to is not an address");
  const data = tx.input ?? tx.data ?? "0x";
  if (tx.input !== undefined && tx.data !== undefined && tx.input !== tx.data) throw new Error("tx has different 'data' and 'input'");
  hexToBytes(data);
  if (tx.authorizationList !== undefined) throw new Error("EIP-7702 authorizationList (delegates the wallet to a contract) isn't supported");
  return { type: "object", from: lowerAddr(tx.from), chainId: tx.chainId !== undefined ? toBig(tx.chainId) : null, nonce: tx.nonce !== undefined ? toBig(tx.nonce) : undefined, gas: tx.gas !== undefined ? toBig(tx.gas) : undefined, to: tx.to ? tx.to.toLowerCase() : null, value: toBig(tx.value), data: data.toLowerCase() };
}

// ---------- calldata ----------

const SEL = {
  "a9059cbb": "transfer",
  "23b872dd": "transferFrom",
  "095ea7b3": "approve",
  "39509351": "increaseAllowance",
  "a22cb465": "setApprovalForAll",
  "87517c45": "permit2Approve",
};
const ARGC = { transfer: 2, transferFrom: 3, approve: 2, increaseAllowance: 2, setApprovalForAll: 2, permit2Approve: 4 };

/**
 * What a transaction does, from its `to`, `value` and `data`. Returns one of:
 *  { kind: "native_transfer", recipient, value }
 *  { kind: "erc20_transfer", asset, recipient, amount, owner? (transferFrom) }
 *  { kind: "approval", spender, items: [{ asset, amount, bits }], via }
 *  { kind: "approval_for_all", asset, operator, approved }
 *  { kind: "contract_call", selector } | { kind: "deploy" }
 * `value` (native) is always carried alongside.
 */
export function decodeCall({ to, value = 0n, data = "0x" }) {
  const hex = (data || "0x").toLowerCase().slice(2);
  if (!to) return { kind: "deploy", value };
  if (!hex.length) return { kind: "native_transfer", recipient: to, value };
  const selector = hex.slice(0, 8);
  const fn = SEL[selector];
  const words = [];
  for (let i = 8; i + 64 <= hex.length; i += 64) words.push(hex.slice(i, i + 64));
  if (!fn || words.length < ARGC[fn]) return { kind: "contract_call", selector: hex.length >= 8 ? "0x" + selector : "0x" + hex, value };
  const addr = (w) => "0x" + w.slice(24);
  const uint = (w) => BigInt("0x" + w);
  switch (fn) {
    case "transfer": return { kind: "erc20_transfer", asset: to, recipient: addr(words[0]), amount: uint(words[1]), value, fn };
    case "transferFrom": return { kind: "erc20_transfer", asset: to, owner: addr(words[0]), recipient: addr(words[1]), amount: uint(words[2]), value, fn };
    case "approve":
    case "increaseAllowance": return { kind: "approval", spender: addr(words[0]), items: [{ asset: to, amount: uint(words[1]), bits: 256 }], via: fn, value };
    case "setApprovalForAll": return { kind: "approval_for_all", asset: to, operator: addr(words[0]), approved: uint(words[1]) !== 0n, value };
    case "permit2Approve": return { kind: "approval", spender: addr(words[1]), items: [{ asset: addr(words[0]), amount: uint(words[2]), bits: 160, expiration: uint(words[3]) }], via: "Permit2 approve", value };
  }
}

/** "Unlimited" allowance: max uint, or anything at or above half the field's range (2^255 for uint256). */
export const isUnlimited = (amount, bits = 256) => amount >= 1n << BigInt(bits - 1);

// ---------- EIP-712 typed data ----------

const big = (v) => { try { return toBig(v); } catch { return undefined; } };

/**
 * Recognize permits in EIP-712 typed data. Returns
 *  { kind: "approval", via, spender, items: [{asset, amount, bits, unlimited?}], deadline, chainId }
 *  or { kind: "typed_data", primaryType, domain, chainId } for anything else.
 */
export function decodeTypedData(td) {
  if (typeof td === "string") td = JSON.parse(td);
  if (!td || typeof td !== "object" || Array.isArray(td)) return { kind: "typed_data", primaryType: "(legacy v1 typed data)", chainId: null };
  const dom = td.domain || {}, msg = td.message || {}, pt = String(td.primaryType || "");
  const chainId = dom.chainId !== undefined ? big(dom.chainId) ?? null : null;
  const vc = lowerAddr(dom.verifyingContract);
  const isPermit2 = vc === PERMIT2 || dom.name === "Permit2";
  if (isPermit2 && /^Permit(Single|Batch)$/.test(pt)) {
    const det = Array.isArray(msg.details) ? msg.details : [msg.details || {}];
    return { kind: "approval", via: `Permit2 ${pt}`, spender: lowerAddr(msg.spender), deadline: big(msg.sigDeadline), chainId,
      items: det.map((d) => ({ asset: lowerAddr(d.token), amount: big(d.amount), bits: 160, expiration: big(d.expiration) })) };
  }
  if (isPermit2 && /^Permit(Batch)?(Witness)?TransferFrom$/.test(pt)) {
    const per = Array.isArray(msg.permitted) ? msg.permitted : [msg.permitted || {}];
    return { kind: "approval", via: `Permit2 ${pt}`, spender: lowerAddr(msg.spender), deadline: big(msg.deadline), chainId,
      items: per.map((p) => ({ asset: lowerAddr(p.token), amount: big(p.amount), bits: 256 })) };
  }
  if (pt === "Permit" && msg.spender !== undefined) {
    if (msg.value !== undefined) return { kind: "approval", via: "ERC-2612 permit", spender: lowerAddr(msg.spender), deadline: big(msg.deadline), chainId, items: [{ asset: vc, amount: big(msg.value), bits: 256 }] };
    if (msg.allowed !== undefined) { // DAI-style permit: all or nothing
      const on = msg.allowed === true || msg.allowed === "true";
      return { kind: "approval", via: "DAI-style permit", spender: lowerAddr(msg.spender), deadline: big(msg.expiry), chainId, items: [{ asset: vc, amount: on ? MAX_UINT256 : 0n, bits: 256 }] };
    }
  }
  return { kind: "typed_data", primaryType: pt || "(none)", domainName: dom.name, verifyingContract: vc, chainId };
}

// ---------- revert reasons ----------

/** Human-readable reason from a JSON-RPC error of eth_call / eth_estimateGas. */
export function revertReason(err) {
  const data = typeof err?.data === "string" ? err.data : typeof err?.data?.data === "string" ? err.data.data : undefined;
  if (data && /^0x08c379a0/i.test(data) && data.length >= 10 + 128) {
    try {
      const h = data.slice(10);
      const len = Number(BigInt("0x" + h.slice(64, 128)));
      const s = Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
      if (s) return s;
    } catch {}
  }
  if (data && /^0x4e487b71/i.test(data) && data.length >= 74) return `panic 0x${BigInt("0x" + data.slice(10, 74)).toString(16)}`;
  const m = String(err?.message || "execution reverted");
  if (data && data.length >= 10 && /^execution reverted$/i.test(m)) return `${m} (custom error ${data.slice(0, 10)})`;
  return m;
}
