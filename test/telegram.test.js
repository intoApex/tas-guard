// Phone approvals end to end: fake MCP client -> tas-guard (real process) -> mock broker, with a mock Telegram API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockTelegram } from "./mock-telegram.js";
import { findChatId } from "../src/telegram.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.js");
const MOCK = join(ROOT, "test", "mock-broker.js");
const OWNER = 4242, STRANGER = 666;

async function startGuard({ tg, policy = {}, telegram = {}, approvals = {} }) {
  const home = mkdtempSync(join(tmpdir(), "tg-tel-"));
  const mockLog = join(home, "upstream.jsonl");
  const cfg = join(home, "guard.json");
  writeFileSync(cfg, JSON.stringify({
    name: "t", profile: "alpaca-mcp-server",
    upstream: { command: process.execPath, args: [MOCK], env: { ALPACA_PAPER_TRADE: "true" } },
    policy: { live_requires_approval: false, ...policy },
    approvals: { ...approvals, telegram: { bot_token: tg.token, chat_id: String(OWNER), api_base: tg.base, wait_seconds: 3, ...telegram } },
  }));
  const env = { ...process.env, TAS_GUARD_HOME: home, MOCK_LOG: mockLog };
  const p = spawn(process.execPath, [CLI, "run", "--config", cfg], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; p.stderr.on("data", (d) => (stderr += d));
  const waiting = new Map(); let id = 0, buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params, ms = 8000) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}\n${stderr}`)), ms);
    waiting.set(myId, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  await rpc("tools/list", {});
  return {
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
    cli: (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" }),
    upstream: () => (existsSync(mockLog) ? readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    stop: () => { p.stdin.end(); p.kill(); },
    home,
  };
}
const txt = (r) => r.content.map((c) => c.text).join("\n");
const ORDER = { symbol: "AAPL", side: "buy", qty: "2" }; // market by qty: needs approval
const askedId = (s) => { const m = s.sent.find((x) => x.reply_markup); return m && m.reply_markup.inline_keyboard[0][0].callback_data.split("|")[1]; };

test("approve on the phone: the same call goes through, and the message is updated", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg });
  try {
    const pending = g.call("place_stock_order", ORDER);
    const id = await tg.waitFor(askedId);
    const msg = tg.s.sent.find((x) => x.reply_markup);
    assert.equal(msg.chat_id, String(OWNER));
    assert.match(msg.text, /AAPL/);
    tg.tap(id, true, OWNER);
    const r = await pending;
    assert.ok(!r.isError, txt(r));
    assert.equal(g.upstream().length, 1);
    await tg.waitFor((s) => s.edits.some((e) => /Approved/.test(e.text)));
    assert.match(g.cli("log"), /executed\s+place_stock_order.*approved via Telegram/);
  } finally { g.stop(); await tg.close(); }
});

test("deny on the phone: nothing reaches the broker", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg });
  try {
    const pending = g.call("place_stock_order", ORDER);
    tg.tap(await tg.waitFor(askedId), false, OWNER);
    const r = await pending;
    assert.ok(r.isError); assert.match(txt(r), /denied this action on their phone/);
    assert.equal(g.upstream().length, 0);
  } finally { g.stop(); await tg.close(); }
});

test("taps from anyone else are ignored", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg });
  try {
    const pending = g.call("place_stock_order", ORDER);
    const id = await tg.waitFor(askedId);
    tg.tap(id, true, STRANGER);
    await tg.waitFor((s) => s.answers.some((a) => a.text === "Not authorized."));
    assert.equal(g.upstream().length, 0);
    tg.tap(id, true, OWNER);
    assert.ok(!(await pending).isError);
  } finally { g.stop(); await tg.close(); }
});

test("no answer in time: held, then a later tap lets the retried call through once", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg, telegram: { wait_seconds: 1 } });
  try {
    const r = await g.call("place_stock_order", ORDER);
    assert.ok(r.isError); assert.match(txt(r), /sent this action to the user's phone/);
    tg.tap(askedId(tg.s), true, OWNER);
    await tg.waitFor(() => /approved/.test(readFileSync(join(g.home, "pending.json"), "utf8")));
    assert.ok(!(await g.call("place_stock_order", ORDER)).isError);
    assert.equal(g.upstream().length, 1);
  } finally { g.stop(); await tg.close(); }
});

test("CLI approval works while the phone request is open", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg });
  try {
    const pending = g.call("place_stock_order", ORDER);
    const id = await tg.waitFor(askedId);
    g.cli("approve", id);
    assert.ok(!(await pending).isError);
  } finally { g.stop(); await tg.close(); }
});

test("phone kill switch, blocked-order alert, resume and status", async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg });
  try {
    tg.say("/kill", OWNER);
    await tg.waitFor((s) => s.sent.some((m) => /Kill switch ON/.test(m.text)));
    const r = await g.call("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" });
    assert.match(txt(r), /Kill switch/);
    await tg.waitFor((s) => s.sent.some((m) => /Blocked/.test(m.text) && /AAPL/.test(m.text)));
    tg.say("/kill", STRANGER); // ignored
    tg.say("/resume", OWNER);
    await tg.waitFor((s) => s.sent.some((m) => /Kill switch off/.test(m.text)));
    assert.ok(!(await g.call("place_stock_order", { symbol: "AAPL", side: "buy", notional: "10" })).isError);
    tg.say("/status", OWNER);
    await tg.waitFor((s) => s.sent.some((m) => /Today: 10 used/.test(m.text)));
    assert.match(g.cli("log"), /kill_on[\s\S]*kill_off/);
  } finally { g.stop(); await tg.close(); }
});

test("telegram-setup finds the chat id from the first private message", async () => {
  const tg = await startMockTelegram();
  try {
    setTimeout(() => tg.say("/start", OWNER), 100);
    const r = await findChatId(tg.token, tg.base, 5000);
    assert.equal(r.chat_id, String(OWNER));
    assert.equal(r.bot, "tas_test_bot");
    assert.ok(tg.s.sent.some((m) => /linked to this chat/.test(m.text)));
  } finally { await tg.close(); }
});

test("tas-guard telegram-setup writes the bot token and chat id into the guard config", async () => {
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_test";
  const tg = await startMockTelegram(token);
  const home = mkdtempSync(join(tmpdir(), "tg-setup-"));
  const cfg = join(home, "guard.json");
  writeFileSync(cfg, "﻿" + JSON.stringify({ name: "x", profile: "alpaca-mcp-server", upstream: { command: "x" }, policy: { max_order_value: 50 } }));
  try {
    setTimeout(() => tg.say("hello", OWNER), 300);
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [CLI, "telegram-setup", "--config", cfg, "--api-base", tg.base], { env: { ...process.env, TAS_GUARD_HOME: home, TAS_TELEGRAM_BOT_TOKEN: token } });
      let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
      p.on("exit", (c) => (c === 0 ? resolve(o) : reject(new Error(o))));
    });
    assert.match(out, /Linked @tas_test_bot/);
    const saved = JSON.parse(readFileSync(cfg, "utf8"));
    assert.deepEqual(saved.approvals.telegram, { bot_token: token, chat_id: String(OWNER) });
    assert.equal(saved.policy.max_order_value, 50, "rest of the config kept");
  } finally { await tg.close(); }
});

test('"cli": false: only the phone can approve', async () => {
  const tg = await startMockTelegram();
  const g = await startGuard({ tg, approvals: { cli: false } });
  try {
    const pending = g.call("place_stock_order", ORDER);
    const id = await tg.waitFor(askedId);
    assert.throws(() => g.cli("approve", id), /only be approved or denied from your phone/);
    tg.tap(id, true, OWNER);
    assert.ok(!(await pending).isError);
  } finally { g.stop(); await tg.close(); }
});

test("two guards on one bot: each command is handled once", async () => {
  const tg = await startMockTelegram();
  const a = await startGuard({ tg });
  // second guard sharing the same state dir and bot, like Claude Desktop's Chat + Cowork copies
  const home = a.home;
  const cfg = join(home, "guard.json");
  const p2 = spawn(process.execPath, [CLI, "run", "--config", cfg], { env: { ...process.env, TAS_GUARD_HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  p2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  try {
    await new Promise((r) => setTimeout(r, 800)); // let both start polling
    for (let i = 0; i < 3; i++) { tg.say("/status", OWNER); await new Promise((r) => setTimeout(r, 400)); }
    await tg.waitFor((s) => s.sent.filter((m) => /Kill switch/.test(m.text)).length >= 3);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(tg.s.sent.filter((m) => /Kill switch/.test(m.text)).length, 3);
  } finally { a.stop(); p2.stdin.end(); p2.kill(); await tg.close(); }
});
