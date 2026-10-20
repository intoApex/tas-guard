// Pure decision engine: given a classified tool call, the policy and today's usage, decide.
import { extractOrder } from "./profiles.js";

export const DEFAULT_POLICY = {
  // Hard limits (never overridable by approval). Values are in the profile's quote currency.
  max_order_value: 500,
  max_daily_value: 2000,
  max_orders_per_day: 20,
  max_orders_per_minute: 3,
  // Soft limit: orders above this need a human approval.
  approve_over: 250,
  symbols_allow: [],
  symbols_block: [],
  sides_allow: [],
  // When an order's value can't be computed (market order by quantity, multi-leg): allow | approve | block
  unknown_value: "approve",
  live_requires_approval: true,
  classes: {
    read: "allow",
    benign_write: "allow",
    cancel: "allow",
    close: "allow",
    order: "check",
    modify: "approve",
    cancel_all: "approve",
    close_all: "approve",
    other_write: "approve",
    leverage: "block",
    funds_out: "block",
    account: "block",
    raw_write: "block",
    unknown: "block",
  },
  hide_blocked_tools: true,
  approval_ttl_minutes: 15,
};

const ACTIONS = new Set(["allow", "approve", "block", "check"]);
// Risk-reducing classes stay available while the kill switch is on.
export const KILL_SWITCH_ALLOWED = new Set(["read", "cancel", "cancel_all", "close", "close_all"]);

export function resolvePolicy(user = {}) {
  const p = { ...DEFAULT_POLICY, ...user, classes: { ...DEFAULT_POLICY.classes, ...(user.classes || {}) } };
  for (const [cls, a] of Object.entries(p.classes)) {
    if (!ACTIONS.has(a)) throw new Error(`policy.classes.${cls} must be allow, approve, block or check (got '${a}')`);
  }
  if (!["allow", "approve", "block"].includes(p.unknown_value)) throw new Error("policy.unknown_value must be allow, approve or block");
  return p;
}

const globRe = (g) => new RegExp("^" + String(g).toUpperCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
export const matchesAny = (sym, globs) => (globs || []).some((g) => globRe(g).test(sym));
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US");

/** The static action for a class, ignoring arguments. Used to hide tools from tools/list. */
export function staticAction(policy, cls) {
  return policy.classes[cls] || "block";
}

/**
 * Decide one call.
 * @returns {{action:'allow'|'approve'|'block', reason:string, order?:object, counts:boolean}}
 *   counts = whether an executed call should be added to daily usage.
 */
export function decide({ info, args, policy, usage, mode, killed, now = Date.now() }) {
  const cls = info.class;
  if (killed && !KILL_SWITCH_ALLOWED.has(cls)) {
    const order = cls === "order" || cls === "modify" ? extractOrder(info, args) : undefined;
    return { action: "block", reason: "Kill switch is on: only reads, cancels and closing positions are allowed.", order, counts: false };
  }
  const a = staticAction(policy, cls);
  if (a === "block") return { action: "block", reason: `'${cls}' tools are blocked by policy.`, counts: false };
  if (a === "allow") return { action: "allow", reason: `'${cls}' is allowed.`, counts: false };
  if (a === "approve" && !(cls === "order" || cls === "modify")) {
    return { action: "approve", reason: `'${cls}' needs human approval.`, counts: false };
  }

  // Order-like call: inspect the arguments.
  const o = extractOrder(info, args);
  const res = (action, reason) => ({ action, reason, order: o, counts: true });

  if (o.symbol !== undefined) {
    if (matchesAny(o.symbol, policy.symbols_block)) return res("block", `${o.symbol} is on the block list.`);
    if (policy.symbols_allow?.length && !matchesAny(o.symbol, policy.symbols_allow)) return res("block", `${o.symbol} is not on the allow list (${policy.symbols_allow.join(", ")}).`);
  } else if (policy.symbols_allow?.length && cls === "order" && !o.multi_leg) {
    return res("block", "Order has no symbol, so the allow list cannot be checked.");
  }
  if (o.side !== undefined && policy.sides_allow?.length && !policy.sides_allow.includes(o.side)) {
    return res("block", `Side '${o.side}' is not allowed (allowed: ${policy.sides_allow.join(", ")}).`);
  }
  if (Number.isNaN(o.value)) return res("block", "Could not read the order size or price as a number.");
  if (o.value !== undefined && o.value <= 0) return res("block", "Order value must be positive.");

  // Rate and count limits apply to every order, sized or not.
  const recent = (usage.recent || []).filter((t) => now - t < 60_000).length;
  if (recent >= policy.max_orders_per_minute) return res("block", `Rate limit: ${policy.max_orders_per_minute} orders per minute.`);
  if ((usage.orders || 0) + 1 > policy.max_orders_per_day) return res("block", `Daily order limit reached (${policy.max_orders_per_day}).`);

  if (o.value !== undefined) {
    if (o.value > policy.max_order_value) return res("block", `Order value ${fmt(o.value)} is over the per-order limit of ${fmt(policy.max_order_value)}.`);
    if ((usage.spent || 0) + o.value > policy.max_daily_value) {
      return res("block", `Order value ${fmt(o.value)} would take today's total to ${fmt((usage.spent || 0) + o.value)}, over the daily limit of ${fmt(policy.max_daily_value)}.`);
    }
  }

  if (a === "approve") return res("approve", `'${cls}' needs human approval.`);
  if (o.value === undefined) {
    const why = o.multi_leg ? "a multi-leg order" : "the order has no price or notional (e.g. a market order by quantity)";
    if (policy.unknown_value === "block") return res("block", `Order value can't be computed: ${why}.`);
    if (policy.unknown_value === "approve") return res("approve", `Order value can't be computed: ${why}.`);
  } else if (o.value > policy.approve_over) {
    return res("approve", `Order value ${fmt(o.value)} is over the approval threshold of ${fmt(policy.approve_over)}.`);
  }
  if (mode === "live" && policy.live_requires_approval) return res("approve", "Live-money orders need human approval.");
  return res("allow", o.value !== undefined ? `Within limits (value ${fmt(o.value)}).` : "Allowed by policy.");
}
