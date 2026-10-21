// End to end: a fake MCP client -> tas-guard (real process) -> mock broker (real process).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.js");
const MOCK = join(ROOT, "test", "mock-broker.js");

function startGuard({ profile = "alpaca-mcp-server", policy = {}, env = {}, elicitation = false, onElicit } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tg-e2e-"));
  const mockLog = join(home, "upstream.jsonl");
  const policyPath = join(home, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const childEnv = { ...process.env, TAS_GUARD_HOME: home, MOCK_LOG: mockLog, ...env };
  const p = spawn(process.execPath, [CLI, "run", "--profile", profile, "--policy", policyPath, "--name", "t", "--", process.execPath, MOCK], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  const waiting = new Map();
  let id = 0, buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method && m.id !== undefined) {
        // request from the guard to us (the client)
        const answer = m.method === "elicitation/create" && onElicit ? onElicit(m.params) : {};
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }) + "\n");
      } else if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}\nstderr:\n${stderr}`)), 5000);
    waiting.set(myId, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  const callTool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { env: childEnv, encoding: "utf8" });
  const upstreamCalls = () => (existsSync(mockLog) ? readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const init = () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: elicitation ? { elicitation: {} } : {}, clientInfo: { name: "test", version: "1" } });
  const stop = () => { p.stdin.end(); p.kill(); };
  return { rpc, callTool, cli, upstreamCalls, init, stop, home };
}
const txt = (r) => r.content.map((c) => c.text).join("\n");

test("handshake, tool list filtering and tagging, read passthrough", async () => {
  const g = startGuard();
  try {
    const init = await g.init();
    assert.match(init.result.instructions, /Mock broker\.[\s\S]*TAS Guard \(paper mode\)/);
    const { result } = await g.rpc("tools/list", {});
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes("tas_guard_status"));
    assert.ok(!names.includes("update_account_config"), "blocked class hidden");
    assert.ok(!names.includes("mystery_tool"), "unknown tool hidden");
    assert.match(result.tools.find((t) => t.name === "place_stock_order").description, /^\[TAS Guard: max 500/);
    assert.match(result.tools.find((t) => t.name === "close_all_positions").description, /needs human approval/);
    const r = await g.callTool("get_account_info");
    assert.ok(!r.isError);
    assert.equal(g.upstreamCalls().length, 1);
    const ping = await g.rpc("ping", {});
    assert.deepEqual(ping.result, {});
  } finally { g.stop(); }
});

test("orders: within limits executes, over limit and off-list are blocked before reaching the broker", async () => {
  const g = startGuard({ policy: { symbols_allow: ["AAPL", "SPY"] } });
  try {
    await g.init(); await g.rpc("tools/list", {});
    const ok = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", qty: "1", limit_price: "100" });
    assert.ok(!ok.isError, txt(ok));
    const big = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", qty: "10", limit_price: "100" });
    assert.ok(big.isError); assert.match(txt(big), /over the per-order limit/);
    const off = await g.callTool("place_stock_order", { symbol: "TSLA", side: "buy", qty: "1", limit_price: "10" });
    assert.ok(off.isError); assert.match(txt(off), /not on the allow list/);
    const blocked = await g.callTool("update_account_config", {});
    assert.ok(blocked.isError);
    assert.deepEqual(g.upstreamCalls().map((c) => c.name), ["place_stock_order"], "only the allowed order reached the broker");
    const status = JSON.parse(txt(await g.callTool("tas_guard_status")));
    assert.equal(status.today.value_used, 100);
    assert.equal(status.today.orders, 1);
    assert.equal(status.mode, "paper");
  } finally { g.stop(); }
});

test("approval via CLI: held, approved by the human, then the same call executes once", async () => {
  const g = startGuard();
  try {
    await g.init(); await g.rpc("tools/list", {});
    const args = { symbol: "AAPL", side: "buy", qty: "2" }; // market by qty: value unknown
    const held = await g.callTool("place_stock_order", args);
    assert.ok(held.isError);
    const id = txt(held).match(/request ([0-9a-f]{6})/)[1];
    assert.equal(g.upstreamCalls().length, 0);
    assert.match(g.cli("pending"), new RegExp(id));
    assert.match(g.cli("approve", id), /Approved/);
    const ok = await g.callTool("place_stock_order", args);
    assert.ok(!ok.isError, txt(ok));
    const again = await g.callTool("place_stock_order", args);
    assert.ok(again.isError, "approval is single-use");
    assert.equal(g.upstreamCalls().length, 1);
  } finally { g.stop(); }
});

test("approval via the client's prompt (elicitation): accept executes, decline does not", async () => {
  let answer = true;
  const g = startGuard({ elicitation: true, onElicit: (params) => { assert.match(params.message, /AAPL/); return { action: "accept", content: { approve: answer } }; } });
  try {
    await g.init(); await g.rpc("tools/list", {});
    const ok = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", qty: "3", limit_price: "100" });
    assert.ok(!ok.isError, txt(ok));
    answer = false;
    const no = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", qty: "3", limit_price: "100" });
    assert.ok(no.isError); assert.match(txt(no), /declined/);
    assert.equal(g.upstreamCalls().length, 1);
  } finally { g.stop(); }
});

test("daily cap holds across orders, and rejected orders don't count", async () => {
  const g = startGuard({ policy: { max_daily_value: 250, approve_over: 1000, max_orders_per_minute: 50 } });
  try {
    await g.init(); await g.rpc("tools/list", {});
    const rej = await g.callTool("place_stock_order", { symbol: "REJECT", side: "buy", notional: "100" });
    assert.ok(rej.isError, "broker rejected it");
    for (let i = 0; i < 2; i++) assert.ok(!(await g.callTool("place_stock_order", { symbol: "SPY", side: "buy", notional: "100" })).isError);
    const over = await g.callTool("place_stock_order", { symbol: "SPY", side: "buy", notional: "100" });
    assert.match(txt(over), /daily limit/);
  } finally { g.stop(); }
});

test("parallel orders cannot exceed the daily cap", async () => {
  const g = startGuard({ policy: { max_daily_value: 300, approve_over: 1000, max_orders_per_minute: 50 } });
  try {
    await g.init(); await g.rpc("tools/list", {});
    const rs = await Promise.all(Array.from({ length: 6 }, () => g.callTool("place_stock_order", { symbol: "SPY", side: "buy", notional: "100" })));
    assert.equal(rs.filter((r) => !r.isError).length, 3);
    assert.equal(g.upstreamCalls().length, 3);
  } finally { g.stop(); }
});

test("kill switch stops new orders on a running guard; cancels still work", async () => {
  const g = startGuard();
  try {
    await g.init(); await g.rpc("tools/list", {});
    g.cli("kill", "test");
    const o = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" });
    assert.match(txt(o), /Kill switch/);
    assert.ok(!(await g.callTool("cancel_order_by_id", { order_id: "1" })).isError);
    g.cli("resume");
    assert.ok(!(await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" })).isError);
  } finally { g.stop(); }
});

test("live mode from the upstream env requires approval", async () => {
  const g = startGuard({ env: { ALPACA_PAPER_TRADE: "false" } });
  try {
    const init = await g.init();
    assert.match(init.result.instructions, /live mode/);
    await g.rpc("tools/list", {});
    const r = await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" });
    assert.match(txt(r), /Live-money/);
    assert.equal(g.upstreamCalls().length, 0);
  } finally { g.stop(); }
});

test("ccxt preview + confirm: the preview isn't counted, the confirmed order is, one approval covers both", async () => {
  const g = startGuard({ profile: "ccxt-mcp-server", policy: { live_requires_approval: false, approve_over: 1000 } });
  try {
    await g.init(); await g.rpc("tools/list", {});
    const args = { account: "main", symbol: "BTC/USDT", type: "limit", side: "buy", amount: 0.001, price: 60000 };
    const prev = await g.callTool("create_order", args);
    assert.match(txt(prev), /confirmToken/);
    let s = JSON.parse(txt(await g.callTool("tas_guard_status")));
    assert.equal(s.today.orders, 0);
    await g.callTool("create_order", { ...args, confirm: "tok-1" });
    s = JSON.parse(txt(await g.callTool("tas_guard_status")));
    assert.equal(s.today.orders, 1);
    assert.equal(s.today.value_used, 60);
  } finally { g.stop(); }
});

test("audit log records every decision and verifies", async () => {
  const g = startGuard();
  try {
    await g.init(); await g.rpc("tools/list", {});
    await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" });
    await g.callTool("place_stock_order", { symbol: "AAPL", side: "buy", notional: "100000" });
    const log = g.cli("log");
    assert.match(log, /executed\s+place_stock_order/);
    assert.match(log, /blocked\s+place_stock_order/);
    assert.match(g.cli("verify-log"), /hash chain intact/);
  } finally { g.stop(); }
});

test("client hang-up: in-flight calls still get their answers (no lost order results)", async () => {
  const home = mkdtempSync(join(tmpdir(), "tg-e2e-"));
  const p = spawn(process.execPath, [CLI, "run", "--profile", "auto", "--", process.execPath, MOCK], { env: { ...process.env, TAS_GUARD_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_account_info", arguments: {} } },
  ];
  p.stdin.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise((r) => p.on("exit", r));
  const ids = out.trim().split("\n").map((l) => JSON.parse(l).id).sort();
  assert.deepEqual(ids, [1, 2, 3]);
});

test("tas-guard demo: starts without a broker, lists tools, allows small orders, holds and blocks the rest", async () => {
  const home = mkdtempSync(join(tmpdir(), "tg-demo-"));
  const p = spawn(process.execPath, [CLI, "demo"], { env: { ...process.env, TAS_GUARD_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "place_stock_order", arguments: { symbol: "SPY", side: "buy", qty: "1", limit_price: "580" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "place_stock_order", arguments: { symbol: "SPY", side: "buy", qty: "2", limit_price: "580" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "place_stock_order", arguments: { symbol: "SPY", side: "buy", qty: "10", limit_price: "580" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "place_stock_order", arguments: { symbol: "TSLA", side: "buy", qty: "1", limit_price: "250" } } },
  ];
  p.stdin.end(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  let out = ""; p.stdout.on("data", (d) => (out += d));
  await new Promise((r) => p.on("exit", r));
  const by = Object.fromEntries(out.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  const names = by[2].result.tools.map((t) => t.name);
  assert.ok(names.includes("place_stock_order") && names.includes("tas_guard_status") && !names.includes("update_account_config"));
  assert.ok(!by[3].result.isError, "580 is within limits");
  assert.match(by[4].result.content[0].text, /holding this action/);
  assert.match(by[5].result.content[0].text, /per-order limit/);
  assert.match(by[6].result.content[0].text, /not on the allow list/);
});
