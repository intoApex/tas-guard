import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, resolvePolicy } from "../src/policy.js";
import { classify, extractOrder, loadProfile, detectMode, listBuiltinProfiles } from "../src/profiles.js";
import { State } from "../src/state.js";

const alpaca = loadProfile("alpaca-mcp-server");
const ccxt = loadProfile("ccxt-mcp-server");
const policy = resolvePolicy({ max_order_value: 500, max_daily_value: 1000, approve_over: 250, live_requires_approval: false });
const usage = { spent: 0, orders: 0, recent: [] };
const call = (name, args, extra = {}) => decide({ info: classify(alpaca, name), args, policy, usage, mode: "paper", killed: false, ...extra });

test("built-in profiles load and every tool has a valid class", () => {
  assert.deepEqual(listBuiltinProfiles().sort(), ["alpaca-mcp-server", "ccxt-mcp-server"]);
  for (const s of listBuiltinProfiles()) assert.ok(Object.keys(loadProfile(s).tools).length > 5);
});

test("classification: profile, pattern, missing, heuristics", () => {
  assert.equal(classify(alpaca, "place_stock_order").class, "order");
  assert.equal(classify(alpaca, "get_stock_bars").source, "profile-pattern");
  assert.equal(classify(alpaca, "brand_new_tool").class, "unknown");
  assert.equal(classify(ccxt, "withdraw").class, "funds_out");
  assert.equal(classify(null, "submit_order").class, "order");
  assert.equal(classify(null, "withdraw_usdc").class, "funds_out");
  assert.equal(classify(null, "get_quote").class, "read");
  assert.equal(classify(null, "quote", { annotations: { readOnlyHint: true } }).class, "read");
  assert.equal(classify(null, "get_and_trade", { annotations: { destructiveHint: true } }).class, "unknown");
});

test("order value: notional, qty x price, option multiplier, multi-leg, junk", () => {
  assert.equal(extractOrder(classify(alpaca, "place_stock_order"), { symbol: "aapl", qty: "2", limit_price: "150.5" }).value, 301);
  assert.equal(extractOrder(classify(alpaca, "place_stock_order"), { symbol: "SPY", notional: "$1,200" }).value, 1200);
  assert.equal(extractOrder(classify(alpaca, "place_option_order"), { symbol: "AAPL260116C00200000", qty: "1", limit_price: "2.5" }).value, 250);
  assert.equal(extractOrder(classify(alpaca, "place_option_order"), { qty: "1", legs: [{}, {}] }).value, undefined);
  assert.ok(Number.isNaN(extractOrder(classify(alpaca, "place_stock_order"), { symbol: "X", qty: "lots", limit_price: "1" }).value));
  assert.equal(extractOrder(classify(ccxt, "create_order"), { symbol: "BTC/USDT", amount: 0.01, price: 60000 }).value, 600);
});

test("mode detection", () => {
  assert.equal(detectMode(alpaca, {}), "paper");
  assert.equal(detectMode(alpaca, { ALPACA_PAPER_TRADE: "false" }), "live");
  assert.equal(detectMode(ccxt, {}), "live");
  assert.equal(detectMode(null, {}), "live");
});

test("decisions: allow, approve, block", () => {
  assert.equal(call("get_account_info", {}).action, "allow");
  assert.equal(call("place_stock_order", { symbol: "AAPL", qty: "1", limit_price: "100" }).action, "allow");
  assert.equal(call("place_stock_order", { symbol: "AAPL", qty: "3", limit_price: "100" }).action, "approve");
  assert.equal(call("place_stock_order", { symbol: "AAPL", qty: "6", limit_price: "100" }).action, "block");
  assert.equal(call("place_stock_order", { symbol: "AAPL", qty: "1" }).action, "approve", "market order by qty has no value");
  assert.equal(call("place_stock_order", { symbol: "AAPL", qty: "-1", limit_price: "10" }).action, "block");
  assert.equal(call("update_account_config", {}).action, "block");
  assert.equal(call("close_all_positions", {}).action, "approve");
  assert.equal(call("brand_new_tool", {}).action, "block", "unknown tools fail closed");
});

test("hard limits beat approval; daily cap, count and rate limits", () => {
  const u = { spent: 900, orders: 3, recent: [] };
  assert.match(call("place_stock_order", { symbol: "AAPL", notional: "200" }, { usage: u }).reason, /daily limit/);
  assert.match(call("place_stock_order", { symbol: "AAPL", notional: "10" }, { usage: { spent: 0, orders: 20, recent: [] } }).reason, /Daily order limit/);
  const now = Date.now();
  assert.match(call("place_stock_order", { symbol: "AAPL", notional: "10" }, { usage: { spent: 0, orders: 3, recent: [now, now, now] }, now }).reason, /Rate limit/);
});

test("symbol and side rules", () => {
  const p = resolvePolicy({ symbols_allow: ["SPY", "BTC/*"], symbols_block: ["BTC/DOGE"], sides_allow: ["buy"], live_requires_approval: false });
  const d = (name, args, prof = alpaca) => decide({ info: classify(prof, name), args, policy: p, usage, mode: "paper", killed: false }).action;
  assert.equal(d("place_stock_order", { symbol: "spy", side: "buy", notional: "10" }), "allow");
  assert.equal(d("place_stock_order", { symbol: "TSLA", side: "buy", notional: "10" }), "block");
  assert.equal(d("place_stock_order", { symbol: "SPY", side: "sell", notional: "10" }), "block");
  assert.equal(d("create_order", { symbol: "BTC/USDT", side: "buy", amount: 0.001, price: 10000 }, ccxt), "allow");
  assert.equal(d("create_order", { symbol: "BTC/DOGE", side: "buy", amount: 1, price: 1 }, ccxt), "block");
});

test("live mode requires approval when configured", () => {
  const p = resolvePolicy({ live_requires_approval: true });
  const r = decide({ info: classify(alpaca, "place_stock_order"), args: { symbol: "AAPL", notional: "10" }, policy: p, usage, mode: "live", killed: false });
  assert.equal(r.action, "approve");
  assert.match(r.reason, /Live-money/);
});

test("kill switch blocks new risk but allows reads, cancels and closes", () => {
  const k = (name, args = {}) => call(name, args, { killed: true }).action;
  assert.equal(k("place_stock_order", { symbol: "AAPL", notional: "1" }), "block");
  assert.equal(k("get_account_info"), "allow");
  assert.equal(k("cancel_order_by_id"), "allow");
  assert.equal(k("close_all_positions"), "approve");
});

test("bad policy values are rejected", () => {
  assert.throws(() => resolvePolicy({ classes: { order: "yolo" } }));
  assert.throws(() => resolvePolicy({ unknown_value: "maybe" }));
});

test("audit log is hash-chained, redacts secrets and detects tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const s = new State(dir, "t");
  s.audit({ tool: "a", outcome: "executed", args: { symbol: "AAPL", api_key: "sk-123" } });
  s.audit({ tool: "b", outcome: "blocked" });
  assert.deepEqual(s.verifyAudit(), { ok: true, lines: 2 });
  const raw = readFileSync(s.auditPath, "utf8");
  assert.ok(!raw.includes("sk-123"));
  writeFileSync(s.auditPath, raw.replace('"tool":"a"', '"tool":"z"'));
  assert.equal(s.verifyAudit().ok, false);
});

test("approvals are single-use and expire", () => {
  const s = new State(mkdtempSync(join(tmpdir(), "tg-")), "t");
  const item = s.requestApproval({ fingerprint: "f1", tool: "x", summary: "x", reason: "r" });
  assert.equal(s.requestApproval({ fingerprint: "f1", tool: "x", summary: "x", reason: "r" }).id, item.id, "same call reuses the request");
  assert.equal(s.consumeApproval("f1", 15), null, "not approved yet");
  s.decideApproval(item.id, true);
  assert.ok(s.consumeApproval("f1", 15));
  assert.equal(s.consumeApproval("f1", 15), null, "single use");
  assert.throws(() => s.decideApproval(item.id, true));
  const old = s.requestApproval({ fingerprint: "f2", tool: "x", summary: "x", reason: "r" });
  s.decideApproval(old.id, true);
  assert.equal(s.consumeApproval("f2", 0), null, "expired");
});
