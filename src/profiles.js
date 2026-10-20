// Connector profiles: what each tool of a trading MCP server can do with money.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = join(HERE, "..", "profiles");

/** Read a JSON file, tolerating the UTF-8 BOM that Windows PowerShell adds. */
export function readJson(path) {
  const t = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  try { return JSON.parse(t); } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
}

export const CLASSES = ["read", "benign_write", "order", "modify", "cancel", "cancel_all", "close", "close_all", "leverage", "funds_out", "account", "raw_write", "other_write", "unknown"];

export function listBuiltinProfiles() {
  return readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

/** Load a profile by built-in slug or by file path. Returns null for "auto" / undefined. */
export function loadProfile(ref, baseDir = process.cwd()) {
  if (!ref || ref === "auto") return null;
  const builtin = join(PROFILE_DIR, ref + ".json");
  const path = existsSync(builtin) ? builtin : resolve(baseDir, ref);
  if (!existsSync(path)) throw new Error(`Profile '${ref}' not found. Built-in profiles: ${listBuiltinProfiles().join(", ")}`);
  const p = readJson(path);
  if (p.profile_version !== 1 || !p.tools || typeof p.tools !== "object") throw new Error(`Profile ${path} is not a v1 connector profile`);
  for (const [name, t] of Object.entries(p.tools)) {
    if (!CLASSES.includes(t.class)) throw new Error(`Profile ${p.slug}: tool ${name} has unknown class '${t.class}'`);
  }
  return p;
}

// Heuristics for servers without a verified profile. Deliberately conservative:
// anything that looks like it can move money but has no field mapping ends up needing approval.
const H = [
  [/withdraw|transfer|send_?funds|payout|wire|bridge/i, "funds_out"],
  [/leverage|margin_?mode/i, "leverage"],
  [/cancel_?all|cancel_?orders$|mass_?cancel/i, "cancel_all"],
  [/cancel/i, "cancel"],
  [/close_?all|liquidate_?all|flatten_?all/i, "close_all"],
  [/close_?position|liquidate|flatten/i, "close"],
  [/(replace|modify|edit|amend|update)_?order/i, "modify"],
  [/(place|create|submit|new|send)_?\w*order|^(buy|sell|trade|swap)\b|^(buy|sell|trade|swap)_|market_?order|limit_?order/i, "order"],
  [/^(get|list|search|fetch|describe|lookup|read|query|show|find)_/i, "read"],
];
const HFIELDS = {
  symbol: ["symbol", "ticker", "instrument", "market", "pair", "asset", "product_id", "token_id", "coin"],
  side: ["side", "action", "direction"],
  qty: ["qty", "quantity", "amount", "size", "shares", "contracts", "volume"],
  notional: ["notional", "cost", "value", "usd_amount", "amount_usd", "dollars"],
  price: ["limit_price", "price", "stop_price"],
  legs: ["legs"],
};

/**
 * Classify one tool. `def` is the tool definition from tools/list (for annotations).
 * Returns { class, fields, multiplier, source }.
 */
export function classify(profile, name, def = {}) {
  if (profile?.tools?.[name]) return { ...profile.tools[name], source: "profile" };
  for (const p of profile?.patterns || []) {
    if (new RegExp(p.match).test(name)) return { class: p.class, source: "profile-pattern" };
  }
  if (profile) return { class: "unknown", source: "profile-missing" };
  for (const [re, cls] of H) {
    if (re.test(name)) {
      if (cls === "read" && def.annotations?.destructiveHint === true) break;
      return { class: cls, fields: ["order", "modify"].includes(cls) ? HFIELDS : undefined, source: "heuristic" };
    }
  }
  if (def.annotations?.readOnlyHint === true && def.annotations?.destructiveHint !== true) return { class: "read", source: "annotation" };
  return { class: "unknown", source: "heuristic" };
}

const pick = (args, ref) => {
  if (!ref || !args) return undefined;
  for (const k of Array.isArray(ref) ? ref : [ref]) if (args[k] !== undefined && args[k] !== null && args[k] !== "") return args[k];
  return undefined;
};
const num = (v) => {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,_\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/** Pull order facts out of call arguments using the tool's field mapping. */
export function extractOrder(info, args = {}) {
  const f = info.fields || {};
  const legs = pick(args, f.legs);
  const o = {
    symbol: pick(args, f.symbol),
    side: pick(args, f.side),
    qty: num(pick(args, f.qty)),
    notional: num(pick(args, f.notional)),
    price: num(pick(args, f.price)),
    multi_leg: Array.isArray(legs) && legs.length > 0,
  };
  if (o.symbol !== undefined) o.symbol = String(o.symbol).toUpperCase();
  if (o.side !== undefined) o.side = String(o.side).toLowerCase();
  const mult = info.multiplier || 1;
  if ([o.qty, o.notional, o.price].some((x) => Number.isNaN(x))) o.value = NaN;
  else if (o.multi_leg) o.value = undefined;
  else if (o.notional !== undefined) o.value = o.notional;
  else if (o.qty !== undefined && o.price !== undefined) o.value = o.qty * o.price * mult;
  else o.value = undefined;
  return o;
}

/** Paper or live, from the profile's mode rule and the upstream server's environment. */
export function detectMode(profile, env = {}) {
  const m = profile?.mode;
  if (!m) return "live";
  if (m.env && env[m.env] !== undefined) {
    return (m.paper_values || []).includes(String(env[m.env]).toLowerCase()) ? "paper" : "live";
  }
  return m.default || "live";
}
