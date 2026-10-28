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
const robinhood = loadProfile("robinhood-trading-mcp");
const tradier = loadProfile("tradier-mcp-server");
const policy = resolvePolicy({ max_order_value: 500, max_daily_value: 1000, approve_over: 250, live_requires_approval: false });
const usage = { spent: 0, orders: 0, recent: [] };
const call = (name, args, extra = {}) => decide({ info: classify(alpaca, name), args, policy, usage, mode: "paper", killed: false, ...extra });

test("built-in profiles load and every tool has a valid class", () => {
  assert.deepEqual(listBuiltinProfiles().sort(), ["alpaca-mcp-server", "ccxt-mcp-server", "robinhood-trading-mcp", "tradier-mcp-server"]);
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

test("robinhood profile: classes, no guessed order fields, fails safe", () => {
  assert.equal(Object.keys(robinhood.tools).length, 94);
  assert.equal(classify(robinhood, "place_equity_order").class, "order");
  assert.equal(classify(robinhood, "place_option_order").multiplier, 100);
  assert.equal(classify(robinhood, "review_equity_order").class, "read");
  assert.equal(classify(robinhood, "cancel_crypto_order").class, "cancel");
  assert.equal(classify(robinhood, "exercise_option").class, "other_write");
  assert.equal(classify(robinhood, "add_legend_indicator").class, "benign_write");
  assert.equal(classify(robinhood, "get_new_thing").source, "profile-pattern");
  assert.equal(classify(robinhood, "transfer_funds").class, "unknown");
  assert.equal(detectMode(robinhood, {}), "live");
  const d = (name, p) => decide({ info: classify(robinhood, name), args: { symbol: "AAPL", quantity: 1 }, policy: resolvePolicy(p), usage, mode: "live", killed: false }).action;
  assert.equal(d("place_equity_order", { live_requires_approval: false }), "approve", "value unknown without documented fields");
  assert.equal(d("place_equity_order", { symbols_allow: ["AAPL"] }), "block", "allow list can't be checked");
  assert.equal(d("exercise_option", {}), "approve");
});

test("tradier profile: documented tools, string values, option multiplier, fails safe", () => {
  assert.equal(Object.keys(tradier.tools).length, 22);
  assert.equal(classify(tradier, "get_positions").class, "read");
  assert.equal(classify(tradier, "add_to_watchlist").class, "benign_write");
  assert.equal(classify(tradier, "cancel_order").class, "cancel");
  assert.equal(classify(tradier, "place_otoco_order").class, "order");
  assert.equal(classify(tradier, "get_new_thing").source, "profile-pattern");
  assert.equal(classify(tradier, "withdraw_funds").class, "unknown");
  assert.equal(extractOrder(classify(tradier, "place_equity_order"), { accountNumber: "1", symbol: "aapl", side: "buy", quantity: "10", type: "limit", duration: "day", price: "150" }).value, 1500);
  assert.equal(extractOrder(classify(tradier, "place_option_order"), { symbol: "SPY", optionSymbol: "SPY261218C00600000", side: "buy_to_open", quantity: "2", type: "limit", price: "1.25" }).value, 250);
  assert.equal(extractOrder(classify(tradier, "place_multileg_option_order"), { symbol: "SPY", type: "debit", price: "1" }).value, undefined);
  assert.equal(detectMode(tradier, {}), "live");
  assert.equal(detectMode(tradier, { PAPER_TRADING: "true" }), "paper");
  assert.equal(detectMode(tradier, { PAPER_TRADING: "false" }), "live");
  const d = (name, args, p) => decide({ info: classify(tradier, name), args, policy: resolvePolicy(p), usage, mode: "paper", killed: false }).action;
  assert.equal(d("place_equity_order", { symbol: "AAPL", side: "buy", quantity: "1", type: "limit", price: "100" }, { max_order_value: 500, approve_over: 250 }), "allow");
  assert.equal(d("place_equity_order", { symbol: "AAPL", side: "buy", quantity: "10", type: "limit", price: "100" }, { max_order_value: 500 }), "block");
  assert.equal(d("place_equity_order", { symbol: "AAPL", side: "buy", quantity: "1", type: "market" }, {}), "approve", "market order has no value");
  assert.equal(d("place_oto_order", { accountNumber: "1" }, { symbols_allow: ["AAPL"] }), "block", "allow list can't be checked");
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

test("config files with a Windows UTF-8 BOM are read", async () => {
  const { readJson } = await import("../src/profiles.js");
  const f = join(mkdtempSync(join(tmpdir(), "tg-")), "c.json");
  writeFileSync(f, "﻿" + JSON.stringify({ a: 1 }));
  assert.deepEqual(readJson(f), { a: 1 });
  writeFileSync(f, "{bad");
  assert.throws(() => readJson(f), /not valid JSON/);
});
