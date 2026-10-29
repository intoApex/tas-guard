// Hyperliquid mode: signing checked byte for byte against the official Python SDK, wire-format helpers,
// and the MCP flow: fake MCP client -> GuardProxy -> HlServer -> mock Hyperliquid API (injected fetch).
// Everything runs offline; nothing here talks to Hyperliquid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parsePrivateKey, privateKeyToAddress, recoverAddress, signHash } from "../src/eth-crypto.js";
import * as hs from "../src/hl-sign.js";
import { HlServer, HL_PROFILE, approveFee } from "../src/hyperliquid.js";
import { BUILDER_ADDRESS, BUILDER_FEE, feePercent, feeOptedOut } from "../src/hl-fee.js";
import { GuardProxy } from "../src/proxy.js";
import { resolvePolicy } from "../src/policy.js";
import { State } from "../src/state.js";
import { startMockTelegram } from "./mock-telegram.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.js");
const fx = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "hl-vectors.json"), "utf8"));
const ACCOUNT = fx.main_address;   // the user's main account
const AGENT_KEY = fx.agent_key;     // the API wallet that signs orders
const BUILDER = fx.builder;         // a test builder address (mixed case)
const OWNER = 4242;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

// ---------- primitives ----------
test("keccak-256: known vectors (not SHA3-256) and SDK vectors across block boundaries", () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(Buffer.from("abc")).toString("hex"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.notEqual(keccak256(Buffer.alloc(0)).toString("hex"), "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a", "that would be SHA3-256");
  for (const v of fx.keccak) assert.equal(keccak256(Buffer.from(v.hex, "hex")).toString("hex"), v.keccak, `${v.hex.length / 2} bytes`);
});

test("msgpack: byte-identical to Python msgpack.packb for every type and size boundary", () => {
  const unbig = (v) => (v && typeof v === "object" && !Array.isArray(v) && "$big" in v ? BigInt(v.$big) : v);
  for (const v of fx.msgpack) assert.equal(hs.msgpackEncode(unbig(v.value)).toString("hex"), v.msgpack, JSON.stringify(v.value).slice(0, 80));
  assert.throws(() => hs.msgpackEncode({ 1: "x" }), /reordered/);
  assert.throws(() => hs.msgpackEncode({ a: undefined }), /undefined/);
});

test("float_to_wire: same output and same refusals as the SDK", () => {
  for (const v of fx.float_to_wire) {
    if (v.error) assert.throws(() => hs.floatToWire(v.value), /rounding/, String(v.value));
    else assert.equal(hs.floatToWire(v.value), v.wire, String(v.value));
  }
  assert.throws(() => hs.floatToWire(-1), /negative/);
  assert.throws(() => hs.floatToWire(NaN), /finite/);
});

test("market-order price rounding: identical to the SDK's _slippage_price on 408 cases (ties included)", () => {
  for (const v of fx.slippage_price) assert.equal(hs.slippagePrice(v.mid, v.is_buy, v.slippage, v.sz_decimals, v.spot), v.price, JSON.stringify(v));
  assert.equal(hs.pyRound(2.675, 2), 2.67, "binary value of 2.675 is below the tie, like Python");
  assert.equal(hs.pySig(1.03125, 5), 1.0312, "exact tie rounds half to even, like Python");
});

test("limit prices fit Hyperliquid's tick rules, rounded never in the user's disfavor; sizes round down", () => {
  const perp = (szDecimals) => ({ szDecimals, isSpot: false });
  assert.equal(hs.fitLimitPrice(60123.4, { isBuy: true, ...perp(5) }), 60123);
  assert.equal(hs.fitLimitPrice(60123.4, { isBuy: false, ...perp(5) }), 60124);
  assert.equal(hs.fitLimitPrice(123456, { isBuy: true, ...perp(5) }), 123456, "integer prices are always valid");
  assert.equal(hs.fitLimitPrice("2345.67", { isBuy: true, ...perp(4) }), 2345.6);
  assert.equal(hs.fitLimitPrice("2345.67", { isBuy: false, ...perp(4) }), 2345.7);
  assert.equal(hs.fitLimitPrice(0.0000123456, { isBuy: true, ...perp(0) }), 0.000012, "max 6 - szDecimals decimals");
  assert.equal(hs.fitLimitPrice(0.0000123456, { isBuy: false, ...perp(0) }), 0.000013);
  assert.equal(hs.fitLimitPrice(0.123456789, { isBuy: false, szDecimals: 2, isSpot: true }), 0.12346, "5 significant figures");
  assert.equal(hs.fitLimitPrice("41.237", { isBuy: false, szDecimals: 2, isSpot: true }), 41.237, "valid prices are unchanged");
  assert.throws(() => hs.fitLimitPrice("abc", { isBuy: true, ...perp(2) }), /plain positive decimal/);
  assert.throws(() => hs.fitLimitPrice(-5, { isBuy: true, ...perp(2) }), /positive/);
  assert.equal(hs.fitSize(0.123456, 5), 0.12345);
  assert.equal(hs.fitSize(0.3, 1), 0.3, "decimal 0.3, not its binary value 0.2999...");
  assert.equal(hs.fitSize("1.99", 0), 1);
  assert.equal(hs.fitSize(1e-7, 8), 1e-7);
  assert.throws(() => hs.fitSize("1,000", 2), /plain positive decimal/);
});

test("secp256k1: address derivation, deterministic low-s signatures that recover, bad keys refused", () => {
  const d = parsePrivateKey(AGENT_KEY);
  assert.equal(privateKeyToAddress(d), fx.agent_address);
  assert.equal(privateKeyToAddress(parsePrivateKey(fx.main_key)), fx.main_address);
  const h = keccak256(Buffer.from("tas-guard"));
  const a = signHash(h, d), b = signHash(h, d);
  assert.deepEqual(a, b, "RFC 6979: same key and hash, same signature");
  assert.ok(a.s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n, "low s");
  assert.equal(recoverAddress(h, a), fx.agent_address);
  assert.throws(() => parsePrivateKey("0x1234"), /32-byte/);
  assert.throws(() => parsePrivateKey("0x" + "0".repeat(64)), /out of range/);
  assert.throws(() => parsePrivateKey("0x" + "f".repeat(64)), /out of range/);
});

// ---------- signing parity with the Python SDK ----------
test("SDK parity: msgpack bytes, connectionId, EIP-712 digest and r/s/v for every action on mainnet and testnet", () => {
  const agent = parsePrivateKey(AGENT_KEY), main = parsePrivateKey(fx.main_key);
  assert.equal(fx.actions.length, 16);
  for (const v of fx.actions) {
    const label = `${v.network} ${v.name}`;
    const mainnet = v.network === "mainnet";
    const sdk = v.payload;
    if (v.kind === "l1") {
      assert.equal(hs.msgpackEncode(sdk.action).toString("hex"), v.msgpack, label);
      const { connectionId, signature } = hs.signL1Action(agent, sdk.action, { nonce: v.nonce, mainnet });
      assert.equal(hex(connectionId), v.connection_id, label);
      assert.equal(hex(hs.digestFor("l1", sdk.action, { nonce: v.nonce, mainnet })), v.digest, label);
      assert.deepEqual(signature, sdk.signature, label);
    } else {
      const { action, signature } = hs.signApproveBuilderFee(main, { builder: v.params.builder, maxFeeRate: v.params.max_fee_rate, nonce: v.nonce, mainnet });
      assert.equal(JSON.stringify(action), JSON.stringify(sdk.action), label + " (same fields, same order)");
      assert.equal(hex(hs.digestFor("user", action)), v.digest, label);
      assert.deepEqual(signature, sdk.signature, label);
    }
  }
  const short = fx.actions.filter((v) => v.payload.signature.r.length < 66 || v.payload.signature.s.length < 66);
  assert.ok(short.length >= 2, "vectors include r/s with a leading zero nibble, written as minimal hex like the SDK");
  assert.ok(fx.actions.some((v) => v.payload.signature.v === 28) && fx.actions.some((v) => v.payload.signature.v === 27));
});

test("SDK parity end to end: HlServer posts exactly the payload the SDK posts (same actions, rounding, builder, signature)", async () => {
  for (const v of fx.actions) {
    const label = `${v.network} ${v.name}`;
    const testnet = v.network === "testnet";
    const hl = mockHl({ testnet, mids: { ETH: "2345.678", BTC: "60000", SOL: "150", "@107": "41" } });
    const p = v.params;
    if (v.kind === "user") {
      await approveFee({ testnet, yes: true, env: { HL_MAIN_PRIVATE_KEY: fx.main_key }, fetch: hl.fetch, builderAddress: BUILDER, nonce: v.nonce, out: () => {} });
    } else {
      const server = new HlServer({ account: ACCOUNT, apiKey: AGENT_KEY, testnet, fetch: hl.fetch, builderAddress: p.builder ? BUILDER : null });
      server.client.nonce = () => v.nonce;
      let r;
      if (v.name === "cancel") r = await server.callTool("hl_cancel_order", { coin: p.coin, oid: p.oid });
      else if (v.name === "update_leverage") r = await server.callTool("hl_update_leverage", { coin: p.coin, leverage: p.leverage, is_cross: p.is_cross });
      else if (v.name === "market_open_with_builder") r = await server.callTool("hl_place_order", { coin: p.coin, side: p.side, size: p.size, type: "market", max_slippage_pct: p.slippage * 100 });
      else r = await server.callTool("hl_place_order", { coin: p.coin, side: p.side, size: p.size, type: "limit", price: p.price, tif: p.tif, reduce_only: p.reduce_only });
      assert.ok(!r.isError, label + ": " + r.content[0].text);
    }
    const sent = hl.exchange();
    assert.equal(sent.length, 1, label);
    assert.equal(JSON.stringify(sent[0].body), JSON.stringify(v.payload), label);
  }
});

// ---------- a mock Hyperliquid API ----------
/** Answers /info from the fixture's meta, and /exchange like Hyperliquid, after checking each signature recovers to the expected signer. */
function mockHl({ mids = { BTC: "60000", ETH: "2500", SOL: "150", kPEPE: "0.012", "@107": "41.2", "PURR/USDC": "0.2" }, approvedFee = 20, positions = [], testnet = false, fail } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, testnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz", "only Hyperliquid's own API");
    const body = JSON.parse(init.body);
    calls.push({ path: u.pathname, body });
    if (fail) { const f = fail(u.pathname, body); if (f) return f; }
    let res;
    if (u.pathname === "/info") {
      res = {
        meta: fx.meta, spotMeta: fx.spot_meta, allMids: mids,
        clearinghouseState: { marginSummary: { accountValue: "1000.0", totalNtlPos: "0.0", totalRawUsd: "1000.0", totalMarginUsed: "0.0" }, crossMarginSummary: {}, withdrawable: "1000.0", assetPositions: positions.map((p) => ({ type: "oneWay", position: p })) },
        spotClearinghouseState: { balances: [{ coin: "USDC", token: 0, hold: "0.0", total: "50.0" }, { coin: "PURR", token: 1, hold: "0.0", total: "0.0" }] },
        openOrders: [{ coin: "@107", limitPx: "40.0", oid: 77, side: "B", sz: "1.0", timestamp: 1761739200000 }],
        maxBuilderFee: approvedFee,
        userRole: { role: "agent", data: { user: ACCOUNT } },
      }[body.type];
    } else {
      const a = body.action;
      const user = a.type === "approveBuilderFee";
      const signer = recoverAddress(hs.digestFor(user ? "user" : "l1", a, { nonce: body.nonce, mainnet: !testnet }), { r: BigInt(body.signature.r), s: BigInt(body.signature.s), recovery: body.signature.v - 27 });
      if (signer !== (user ? fx.main_address : fx.agent_address)) res = { status: "err", response: "User or API Wallet does not exist." };
      else if (a.type === "order") {
        const o = a.orders[0];
        if (a.builder && approvedFee < a.builder.f) res = { status: "err", response: "Builder fee has not been approved." };
        else res = { status: "ok", response: { type: "order", data: { statuses: [o.t.limit.tif === "Ioc" ? { filled: { totalSz: o.s, avgPx: o.p, oid: 1001 } } : { resting: { oid: 1000 } }] } } };
      } else if (a.type === "cancel") res = { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
      else res = { status: "ok", response: { type: "default" } };
    }
    return { status: 200, text: async () => JSON.stringify(res) };
  };
  return { fetch, calls, exchange: () => calls.filter((c) => c.path === "/exchange"), infos: (type) => calls.filter((c) => c.path === "/info" && (!type || c.body.type === type)) };
}

/** GuardProxy + HlServer in-process, driven over MCP's newline-delimited JSON-RPC like a real client. */
async function startHl({ policy = {}, approvals = {}, builderAddress = BUILDER, env = {}, hl, testnet = false, defaults = false } = {}) {
  hl = hl || mockHl({ testnet });
  const home = mkdtempSync(join(tmpdir(), "tg-hl-"));
  const state = new State(home, "hl");
  const logs = [];
  const log = (s) => logs.push(s);
  const server = new HlServer({ account: ACCOUNT, apiKey: AGENT_KEY, testnet, fetch: hl.fetch, builderAddress, env, version: "test", log });
  const input = new PassThrough(), output = new PassThrough();
  const proxy = new GuardProxy({ profile: HL_PROFILE, policy: resolvePolicy(defaults ? policy : { live_requires_approval: false, max_orders_per_minute: 50, ...policy }), state, local: server, mode: testnet ? "testnet" : "live", approvals, input, output, log });
  const waiting = new Map();
  let id = 0, buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params, ms = 8000) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}\n${logs.join("\n")}`)), ms);
    waiting.set(myId, (m) => { clearTimeout(t); resolve(m); });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  const list = await rpc("tools/list", {});
  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const status = async () => JSON.parse((await call("tas_guard_status")).content[0].text);
  return { rpc, call, status, init, list, state, hl, logs, server, home, stop: () => proxy.close() };
}
const txt = (r) => r.content.map((c) => c.text).join("\n");
const sentOrders = (hl) => hl.exchange().filter((c) => c.body.action.type === "order").map((c) => c.body.action);
const BUY_BTC = { coin: "BTC", side: "buy", size: 0.002, type: "limit", price: 60000 }; // 120 USDC

// ---------- MCP flow ----------
test("handshake and tool list: hl_ tools tagged with the limits, leverage hidden (blocked by default), status shows the venue", async () => {
  const g = await startHl();
  try {
    assert.match(g.init.result.instructions, /Hyperliquid mainnet \(real money\)[\s\S]*TAS Guard \(live mode\)/);
    const names = g.list.result.tools.map((t) => t.name);
    for (const n of ["hl_get_account", "hl_get_mids", "hl_get_open_orders", "hl_place_order", "hl_cancel_order", "hl_close_position", "tas_guard_status"]) assert.ok(names.includes(n), n);
    assert.ok(!names.includes("hl_update_leverage"), "leverage is blocked and hidden by default");
    const place = g.list.result.tools.find((t) => t.name === "hl_place_order");
    assert.match(place.description, /^\[TAS Guard: max 500 USDC per order, 2000 USDC per day/);
    assert.match(place.description, /0\.02% builder fee paid to TradingAgentStack/);
    const s = await g.status();
    assert.equal(s.venue.network, "mainnet");
    assert.equal(s.venue.account, ACCOUNT);
    assert.equal(s.venue.api_wallet, fx.agent_address);
    assert.equal(s.venue.builder_fee.rate, "0.02%");
    assert.equal(s.mode, "live");
  } finally { g.stop(); }
});

test("reads: account, mids (spot shown by pair name) and open orders pass through", async () => {
  const g = await startHl();
  try {
    const acct = JSON.parse(txt(await g.call("hl_get_account")));
    assert.equal(acct.perps.withdrawable, "1000.0");
    assert.deepEqual(acct.spot_balances.map((b) => b.coin), ["USDC"], "zero balances dropped");
    assert.deepEqual(JSON.parse(txt(await g.call("hl_get_mids", { coins: ["btc", "HYPE/USDC"] }))), { BTC: "60000", "HYPE/USDC": "41.2" });
    assert.equal(JSON.parse(txt(await g.call("hl_get_mids")))["HYPE/USDC"], "41.2");
    const oo = JSON.parse(txt(await g.call("hl_get_open_orders")));
    assert.deepEqual(oo[0], { coin: "HYPE/USDC", side: "buy", size: "1.0", limit_price: "40.0", oid: 77, time: "2025-10-29T12:00:00.000Z" });
    assert.equal(g.hl.exchange().length, 0);
  } finally { g.stop(); }
});

test("an order within limits is signed by the API wallet, carries the builder code, counts toward today, and is audited without keys", async () => {
  const g = await startHl();
  try {
    const r = await g.call("hl_place_order", BUY_BTC);
    assert.ok(!r.isError, txt(r));
    const out = JSON.parse(txt(r));
    assert.equal(out.status, "resting"); assert.equal(out.oid, 1000); assert.equal(out.notional_usdc, 120); assert.equal(out.builder_fee, "0.02%");
    const [a] = sentOrders(g.hl);
    assert.deepEqual(a, { type: "order", orders: [{ a: 0, b: true, p: "60000", s: "0.002", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na", builder: { b: BUILDER.toLowerCase(), f: 20 } });
    const s = await g.status();
    assert.equal(s.today.value_used, 120); assert.equal(s.today.orders, 1);
    const audit = readFileSync(join(g.home, "audit.jsonl"), "utf8");
    const line = audit.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.outcome === "executed");
    assert.equal(line.tool, "hl_place_order"); assert.equal(line.order.price, "60000"); assert.equal(line.order.builder_fee, "0.02%");
    assert.match(line.summary, /BUY 0\.002 BTC limit 60000 Gtc, ≈ 120 USDC, \+ 0\.02% builder fee \[Hyperliquid mainnet\]/);
    assert.ok(!audit.includes(AGENT_KEY.slice(2)) && !audit.includes(fx.main_key.slice(2)), "no private key in the audit log");
    assert.ok(!g.logs.join("\n").includes(AGENT_KEY.slice(2)), "no private key in the logs");
    assert.equal(g.state.verifyAudit().ok, true);
  } finally { g.stop(); }
});

test("caps: per-order and daily limits block before anything is signed or sent", async () => {
  const g = await startHl({ policy: { max_order_value: 500, max_daily_value: 300, approve_over: 1000 } });
  try {
    const big = await g.call("hl_place_order", { ...BUY_BTC, size: 0.01 }); // 600
    assert.ok(big.isError); assert.match(txt(big), /over the per-order limit of 500/);
    assert.ok(!(await g.call("hl_place_order", BUY_BTC)).isError); // 120
    assert.ok(!(await g.call("hl_place_order", BUY_BTC)).isError); // 240
    const over = await g.call("hl_place_order", BUY_BTC); // 360 > 300
    assert.match(txt(over), /over the daily limit of 300/);
    assert.equal(sentOrders(g.hl).length, 2);
  } finally { g.stop(); }
});

test("market orders: valued at mid + slippage (buys) and sent as IOC at the SDK's slippage price", async () => {
  const g = await startHl({ policy: { max_order_value: 252, approve_over: 1000 } });
  try {
    const over = await g.call("hl_place_order", { coin: "ETH", side: "buy", size: 0.1, type: "market", max_slippage_pct: 1 }); // 2500 * 1.01 * 0.1 = 252.5
    assert.match(txt(over), /252\.5 is over the per-order limit of 252/);
    const ok = await g.call("hl_place_order", { coin: "ETH", side: "buy", size: 0.1, type: "market", max_slippage_pct: 0.5 }); // 251.25
    assert.ok(!ok.isError, txt(ok));
    assert.equal(JSON.parse(txt(ok)).status, "filled");
    assert.deepEqual(sentOrders(g.hl)[0].orders[0], { a: 1, b: true, p: "2512.5", s: "0.1", r: false, t: { limit: { tif: "Ioc" } } });
    assert.match(txt(await g.call("hl_place_order", { coin: "ETH", side: "buy", size: 0.1, type: "market", max_slippage_pct: 50 })), /at most 10/);
    assert.match(txt(await g.call("hl_place_order", { coin: "ETH", side: "buy", size: 0.1, type: "market", price: 2500 })), /don't take a price/);
  } finally { g.stop(); }
});

test("a sell limit far below the market is valued at the mid, so it can't slip past the caps", async () => {
  const g = await startHl({ policy: { max_order_value: 500 } });
  try {
    const r = await g.call("hl_place_order", { coin: "BTC", side: "sell", size: 0.01, type: "limit", price: 1 }); // fills near 60000: 600
    assert.ok(r.isError); assert.match(txt(r), /Order value 600 is over the per-order limit/);
    assert.equal(sentOrders(g.hl).length, 0);
  } finally { g.stop(); }
  const n = await startHl({ hl: mockHl({ mids: { ETH: "2500" } }) }); // no BTC mid: the sell can't be valued
  try {
    const r = await n.call("hl_place_order", { coin: "BTC", side: "sell", size: 0.01, type: "limit", price: 1 });
    assert.match(txt(r), /holding this action[\s\S]*value can't be computed/, "unknown value asks a human, not size x limit price");
    assert.equal(sentOrders(n.hl).length, 0);
  } finally { n.stop(); }
});

test("allow list: checked on the canonical market name, so aliases and casing can't get around it", async () => {
  const g = await startHl({ policy: { symbols_allow: ["BTC", "HYPE/USDC"] } });
  try {
    assert.match(txt(await g.call("hl_place_order", { coin: "ETH", side: "buy", size: 0.01, type: "limit", price: 2500 })), /ETH is not on the allow list/);
    assert.ok(!(await g.call("hl_place_order", { ...BUY_BTC, coin: "btc" })).isError, "btc resolves to BTC");
    assert.ok(!(await g.call("hl_place_order", { coin: "@107", side: "buy", size: 1, type: "limit", price: 40 })).isError, "@107 is HYPE/USDC");
    assert.equal(sentOrders(g.hl)[1].orders[0].a, 10107, "spot asset = 10000 + universe index");
    assert.match(txt(await g.call("hl_place_order", { coin: "DOGE", side: "buy", size: 1, type: "limit", price: 1 })), /Unknown coin 'DOGE'/);
  } finally { g.stop(); }
  const b = await startHl({ policy: { symbols_block: ["HYPE/USDC"] } });
  try {
    assert.match(txt(await b.call("hl_place_order", { coin: "@107", side: "buy", size: 1, type: "limit", price: 40 })), /HYPE\/USDC is on the block list/);
    assert.equal(sentOrders(b.hl).length, 0);
  } finally { b.stop(); }
});

test("mainnet with default policy: every order needs a human (live money); testnet doesn't", async () => {
  const g = await startHl({ defaults: true });
  try {
    const r = await g.call("hl_place_order", BUY_BTC);
    assert.match(txt(r), /holding this action[\s\S]*Live-money orders need human approval/);
    assert.equal(sentOrders(g.hl).length, 0);
  } finally { g.stop(); }
  const t = await startHl({ defaults: true, testnet: true });
  try {
    assert.match(t.init.result.instructions, /testnet \(test funds\)/);
    const r = await t.call("hl_place_order", BUY_BTC);
    assert.ok(!r.isError, txt(r));
    assert.equal(sentOrders(t.hl).length, 1);
  } finally { t.stop(); }
});

test("approval: held over approve_over, sent to the phone, approved with a tap, then sent once", async () => {
  const tg = await startMockTelegram();
  const g = await startHl({ policy: { approve_over: 100 }, approvals: { telegram: { bot_token: tg.token, chat_id: String(OWNER), api_base: tg.base, wait_seconds: 5 } } });
  try {
    const pending = g.call("hl_place_order", BUY_BTC); // 120 > 100
    const id = await tg.waitFor((s) => { const m = s.sent.find((x) => x.reply_markup); return m && m.reply_markup.inline_keyboard[0][0].callback_data.split("|")[1]; });
    const msg = tg.s.sent.find((x) => x.reply_markup);
    assert.match(msg.text, /BUY 0\.002 BTC limit 60000 Gtc, ≈ 120 USDC, \+ 0\.02% builder fee \[Hyperliquid mainnet\]/);
    assert.match(msg.text, /over the approval threshold of 100/);
    assert.equal(sentOrders(g.hl).length, 0, "nothing sent while waiting");
    tg.tap(id, true, OWNER);
    const r = await pending;
    assert.ok(!r.isError, txt(r));
    assert.equal(sentOrders(g.hl).length, 1);
    assert.equal(g.state.pending().items.find((i) => i.id === id).status, "used");
  } finally { g.stop(); await tg.close(); }
});

test("approval: a denial on the phone sends nothing; a CLI approval lets the repeated call through once", async () => {
  const tg = await startMockTelegram();
  const g = await startHl({ policy: { approve_over: 100 }, approvals: { telegram: { bot_token: tg.token, chat_id: String(OWNER), api_base: tg.base, wait_seconds: 1 } } });
  try {
    const pending = g.call("hl_place_order", BUY_BTC);
    const askedId = () => { const m = tg.s.sent.filter((x) => x.reply_markup).at(-1); return m && m.reply_markup.inline_keyboard[0][0].callback_data.split("|")[1]; };
    tg.tap(await tg.waitFor(askedId), false, OWNER);
    assert.match(txt(await pending), /denied this action on their phone/);
    const args = { ...BUY_BTC, size: 0.0021 };
    const held = await g.call("hl_place_order", args); // no answer within wait_seconds
    assert.match(txt(held), /still waiting/);
    const id = txt(held).match(/request ([0-9a-f]{6})/)[1];
    g.state.decideApproval(id, true, "cli");
    assert.ok(!(await g.call("hl_place_order", args)).isError);
    assert.ok((await g.call("hl_place_order", args)).isError, "single use");
    assert.equal(sentOrders(g.hl).length, 1);
  } finally { g.stop(); await tg.close(); }
});

test("kill switch: orders blocked without touching the network; cancel and close still work (close carries the builder code)", async () => {
  const hl = mockHl({ positions: [{ coin: "ETH", szi: "-0.5", entryPx: "2600", leverage: { type: "cross", value: 5 } }] });
  const g = await startHl({ hl });
  try {
    g.state.kill("test");
    const before = hl.calls.length;
    const r = await g.call("hl_place_order", BUY_BTC);
    assert.match(txt(r), /Kill switch is on/);
    assert.equal(hl.calls.length, before, "no pricing or signing for a blocked order");
    assert.ok(!(await g.call("hl_cancel_order", { coin: "BTC", oid: 1000 })).isError);
    const c = await g.call("hl_close_position", { coin: "ETH" });
    assert.ok(!c.isError, txt(c));
    assert.match(JSON.parse(txt(c)).closed, /0\.5 of 0\.5 ETH \(short\)/);
    const [close] = sentOrders(hl);
    assert.deepEqual(close.orders[0], { a: 1, b: true, p: "2525", s: "0.5", r: true, t: { limit: { tif: "Ioc" } } }, "buy back the short, reduce-only, at mid + 1%");
    assert.deepEqual(close.builder, { b: BUILDER.toLowerCase(), f: 20 });
    g.state.resume();
    assert.ok(!(await g.call("hl_place_order", BUY_BTC)).isError);
  } finally { g.stop(); }
});

test("builder field: present by default, absent with TAS_GUARD_HL_BUILDER_FEE=0, absent (one startup warning) when the address constant is null", async () => {
  const on = await startHl();
  const off = await startHl({ env: { TAS_GUARD_HL_BUILDER_FEE: "0" } });
  const none = await startHl({ builderAddress: null });
  try {
    for (const g of [on, off, none]) assert.ok(!(await g.call("hl_place_order", BUY_BTC)).isError);
    assert.deepEqual(sentOrders(on.hl)[0].builder, { b: BUILDER.toLowerCase(), f: 20 });
    assert.equal("builder" in sentOrders(off.hl)[0], false);
    assert.equal("builder" in sentOrders(none.hl)[0], false);
    assert.equal((await off.status()).venue.builder_fee, "off (TAS_GUARD_HL_BUILDER_FEE=0)");
    assert.doesNotMatch(off.list.result.tools.find((t) => t.name === "hl_place_order").description, /builder fee/);
    await none.server.startup();
    assert.equal(none.logs.filter((l) => /warning/.test(l)).length, 1);
    assert.match(none.logs.find((l) => /warning/.test(l)), /no builder address is set/);
    await off.server.startup();
    assert.ok(off.logs.some((l) => /builder fee off \(TAS_GUARD_HL_BUILDER_FEE=0\)/.test(l)));
  } finally { on.stop(); off.stop(); none.stop(); }
  assert.ok(feeOptedOut({ TAS_GUARD_HL_BUILDER_FEE: "0" }) && feeOptedOut({ TAS_GUARD_HL_BUILDER_FEE: "off" }) && !feeOptedOut({}) && !feeOptedOut({ TAS_GUARD_HL_BUILDER_FEE: "1" }));
});

test("the shipped constants: fee is 20 tenths of a bp (0.02%); orders carry a builder field only once the address is set", async () => {
  assert.equal(BUILDER_FEE, 20);
  assert.equal(feePercent(), "0.02%");
  assert.ok(BUILDER_ADDRESS === null || /^0x[0-9a-fA-F]{40}$/.test(BUILDER_ADDRESS), "null or a 0x address");
  const hl = mockHl();
  const server = new HlServer({ account: ACCOUNT, apiKey: AGENT_KEY, fetch: hl.fetch, env: {} }); // default builder = the constant
  assert.ok(!(await server.callTool("hl_place_order", BUY_BTC)).isError);
  const [a] = sentOrders(hl);
  if (BUILDER_ADDRESS === null) assert.equal("builder" in a, false);
  else assert.deepEqual(a.builder, { b: BUILDER_ADDRESS.toLowerCase(), f: 20 });
});

test("fee not approved: a clear error naming approve-fee and the opt-out; nothing counted; startup warns", async () => {
  const g = await startHl({ hl: mockHl({ approvedFee: 0 }) });
  try {
    const r = await g.call("hl_place_order", BUY_BTC);
    assert.ok(r.isError);
    assert.match(txt(r), /builder fee isn't approved for account/);
    assert.match(txt(r), /npx tas-guard hl approve-fee/);
    assert.match(txt(r), /TAS_GUARD_HL_BUILDER_FEE=0/);
    assert.match(txt(r), /Builder fee has not been approved/);
    assert.equal((await g.status()).today.orders, 0);
    await g.server.startup();
    assert.ok(g.logs.some((l) => /isn't approved for this account yet[\s\S]*approve-fee/.test(l)));
  } finally { g.stop(); }
});

test("other rejections and network failures are reported, and nothing is counted", async () => {
  const hl = mockHl({ fail: (path, body) => (path === "/exchange" && body.action.orders?.[0]?.s === "0.0001" ? { status: 200, text: async () => JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $10." }] } } }) } : path === "/exchange" && body.action.orders?.[0]?.s === "0.0002" ? Promise.reject(new Error("socket hang up")) : null) });
  const g = await startHl({ hl });
  try {
    assert.match(txt(await g.call("hl_place_order", { ...BUY_BTC, size: 0.0001 })), /Hyperliquid rejected this: Order must have minimum value of \$10/);
    const net = await g.call("hl_place_order", { ...BUY_BTC, size: 0.0002 });
    assert.match(txt(net), /couldn't reach Hyperliquid \(socket hang up\)[\s\S]*may or may not have reached Hyperliquid/);
    assert.equal((await g.status()).today.orders, 0);
    assert.match(txt(await g.call("hl_place_order", { ...BUY_BTC, size: 0.000001 })), /rounds to 0/);
    assert.match(txt(await g.call("hl_place_order", { coin: "BTC", side: "hold", size: 1, type: "limit", price: 1 })), /side must be/);
    assert.match(txt(await g.call("hl_place_order", { coin: "BTC", side: "buy", size: 1, type: "limit" })), /need a price/);
  } finally { g.stop(); }
});

test("leverage: blocked by default; when the policy allows it, the action is signed and sent", async () => {
  const g = await startHl();
  try {
    assert.match(txt(await g.call("hl_update_leverage", { coin: "ETH", leverage: 5 })), /'leverage' tools are blocked by policy/);
    assert.equal(g.hl.exchange().length, 0);
  } finally { g.stop(); }
  const a = await startHl({ policy: { classes: { leverage: "allow" } } });
  try {
    assert.ok(a.list.result.tools.some((t) => t.name === "hl_update_leverage"));
    assert.ok(!(await a.call("hl_update_leverage", { coin: "ETH", leverage: 5, is_cross: false })).isError);
    assert.deepEqual(a.hl.exchange()[0].body.action, { type: "updateLeverage", asset: 1, isCross: false, leverage: 5 });
    assert.match(txt(await a.call("hl_update_leverage", { coin: "ETH", leverage: 50 })), /at most 25x/);
  } finally { a.stop(); }
});

test("keys: a main-wallet key is refused as HL_API_PRIVATE_KEY; bad keys and accounts are refused", () => {
  assert.throws(() => new HlServer({ account: fx.agent_address, apiKey: AGENT_KEY }), /private key of your main wallet[\s\S]*API wallet/);
  assert.throws(() => new HlServer({ account: "0x123", apiKey: AGENT_KEY }), /HL_ACCOUNT/);
  assert.throws(() => new HlServer({ account: ACCOUNT, apiKey: "nope" }), /HL_API_PRIVATE_KEY: expected a 32-byte hex private key/);
  const s = new HlServer({ account: ACCOUNT, apiKey: AGENT_KEY });
  assert.ok(!JSON.stringify(s).includes(AGENT_KEY.slice(2)) && !JSON.stringify(s.status()).includes(AGENT_KEY.slice(2)));
});

test("startup: an API key that belongs to another account (or isn't an API wallet) is refused for every action", async () => {
  for (const [role, re] of [[{ role: "agent", data: { user: "0x1111111111111111111111111111111111111111" } }, /API wallet of account 0x1111/], [{ role: "user" }, /regular Hyperliquid account/]]) {
    const hl = mockHl({ fail: (path, body) => (body.type === "userRole" ? { status: 200, text: async () => JSON.stringify(role) } : null) });
    const g = await startHl({ hl });
    try {
      await g.server.startup();
      assert.ok(g.logs.some((l) => /^error: /.test(l) && re.test(l)));
      const r = await g.call("hl_place_order", BUY_BTC);
      assert.ok(r.isError); assert.match(txt(r), re);
      assert.equal(hl.exchange().length, 0);
      assert.equal((await g.status()).today.orders, 0);
    } finally { g.stop(); }
  }
});

test("approve-fee: signs with the main key, prints what it approves, refuses a key for another account or a missing builder", async () => {
  const hl = mockHl();
  const lines = [];
  const r = await approveFee({ yes: true, env: { HL_MAIN_PRIVATE_KEY: fx.main_key, HL_ACCOUNT: ACCOUNT }, fetch: hl.fetch, builderAddress: BUILDER, out: (s) => lines.push(s) });
  assert.equal(r.approved, true);
  const printed = lines.join("\n");
  assert.match(printed, new RegExp(`account: +${ACCOUNT}`));
  assert.match(printed, new RegExp(`builder: +${BUILDER.toLowerCase()} \\(TradingAgentStack\\)`));
  assert.match(printed, /max fee rate: 0\.02%/);
  assert.ok(!printed.includes(fx.main_key.slice(2)));
  const [sent] = hl.exchange();
  assert.equal(sent.body.action.type, "approveBuilderFee");
  assert.equal(sent.body.action.maxFeeRate, "0.02%");
  assert.equal(sent.body.action.hyperliquidChain, "Mainnet");
  const declined = await approveFee({ env: { HL_MAIN_PRIVATE_KEY: fx.main_key }, fetch: hl.fetch, builderAddress: BUILDER, out: () => {}, confirm: async () => false });
  assert.equal(declined.approved, false);
  assert.equal(hl.exchange().length, 1, "declining signs nothing");
  await assert.rejects(approveFee({ yes: true, env: { HL_MAIN_PRIVATE_KEY: AGENT_KEY, HL_ACCOUNT: ACCOUNT }, fetch: hl.fetch, builderAddress: BUILDER, out: () => {} }), /belongs to/);
  await assert.rejects(approveFee({ yes: true, env: { HL_MAIN_PRIVATE_KEY: fx.main_key }, fetch: hl.fetch, builderAddress: null, out: () => {} }), /no builder address/);
  await assert.rejects(approveFee({ yes: true, env: {}, fetch: hl.fetch, builderAddress: BUILDER, out: () => {} }), /HL_MAIN_PRIVATE_KEY/);
});

test("CLI: hl needs its environment, rejects unknown config keys, init prints a starter config", () => {
  const home = mkdtempSync(join(tmpdir(), "tg-hlcli-"));
  const run = (args, env = {}) => {
    try { execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, TAS_GUARD_HOME: home, HL_ACCOUNT: "", HL_API_PRIVATE_KEY: "", ...env }, encoding: "utf8", stdio: "pipe" }); return ""; }
    catch (e) { return String(e.stderr); }
  };
  assert.match(run(["hl"]), /Set HL_ACCOUNT/);
  assert.match(run(["hl"], { HL_ACCOUNT: ACCOUNT }), /Set HL_API_PRIVATE_KEY[\s\S]*can't withdraw/);
  assert.match(run(["hl"], { HL_ACCOUNT: fx.agent_address, HL_API_PRIVATE_KEY: AGENT_KEY }), /main wallet/);
  const cfg = join(home, "hl.json");
  writeFileSync(cfg, JSON.stringify({ policy: {}, api_private_key: "x" }));
  assert.match(run(["hl", "--config", cfg]), /unknown setting\(s\) api_private_key[\s\S]*Keys never go in this file/);
  assert.match(run(["hl", "approve-fee", "--yes"]), BUILDER_ADDRESS === null ? /no builder address set/ : /HL_MAIN_PRIVATE_KEY/);
  const init = JSON.parse(execFileSync(process.execPath, [CLI, "init", "hyperliquid"], { encoding: "utf8" }));
  assert.equal(init.name, "hyperliquid");
  assert.deepEqual(init.policy.symbols_allow, ["BTC", "ETH", "SOL"]);
  assert.match(execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }), /^0\.5\.0/);
  assert.ok(!existsSync(join(home, "audit.jsonl")), "nothing ran");
});
