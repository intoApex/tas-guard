// Pure decision engine for the onchain (EVM) guard: given a decoded transaction or signature request,
// the policy and today's usage, decide allow / approve / block. Same rules as the MCP guard:
// hard limits block and can't be overridden by approval; soft rules ask a human.
import { isAddress, isUnlimited } from "./evm.js";

export const DEFAULT_ONCHAIN = {
  chains_allow: [],             // chain ids; empty = any chain
  native_usd: {},               // USD price of the native token: a number, or { "<chainId>": price }
  tokens: {},                   // { "<address>": { symbol, decimals, usd_price: number | "stable" } }
  // Hard limits (approval can't override them). In USD.
  max_tx_usd: 100,
  max_daily_usd: 500,
  max_tx_per_minute: 3,
  max_tx_per_day: 20,
  // Soft limit: above this a human approves.
  approve_over_usd: 50,
  unknown_value: "approve",     // value can't be priced (token not in `tokens`, no native price)
  recipients_allow: [],         // known recipients of native and ERC-20 transfers (your own wallets always count)
  new_recipient: "approve",
  contracts_allow: [],          // known contracts (the `to` of contract calls, spenders of approvals)
  unknown_contract: "approve",
  token_approval: "approve",    // any approve / increaseAllowance / permit / Permit2
  unlimited_approval: "block",  // max-uint (>= 2^255; >= 2^159 for Permit2's uint160) allowances
  approval_for_all: "block",    // setApprovalForAll(operator, true)
  typed_data: "approve",        // EIP-712 signatures that aren't recognized permits
  personal_sign: "approve",
  eth_sign: "block",            // signs a raw hash: can be a transaction
  unsupported_methods: "block", // other signing/sending methods (eth_signTransaction, wallet_sendCalls, personal_sendTransaction, ...)
  preflight: true,              // eth_call + eth_estimateGas before forwarding a send; a revert blocks it
  approval_ttl_minutes: 15,
};

const ACTION_KEYS = ["unknown_value", "new_recipient", "unknown_contract", "token_approval", "unlimited_approval", "approval_for_all", "typed_data", "personal_sign", "eth_sign", "unsupported_methods"];
const NUM_KEYS = ["max_tx_usd", "max_daily_usd", "max_tx_per_minute", "max_tx_per_day", "approve_over_usd", "approval_ttl_minutes"];

const addrList = (list, key) => (list || []).map((a) => {
  if (!isAddress(a)) throw new Error(`onchain.${key}: '${a}' is not a 0x address`);
  return a.toLowerCase();
});
const chainNum = (c) => { const n = Number(typeof c === "string" && c.startsWith("0x") ? BigInt(c) : c); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`onchain.chains_allow: bad chain id ${c}`); return n; };

export function resolveOnchainPolicy(user = {}) {
  for (const k of Object.keys(user)) if (!(k in DEFAULT_ONCHAIN) && !/^[$_]/.test(k)) throw new Error(`onchain.${k} is not a known setting (typo?). Known: ${Object.keys(DEFAULT_ONCHAIN).join(", ")}`);
  const p = { ...DEFAULT_ONCHAIN, ...user };
  for (const k of ACTION_KEYS) if (!["allow", "approve", "block"].includes(p[k])) throw new Error(`onchain.${k} must be allow, approve or block (got '${p[k]}')`);
  for (const k of NUM_KEYS) if (typeof p[k] !== "number" || !(p[k] >= 0)) throw new Error(`onchain.${k} must be a non-negative number`);
  p.chains_allow = (p.chains_allow || []).map(chainNum);
  p.recipients_allow = addrList(p.recipients_allow, "recipients_allow");
  p.contracts_allow = addrList(p.contracts_allow, "contracts_allow");
  const tokens = {};
  for (const [addr, t] of Object.entries(p.tokens || {})) {
    if (!isAddress(addr)) throw new Error(`onchain.tokens: '${addr}' is not a 0x address`);
    if (!Number.isInteger(t?.decimals) || t.decimals < 0 || t.decimals > 77) throw new Error(`onchain.tokens.${addr}: decimals must be an integer 0-77`);
    if (t.usd_price !== undefined && t.usd_price !== "stable" && !(typeof t.usd_price === "number" && t.usd_price >= 0)) throw new Error(`onchain.tokens.${addr}: usd_price must be a number or "stable"`);
    tokens[addr.toLowerCase()] = { symbol: t.symbol || addr.slice(0, 8), decimals: t.decimals, usd_price: t.usd_price };
  }
  p.tokens = tokens;
  if (typeof p.native_usd !== "number" && (typeof p.native_usd !== "object" || p.native_usd === null)) throw new Error("onchain.native_usd must be a number or { chainId: price }");
  return p;
}

// ---------- pricing and formatting ----------

export const CHAINS = { 1: "Ethereum", 10: "OP Mainnet", 56: "BNB Chain", 137: "Polygon", 8453: "Base", 42161: "Arbitrum One", 43114: "Avalanche", 84532: "Base Sepolia", 11155111: "Sepolia" };
const NATIVE = { 56: "BNB", 137: "POL", 43114: "AVAX" };
export const chainName = (id) => (id === null || id === undefined ? "unknown chain" : `${CHAINS[id] || "chain"} (${id})`);
export const nativeSymbol = (id) => NATIVE[id] || "ETH";

export function formatUnits(amount, decimals) {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "").slice(0, 6);
  return s.slice(0, -decimals) + (frac ? "." + frac : "");
}
export const usd = (n) => (n === undefined || Number.isNaN(n) ? "unpriced" : "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "(none)");

export function nativeUsd(policy, chainId, wei) {
  if (!wei) return 0;
  const p = typeof policy.native_usd === "number" ? policy.native_usd : policy.native_usd[String(chainId)];
  return typeof p === "number" ? (Number(wei) / 1e18) * p : undefined;
}
export function tokenUsd(policy, asset, amount) {
  if (amount === 0n) return 0;
  const t = policy.tokens[asset];
  if (!t || amount === undefined) return undefined;
  const price = t.usd_price === "stable" ? 1 : t.usd_price;
  return typeof price === "number" ? (Number(amount) / 10 ** t.decimals) * price : undefined;
}
const tokenAmount = (policy, asset, amount, bits = 256) => {
  if (amount !== undefined && isUnlimited(amount, bits)) return `unlimited ${policy.tokens[asset]?.symbol || "tokens of " + short(asset)}`;
  const t = policy.tokens[asset];
  if (amount === undefined) return "an unreadable amount";
  return t ? `${formatUnits(amount, t.decimals)} ${t.symbol}` : `${amount} base units of ${short(asset)}`;
};
const sum = (xs) => (xs.some((x) => x === undefined) ? undefined : xs.reduce((a, b) => a + b, 0));

/** One-line human summary of a decoded request, for approvals, alerts and the audit log. */
export function describe(op, policy) {
  const chain = chainName(op.chainId !== null && op.chainId !== undefined ? Number(op.chainId) : op.upstreamChainId);
  const cid = op.chainId ?? op.upstreamChainId;
  const nat = op.value ? ` + ${formatUnits(op.value, 18)} ${nativeSymbol(Number(cid))}` : "";
  const items = (op.items || []).map((i) => tokenAmount(policy, i.asset, i.amount, i.bits)).join(", ");
  switch (op.kind) {
    case "native_transfer": return `${chain}: send ${formatUnits(op.value, 18)} ${nativeSymbol(Number(cid))} to ${op.recipient}`;
    case "erc20_transfer": return `${chain}: ${op.fn === "transferFrom" ? `transferFrom ${short(op.owner)}: ` : "send "}${tokenAmount(policy, op.asset, op.amount)} to ${op.recipient} (token ${op.asset})${nat}`;
    case "approval": return `${chain}: ${op.via} lets ${op.spender} spend ${items}${op.deadline !== undefined ? `, deadline ${deadline(op.deadline)}` : ""}${nat}`;
    case "approval_for_all": return `${chain}: setApprovalForAll(${op.operator}, ${op.approved}) on ${op.asset}${nat}`;
    case "contract_call": return `${chain}: call ${op.to} (selector ${op.selector})${op.value ? ` with ${formatUnits(op.value, 18)} ${nativeSymbol(Number(cid))}` : ""}`;
    case "deploy": return `${chain}: deploy a contract${nat}`;
    case "typed_data": return `${chain}: sign EIP-712 ${op.primaryType}${op.domainName ? ` for ${op.domainName}` : ""}${op.verifyingContract ? ` (${op.verifyingContract})` : ""}`;
    case "personal_sign": return `sign a message: ${JSON.stringify(op.preview)}`;
    case "eth_sign": return `eth_sign of raw data ${op.preview}`;
    default: return `${op.method}${op.why ? ": " + op.why : ""}`;
  }
}
const deadline = (d) => (d > 10n ** 12n ? "never" : new Date(Number(d) * 1000).toISOString().replace(".000", ""));

// ---------- the decision ----------

/**
 * @param {object} o
 * @param {object} o.op      decoded request (see rpc.js): { method, send, kind, from, chainId, value, ... }
 * @param {object} o.policy  resolved onchain policy
 * @param {{spent:number, orders:number, recent:number[]}} o.usage  today's usage (USD, tx count)
 * @param {Set<string>} o.wallets  configured agent wallets (lowercase)
 * @param {number|null} o.upstreamChainId
 * @returns {{action:'allow'|'approve'|'block', reason:string, usd?:number, spend?:number, counts:boolean}}
 */
export function decideOnchain({ op, policy, usage = {}, wallets = new Set(), upstreamChainId = null, killed = false, now = Date.now() }) {
  const counts = !!op.send;
  const out = (action, reason, extra = {}) => ({ action, reason, counts, ...extra });
  if (killed) return out("block", "Kill switch is on: every transaction and signature is blocked. Reads still work.");
  if (op.error) return out("block", op.error);
  if (op.kind === "unsupported") return act(policy.unsupported_methods, `'${op.method}' can send or sign, and TAS Guard can't check it.`, out);
  if (op.from && !wallets.has(op.from)) return out("block", `${op.from} is not one of the configured wallets.`);

  // Chain
  if (op.send && op.raw && op.chainId === null) return out("block", "Transaction has no chain id (pre-EIP-155), so it could be replayed on other chains.");
  if (op.send && op.chainId !== null && op.chainId !== undefined && upstreamChainId !== null && Number(op.chainId) !== upstreamChainId) {
    return out("block", `Transaction is for chain ${op.chainId}, but the upstream RPC is chain ${upstreamChainId}.`);
  }
  const cid = op.chainId !== null && op.chainId !== undefined ? Number(op.chainId) : upstreamChainId;
  if (policy.chains_allow.length && op.kind !== "personal_sign" && op.kind !== "eth_sign" && !policy.chains_allow.includes(cid)) {
    return out("block", `${chainName(cid)} is not on chains_allow (${policy.chains_allow.join(", ")}).`);
  }

  // Signatures with a fixed class
  if (op.kind === "eth_sign") return act(policy.eth_sign, "eth_sign signs a raw hash, which can be a transaction.", out);
  if (op.kind === "personal_sign") return act(policy.personal_sign, "personal_sign: message signature.", out);
  if (op.kind === "typed_data") return act(policy.typed_data, `EIP-712 signature (${op.primaryType}) that isn't a recognized permit.`, out);

  const flags = []; // soft results: [action, reason]
  const flag = (a, r) => { if (a !== "allow") flags.push([a, r]); };

  // Rate and count limits apply to every send.
  if (op.send) {
    const recent = (usage.recent || []).filter((t) => now - t < 60_000).length;
    if (recent >= policy.max_tx_per_minute) return out("block", `Rate limit: ${policy.max_tx_per_minute} transactions per minute.`);
    if ((usage.orders || 0) + 1 > policy.max_tx_per_day) return out("block", `Daily transaction limit reached (${policy.max_tx_per_day}).`);
  }

  // Approvals and permits: what could the spender take?
  let allowanceUsd;
  if (op.kind === "approval_for_all" && op.approved) {
    const a = act(policy.approval_for_all, `setApprovalForAll gives ${op.operator} control of every token in ${op.asset}.`, out);
    if (a.action === "block") return a;
    flag(a.action, a.reason);
  }
  if (op.kind === "approval") {
    const items = op.items || [];
    if (!items.length || items.some((i) => i.amount === undefined || !i.asset)) return out("block", "Couldn't read the permit's token or amount.");
    const revoke = items.every((i) => i.amount === 0n);
    if (!revoke) {
      if (!op.spender) return out("block", "Couldn't read the approval's spender.");
      if (items.some((i) => isUnlimited(i.amount, i.bits))) {
        const a = act(policy.unlimited_approval, `Unlimited allowance for ${op.spender}.`, out);
        if (a.action === "block") return a;
        flag(a.action, a.reason);
      }
      allowanceUsd = sum(items.map((i) => (isUnlimited(i.amount, i.bits) ? Infinity : tokenUsd(policy, i.asset, i.amount))));
      if (allowanceUsd !== undefined && Number.isFinite(allowanceUsd) && allowanceUsd > policy.max_tx_usd) {
        return out("block", `Allowance worth ${usd(allowanceUsd)} is over the per-transaction limit of ${usd(policy.max_tx_usd)}.`, { usd: allowanceUsd });
      }
      flag(policy.token_approval, `${op.via} lets ${short(op.spender)} spend your tokens.`);
      if (!policy.contracts_allow.includes(op.spender)) flag(policy.unknown_contract, `Spender ${short(op.spender)} is not on contracts_allow.`);
      if (allowanceUsd === undefined) flag(policy.unknown_value, "The allowance can't be priced (token not in onchain.tokens).");
    }
  }

  // Who receives, and which contract is called
  if (op.kind === "native_transfer" || op.kind === "erc20_transfer") {
    if (!policy.recipients_allow.includes(op.recipient) && !wallets.has(op.recipient)) flag(policy.new_recipient, `Recipient ${short(op.recipient)} is not on recipients_allow.`);
  }
  if (op.kind === "contract_call" && !policy.contracts_allow.includes(op.to)) flag(policy.unknown_contract, `Contract ${short(op.to)} is not on contracts_allow.`);
  if (op.kind === "deploy") flag(policy.unknown_contract, "Deploys a new contract.");

  // USD value moved by this transaction (allowances don't move money until they're used)
  let spend;
  if (op.send) {
    const parts = [nativeUsd(policy, cid, op.value)];
    if (op.kind === "erc20_transfer") parts.push(tokenUsd(policy, op.asset, op.amount));
    spend = sum(parts);
    if (spend === undefined) flag(policy.unknown_value, op.kind === "erc20_transfer" && tokenUsd(policy, op.asset, op.amount) === undefined ? `Token ${short(op.asset)} is not in onchain.tokens, so the value can't be priced.` : `No native_usd price for ${chainName(cid)}, so the value can't be priced.`);
    else {
      if (spend > policy.max_tx_usd) return out("block", `Value ${usd(spend)} is over the per-transaction limit of ${usd(policy.max_tx_usd)}.`, { usd: spend, spend });
      if ((usage.spent || 0) + spend > policy.max_daily_usd) return out("block", `Value ${usd(spend)} would take today's total to ${usd((usage.spent || 0) + spend)}, over the daily limit of ${usd(policy.max_daily_usd)}.`, { usd: spend, spend });
      if (spend > policy.approve_over_usd) flag("approve", `Value ${usd(spend)} is over the approval threshold of ${usd(policy.approve_over_usd)}.`);
    }
  }

  const extra = { usd: allowanceUsd ?? spend, spend };
  const block = flags.find(([a]) => a === "block");
  if (block) return out("block", block[1], extra);
  const asks = flags.filter(([a]) => a === "approve").map(([, r]) => r);
  if (asks.length) return out("approve", asks.join(" "), extra);
  if (op.kind === "approval" && (op.items || []).every((i) => i.amount === 0n)) return out("allow", "Revokes an allowance.", extra);
  if (op.kind === "approval_for_all" && !op.approved) return out("allow", "Revokes an operator approval.", extra);
  return out("allow", spend !== undefined ? `Within limits (${usd(spend)}).` : "Allowed by policy.", extra);
}

function act(a, reason, out) {
  if (a === "block") return out("block", reason + " Blocked by policy.");
  if (a === "approve") return out("approve", reason);
  return out("allow", reason);
}
