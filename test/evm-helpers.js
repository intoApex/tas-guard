// Test-only helpers: an independent RLP encoder and signed-transaction builders (fixed dummy signatures;
// the guard never verifies signatures, it only decodes the fields).
const toBuf = (x) => {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === "string") return Buffer.from(x.replace(/^0x/, ""), "hex");
  const n = BigInt(x);
  if (n === 0n) return Buffer.alloc(0);
  const h = n.toString(16);
  return Buffer.from(h.length % 2 ? "0" + h : h, "hex");
};
const prefix = (len, off) => {
  if (len <= 55) return Buffer.from([off + len]);
  const h = len.toString(16), lb = Buffer.from(h.length % 2 ? "0" + h : h, "hex");
  return Buffer.concat([Buffer.from([off + 55 + lb.length]), lb]);
};
export function rlpEncode(x) {
  if (Array.isArray(x)) { const body = Buffer.concat(x.map(rlpEncode)); return Buffer.concat([prefix(body.length, 0xc0), body]); }
  const b = toBuf(x);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([prefix(b.length, 0x80), b]);
}
const R = "0x" + "1b".repeat(32), S = "0x" + "2c".repeat(32);
/** Build a signed raw tx (dummy r/s). type 0 uses EIP-155 v unless chainId is null. */
export function rawTx({ type = 2, chainId = 8453, nonce = 0, gas = 100000, gasPrice = 1e9, maxPriorityFeePerGas = 1e9, maxFeePerGas = 2e9, to, value = 0n, data = "0x", accessList = [], yParity = 1 }) {
  if (type === 0) return "0x" + rlpEncode([nonce, gasPrice, gas, to || "0x", value, data, chainId === null ? 27 : BigInt(chainId) * 2n + 35n + BigInt(yParity), R, S]).toString("hex");
  const f = type === 1 ? [chainId, nonce, gasPrice, gas, to || "0x", value, data, accessList, yParity, R, S] : [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to || "0x", value, data, accessList, yParity, R, S];
  return "0x" + Buffer.concat([Buffer.from([type]), rlpEncode(f)]).toString("hex");
}
const word = (h) => String(h).replace(/^0x/, "").padStart(64, "0");
export const calldata = {
  transfer: (to, amt) => "0xa9059cbb" + word(to) + word(BigInt(amt).toString(16)),
  transferFrom: (from, to, amt) => "0x23b872dd" + word(from) + word(to) + word(BigInt(amt).toString(16)),
  approve: (sp, amt) => "0x095ea7b3" + word(sp) + word(BigInt(amt).toString(16)),
  increaseAllowance: (sp, amt) => "0x39509351" + word(sp) + word(BigInt(amt).toString(16)),
  setApprovalForAll: (op, on) => "0xa22cb465" + word(op) + word(on ? "1" : "0"),
  permit2Approve: (token, sp, amt, exp) => "0x87517c45" + word(token) + word(sp) + word(BigInt(amt).toString(16)) + word(BigInt(exp).toString(16)),
};
export const MAX = (1n << 256n) - 1n;
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const permit2Single = ({ token = USDC, amount, spender, chainId = 8453, sigDeadline = 1893456000 }) => ({
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
    PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
  primaryType: "PermitSingle",
  domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
  message: { details: { token, amount: String(amount), expiration: "1893456000", nonce: "0" }, spender, sigDeadline: String(sigDeadline) },
});
export const erc2612 = ({ token = USDC, value, spender, owner, chainId = 8453, deadline = 1893456000 }) => ({
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  domain: { name: "USD Coin", version: "2", chainId, verifyingContract: token },
  message: { owner, spender, value: String(value), nonce: 0, deadline },
});
