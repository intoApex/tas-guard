// Onchain mode end to end: HTTP JSON-RPC client -> RpcGuard -> mock EVM node, with the CLI and a mock Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcGuard } from "../src/rpc.js";
import { resolveOnchainPolicy } from "../src/onchain-policy.js";
import { State } from "../src/state.js";
import { startMockEvm, DEMO_REVERT_CONTRACT } from "../src/demo-evm.js";
import { startMockTelegram } from "./mock-telegram.js";
import { rawTx, calldata, MAX, USDC, permit2Single, erc2612 } from "./evm-helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.js");
const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FRIEND = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x4444444444444444444444444444444444444444";
const OWNER = 4242;
const BASE = {
  chains_allow: [8453], native_usd: { 8453: 3000 },
  tokens: { [USDC]: { symbol: "USDC", decimals: 6, usd_price: "stable" } },
  max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 25, max_tx_per_minute: 20,
  recipients_allow: [FRIEND], contracts_allow: [ROUTER, DEMO_REVERT_CONTRACT],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup({ policy = {}, approvals = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tg-rpc-"));
  const chain = await startMockEvm({ chainId: 8453, nonces: { [WALLET]: 7 }, rawSender: WALLET });
  const state = new State(home, "evm");
  const logs = [];
  const guard = new RpcGuard({ upstream: chain.url + "/v2/SECRET-KEY-123", wallets: [WALLET], policy: resolveOnchainPolicy({ ...BASE, ...policy }), state, approvals, log: (s) => logs.push(s) });
  const url = await guard.listen("127.0.0.1", 0);
  const post = async (body, { headers = {}, signal } = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const call = async (method, params, opts) => (await post({ jsonrpc: "2.0", id: 1, method, params }, opts)).body;
  const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { env: { ...process.env, TAS_GUARD_HOME: home }, encoding: "utf8" });
  const pendingId = async () => { for (let i = 0; i < 100; i++) { const it = state.pending().items.find((x) => x.status === "pending"); if (it) return it.id; await sleep(30); } throw new Error("nothing was held"); };
  const sent = () => chain.s.calls.filter((c) => /^(eth_send|eth_sign|personal_sign)/.test(c.method));
  return { chain, guard, state, url, post, call, cli, logs, home, pendingId, sent, stop: async () => { await guard.close(); await chain.close(); } };
}
const usdc = (to, n) => [{ from: WALLET, to: USDC, data: calldata.transfer(to, Math.round(n * 1e6)) }];

test("reads pass through untouched (single and batch); browser requests refused; tas_guardStatus", async () => {
  const g = await setup();
  try {
    assert.equal((await g.call("eth_blockNumber", [])).result, "0x1234567");
    await g.call("eth_getBalance", [WALLET, "latest"]);
    assert.deepEqual(g.chain.s.calls.at(-1), { method: "eth_getBalance", params: [WALLET, "latest"] });
    const batch = await g.post([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 2, method: "net_version", params: [] }]);
    assert.deepEqual(batch.body.map((x) => x.result), ["0x2105", "8453"]);
    assert.equal((await g.call("debug_unknown", [])).error.code, -32601, "upstream errors pass through");
    assert.equal((await g.post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }, { headers: { origin: "https://evil.example" } })).status, 403);
    const st = (await g.call("tas_guardStatus", [])).result;
    assert.deepEqual([st.chain, st.limits.max_tx_usd, st.today.usd_used], ["Base (8453)", 100, 0]);
    assert.ok(!g.logs.join("\n").includes("SECRET-KEY-123"), "upstream key never logged");
  } finally { await g.stop(); }
});

test("raw transactions: allowed transfer is forwarded and counted; foreign nonce, wrong chain and unlimited approval are blocked", async () => {
  const g = await setup();
  try {
    const ok = await g.call("eth_sendRawTransaction", [rawTx({ nonce: 7, to: USDC, data: calldata.transfer(FRIEND, 20e6) })]);
    assert.match(ok.result, /^0x[0-9a-f]{64}$/, JSON.stringify(ok));
    assert.deepEqual([g.state.usage().spent, g.state.usage().orders], [20, 1]);
    const foreign = await g.call("eth_sendRawTransaction", [rawTx({ nonce: 3, to: FRIEND, value: 1n })]);
    assert.match(foreign.error.message, /Sender check: its nonce 3 doesn't match any configured wallet/);
    const chain1 = await g.call("eth_sendRawTransaction", [rawTx({ nonce: 8, chainId: 1, to: FRIEND, value: 1n })]);
    assert.match(chain1.error.message, /chain 1, but the upstream RPC is chain 8453/);
    const unl = await g.call("eth_sendRawTransaction", [rawTx({ nonce: 8, to: USDC, data: calldata.approve(ROUTER, MAX) })]);
    assert.equal(unl.error.code, -32003);
    assert.match(unl.error.message, /Unlimited allowance/);
    const junk = await g.call("eth_sendRawTransaction", ["0x04f800"]);
    assert.match(junk.error.message, /EIP-7702/);
    const mixed = await g.post([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [rawTx({ type: 0, nonce: 8, to: FRIEND, value: 10n ** 15n })] }]);
    assert.deepEqual([mixed.body[0].result, typeof mixed.body[1].result], ["0x1234567", "string"], "legacy tx in a batch next to a read");
    assert.equal(g.sent().length, 2, "only the two allowed sends reached the node");
    assert.match(g.cli("log"), /executed\s+eth_sendRawTransaction \(erc20_transfer\)[\s\S]*blocked\s+eth_sendRawTransaction \(approval\)/);
    assert.match(g.cli("verify-log"), /hash chain intact/);
  } finally { await g.stop(); }
});

test("pre-flight revert check: a reverting transaction is blocked with the reason and never sent", async () => {
  const g = await setup();
  try {
    const r = await g.call("eth_sendTransaction", [{ from: WALLET, to: DEMO_REVERT_CONTRACT, data: "0xd0e30db0" }]);
    assert.match(r.error.message, /Pre-flight revert check: eth_call failed: Vault: deposits are paused/);
    assert.ok(g.chain.s.calls.some((c) => c.method === "eth_call" && c.params[0].from === WALLET));
    assert.equal(g.sent().length, 0);
    assert.equal(g.state.usage().orders, 0);
  } finally { await g.stop(); }
});

test("USD caps and daily totals across sends; sender must be a configured wallet", async () => {
  const g = await setup({ policy: { max_daily_usd: 50, approve_over_usd: 1000 } });
  try {
    assert.ok((await g.call("eth_sendTransaction", usdc(FRIEND, 20))).result);
    assert.ok((await g.call("eth_sendTransaction", usdc(FRIEND, 20))).result);
    assert.match((await g.call("eth_sendTransaction", usdc(FRIEND, 20))).error.message, /over the daily limit of \$50\.00/);
    assert.match((await g.call("eth_sendTransaction", usdc(FRIEND, 150))).error.message, /per-transaction limit/);
    assert.match((await g.call("eth_sendTransaction", [{ from: STRANGER, to: FRIEND, value: "0x1" }])).error.message, /not one of the configured wallets/);
    assert.equal((await g.call("tas_guardStatus", [])).result.today.usd_used, 40);
    assert.equal(g.sent().length, 2);
  } finally { await g.stop(); }
});

test("kill switch: every send and signature is blocked, reads still pass", async () => {
  const g = await setup();
  try {
    g.cli("kill", "test");
    assert.match((await g.call("eth_sendTransaction", usdc(FRIEND, 1))).error.message, /Kill switch/);
    assert.match((await g.call("personal_sign", ["0x68656c6c6f", WALLET])).error.message, /Kill switch/);
    assert.equal((await g.call("eth_blockNumber", [])).result, "0x1234567");
    g.cli("resume");
    assert.ok((await g.call("eth_sendTransaction", usdc(FRIEND, 1))).result);
    assert.equal(g.sent().length, 1);
  } finally { await g.stop(); }
});

test("approval: the request is held, approved from the terminal, then forwarded in the same request", async () => {
  const g = await setup();
  try {
    const pending = g.call("eth_sendTransaction", usdc(STRANGER, 30));
    const id = await g.pendingId();
    assert.equal(g.sent().length, 0, "nothing sent while held");
    assert.match(g.cli("pending"), /Base \(8453\): send 30 USDC to 0x2222.*\[\$30\.00\][\s\S]*not on recipients_allow/);
    g.cli("approve", id);
    const r = await pending;
    assert.match(r.result, /^0x/, JSON.stringify(r));
    assert.equal(g.sent().length, 1);
    assert.equal(g.state.usage().spent, 30);
    assert.match(g.cli("log"), /held\s+eth_sendTransaction[\s\S]*executed\s+eth_sendTransaction \(erc20_transfer\).*approved via CLI/);
  } finally { await g.stop(); }
});

test("approval via Telegram: the phone sees the decoded summary; approve forwards, deny returns a user-rejected error", async () => {
  const tg = await startMockTelegram();
  const g = await setup({ approvals: { telegram: { bot_token: tg.token, chat_id: String(OWNER), api_base: tg.base } } });
  const asked = (n) => (s) => { const m = s.sent.filter((x) => x.reply_markup)[n]; return m && m.reply_markup.inline_keyboard[0][0].callback_data.split("|")[1]; };
  try {
    const p1 = g.call("eth_sendTransaction", usdc(STRANGER, 30));
    const id1 = await tg.waitFor(asked(0));
    const msg = tg.s.sent.find((x) => x.reply_markup).text;
    assert.match(msg, /Base \(8453\)/); assert.match(msg, /30 USDC/); assert.match(msg, /\$30\.00/); assert.match(msg, /0x2222/); assert.match(msg, /approval threshold/);
    tg.tap(id1, true, OWNER);
    assert.match((await p1).result, /^0x/);
    const p2 = g.call("eth_sendTransaction", usdc(STRANGER, 31));
    tg.tap(await tg.waitFor(asked(1)), false, OWNER);
    const r2 = await p2;
    assert.equal(r2.error.code, 4001);
    assert.match(r2.error.message, /denied/);
    assert.equal(g.sent().length, 1);
  } finally { await g.stop(); await tg.close(); }
});

test("approval expiry and client hang-up: nothing is sent; the same request sent again after approval goes through once", async () => {
  const g = await setup({ policy: { approval_ttl_minutes: 0.01 } });
  try {
    const r = await g.call("eth_sendTransaction", usdc(STRANGER, 30));
    assert.match(r.error.message, /nobody approved request [0-9a-f]{6} within/);
    assert.equal(g.sent().length, 0);
  } finally { await g.stop(); }
  const h = await setup();
  try {
    const ac = new AbortController();
    const gone = h.call("eth_sendTransaction", usdc(STRANGER, 40), { signal: ac.signal }).catch((e) => e);
    const id = await h.pendingId();
    ac.abort();
    await gone;
    await sleep(400);
    h.cli("approve", id);
    await sleep(400);
    assert.equal(h.sent().length, 0, "the abandoned request was not forwarded");
    assert.match((await h.call("eth_sendTransaction", usdc(STRANGER, 40))).result, /^0x/, "retry uses the approval");
    assert.equal(h.sent().length, 1);
  } finally { await h.stop(); }
});

test("permit signatures: unlimited Permit2 blocked, a limited ERC-2612 permit is held like an approval", async () => {
  const g = await setup({ policy: { approval_ttl_minutes: 0.01 } });
  try {
    const unl = await g.call("eth_signTypedData_v4", [WALLET, JSON.stringify(permit2Single({ amount: (1n << 160n) - 1n, spender: ROUTER }))]);
    assert.match(unl.error.message, /Unlimited allowance/);
    const lim = await g.call("eth_signTypedData_v4", [WALLET, erc2612({ value: 5_000_000, spender: ROUTER, owner: WALLET })]);
    assert.match(lim.error.message, /nobody approved/);
    assert.match(g.cli("log"), /held\s+eth_signTypedData_v4 \(approval\)\s+ERC-2612 permit lets/);
    const mail = await g.call("eth_signTypedData_v4", [WALLET, { primaryType: "Mail", domain: { chainId: 8453 }, types: {}, message: {} }]);
    assert.match(mail.error.message, /nobody approved/, "other typed data needs approval too");
    assert.equal(g.sent().length, 0);
  } finally { await g.stop(); }
});

test("signing classes: personal_sign asks, eth_sign and unsupported signing methods are blocked", async () => {
  const g = await setup({ policy: { personal_sign: "allow" } });
  try {
    assert.equal((await g.call("personal_sign", ["0x68656c6c6f", WALLET])).result.length, 132);
    assert.match((await g.call("eth_sign", [WALLET, "0x" + "ab".repeat(32)])).error.message, /raw hash/);
    assert.match((await g.call("eth_signTransaction", [{ from: WALLET, to: FRIEND }])).error.message, /can't check it/);
    assert.match((await g.call("wallet_sendCalls", [{}])).error.message, /can't check it/);
    assert.match((await g.call("ETH_sendRawTransaction", ["0x00"])).error.message, /can't check it/, "odd casing is blocked, not passed through");
    const dup = await fetch(g.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":9,"method":"eth_sendRawTransaction","params":["0x00"],"method":"eth_blockNumber"}' });
    assert.equal((await dup.json()).result, "0x1234567");
    assert.ok(!g.chain.s.calls.some((c) => c.method === "eth_sendRawTransaction"), "the upstream sees the request the guard parsed");
    assert.match((await g.call("personal_sign", ["0x68656c6c6f", STRANGER])).error.message, /not one of the configured wallets/);
    assert.equal(g.sent().length, 1);
  } finally { await g.stop(); }
});

function startCli(args, env) {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("guard didn't start:\n" + err)), 5000);
    p.stderr.on("data", (d) => { err += d; const m = err.match(/listening on (http:\/\/[\d.:]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  return { p, ready, stderr: () => err };
}
const rpcPost = async (url, method, params) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();

test("tas-guard rpc --config: real process, ${VAR} upstream key never logged or audited", async () => {
  const chain = await startMockEvm({ chainId: 8453, nonces: { [WALLET]: 7 }, rawSender: WALLET });
  const home = mkdtempSync(join(tmpdir(), "tg-rpccli-"));
  const cfg = join(home, "guard.json");
  writeFileSync(cfg, JSON.stringify({ name: "base-agent", upstream_rpc: chain.url + "/v2/${TEST_RPC_KEY}", listen: "127.0.0.1:0", wallets: [WALLET], onchain: BASE }));
  const g = startCli(["rpc", "--config", cfg], { TAS_GUARD_HOME: home, TEST_RPC_KEY: "sk-live-abcdef123456" });
  try {
    const url = await g.ready;
    assert.ok((await rpcPost(url, "eth_sendTransaction", usdc(FRIEND, 10))).result);
    assert.match((await rpcPost(url, "eth_sendTransaction", usdc(FRIEND, 500))).error.message, /per-transaction limit/);
    assert.equal((await rpcPost(url, "eth_chainId", [])).result, "0x2105");
    await sleep(100);
    assert.ok(!g.stderr().includes("sk-live-abcdef123456"), "key not in the log");
    assert.ok(!readFileSync(join(home, "audit.jsonl"), "utf8").includes("sk-live"), "key not in the audit log");
    assert.match(g.stderr(), /upstream 127\.0\.0\.1:\d+ \(Base \(8453\)\)/);
  } finally { g.p.kill(); await chain.close(); }
});

test("tas-guard rpc-demo: built-in mock chain, allows, holds, blocks and passes reads", async () => {
  const home = mkdtempSync(join(tmpdir(), "tg-rpcdemo-"));
  const g = startCli(["rpc-demo", "--port", "0"], { TAS_GUARD_HOME: home });
  try {
    const url = await g.ready;
    const W = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    assert.ok((await rpcPost(url, "eth_sendTransaction", [{ from: W, to: FRIEND, value: "0x11c37937e08000" }])).result, "$15 to a known address");
    assert.match((await rpcPost(url, "eth_sendTransaction", [{ from: W, to: USDC, data: calldata.approve(ROUTER, MAX) }])).error.message, /Unlimited/);
    assert.match((await rpcPost(url, "eth_sendTransaction", [{ from: W, to: DEMO_REVERT_CONTRACT, data: "0xd0e30db0" }])).error.message, /paused/);
    assert.equal((await rpcPost(url, "eth_blockNumber", [])).result, "0x1234567");
    assert.match(g.stderr(), /Try these in another terminal/);
  } finally { g.p.kill(); }
});
