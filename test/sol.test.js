// Solana mode: decoder unit tests, policy unit tests, and end to end: HTTP JSON-RPC client -> SolRpcGuard -> mock Solana chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/solana.js";
import { MockSolana, DEX, SHADY } from "../src/demo-sol.js";
import { SolRpcGuard } from "../src/sol-rpc.js";
import { resolveSolanaPolicy, decideSolana } from "../src/solana-policy.js";
import { State } from "../src/state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MEME = s.addr("meme-mint");
const W = s.keypair("agent-wallet");
const FRIEND = s.addr("friend"), ATTACKER = s.addr("attacker");
const A = { wUsdc: s.addr("w-usdc"), wMeme: s.addr("w-meme"), pool: s.addr("pool"), poolMeme: s.addr("pool-meme"), fUsdc: s.addr("f-usdc"), aUsdc: s.addr("a-usdc") };
const BASE = { sol_usd: 150, max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 50, max_tx_per_minute: 50, programs_allow: ["pumpfun"], recipients_allow: [FRIEND], program_caps: { pumpfun: { max_tx_usd: 30, max_daily_usd: 40 } } };

const dexBuy = (lamports, tokens) => {
  const d = Buffer.alloc(17); d[0] = 0; d.writeBigUInt64LE(BigInt(lamports), 1); d.writeBigUInt64LE(BigInt(tokens), 9);
  return { programId: DEX, keys: [{ pubkey: W.publicKey, isSigner: true, isWritable: true }, { pubkey: A.wMeme, isWritable: true }, { pubkey: A.pool, isWritable: true }, { pubkey: A.poolMeme, isWritable: true }], data: d };
};
const shady = () => ({ programId: SHADY, keys: [{ pubkey: A.wUsdc, isWritable: true }, { pubkey: ATTACKER }], data: Buffer.from([1]) });

async function setup({ policy = {}, cluster = "devnet" } = {}) {
  const chain = new MockSolana({ cluster });
  await chain.listen();
  chain.fund(W.publicKey, 5_000_000_000n);
  chain.createMint(USDC, 6); chain.createMint(MEME, 6);
  chain.tokenAccount(A.wUsdc, { mint: USDC, owner: W.publicKey, amount: 1000_000000n });
  chain.tokenAccount(A.fUsdc, { mint: USDC, owner: FRIEND });
  chain.tokenAccount(A.aUsdc, { mint: USDC, owner: ATTACKER });
  chain.fund(A.pool, 1_000_000_000n);
  chain.tokenAccount(A.poolMeme, { mint: MEME, owner: A.pool, amount: 10n ** 12n });
  const home = mkdtempSync(join(tmpdir(), "tg-sol-"));
  const state = new State(home, "sol");
  const logs = [];
  const guard = new SolRpcGuard({ upstream: chain.url + "/?api-key=SECRET-123", wallets: [W.publicKey], policy: resolveSolanaPolicy({ ...BASE, ...policy }), state, log: (x) => logs.push(x) });
  const url = await guard.listen("127.0.0.1", 0);
  const post = async (body, headers = {}) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const call = async (method, params) => (await post({ jsonrpc: "2.0", id: 1, method, params })).body;
  const build = (ixs, o = {}) => s.buildTransaction({ payer: W.publicKey, signers: [W], instructions: ixs, blockhash: chain.blockhash, ...o });
  const send = (ixs, o = {}) => { const raw = build(ixs, o); return o.base58 ? call("sendTransaction", [s.b58encode(raw)]) : call("sendTransaction", [raw.toString("base64"), { encoding: "base64" }]); };
  const pendingId = async () => { for (let i = 0; i < 200; i++) { const it = state.pending().items.find((x) => x.status === "pending"); if (it) return it.id; await sleep(25); } throw new Error("nothing was held"); };
  return { chain, guard, state, url, post, call, build, send, logs, pendingId, stop: async () => { await guard.close(); await chain.close(); } };
}

// ---------- decoder ----------
test("decoder: base58 round trips, presets and tip accounts are valid addresses", () => {
  for (const a of [...Object.values(s.PROGRAM_PRESETS).flat(), ...s.JITO_TIP_ACCOUNTS, ...Object.keys(s.STABLES), s.WSOL, s.SYSTEM, s.TOKEN_2022]) {
    assert.ok(s.isPubkey(a), a);
    assert.equal(s.b58encode(s.b58decode(a)), a);
  }
  assert.equal(s.b58encode(Buffer.alloc(32)), s.SYSTEM);
  assert.equal(s.b58encode(Buffer.from([0, 0, 1])), "112");
  assert.throws(() => s.b58decode("0OIl"), /bad character/);
  assert.ok(!s.isPubkey("0x1234"));
});

test("decoder: legacy and v0 transactions with lookup tables, fees, instruction fields", () => {
  const lt = { table: s.addr("lt"), addresses: [s.addr("x"), A.fUsdc, USDC] };
  const raw = s.buildTransaction({ version: 0, payer: W.publicKey, signers: [W], lookupTables: [lt], instructions: [s.ix.cuLimit(100_000), s.ix.cuPrice(50_000n), s.ix.tokenTransferChecked(A.wUsdc, USDC, A.fUsdc, W.publicKey, 5_000000n, 6)] });
  const tx = s.decodeTransaction(raw);
  assert.equal(tx.version, 0);
  assert.deepEqual(tx.lookups, [{ table: lt.table, writable: [1], readonly: [2] }]);
  assert.throws(() => s.accountList(tx, {}), /could not be read/);
  const al = s.accountList(tx, { [lt.table]: lt.addresses });
  const ixs = tx.instructions.map((i) => s.decodeInstruction(i, al.keys));
  const t = ixs[2];
  assert.equal(t.type, "transfer"); assert.equal(t.destination, A.fUsdc); assert.equal(t.mint, USDC); assert.equal(t.amount, 5_000000n); assert.equal(t.decimals, 6);
  assert.ok(al.writable[al.keys.indexOf(A.fUsdc)], "looked-up writable account is writable");
  assert.equal(s.computeFee(ixs, 1).lamports, 5000n + 5000n);
  assert.throws(() => s.decodeTransaction(Buffer.concat([raw, Buffer.from([0])])), /trailing/);
  assert.throws(() => s.decodeTransaction(raw.subarray(0, 80)), /truncated/);
  const legacy = s.decodeTransaction(s.buildTransaction({ payer: W.publicKey, signers: [W], instructions: [s.ix.transfer(W.publicKey, FRIEND, 1n), s.ix.setAuthority(A.wUsdc, W.publicKey, "accountOwner", ATTACKER), s.ix.assign(W.publicKey, SHADY)] }));
  const lal = s.accountList(legacy);
  const [tr, sa, as] = legacy.instructions.map((i) => s.decodeInstruction(i, lal.keys));
  assert.deepEqual([tr.type, tr.from, tr.to, tr.lamports], ["transfer", W.publicKey, FRIEND, 1n]);
  assert.deepEqual([sa.type, sa.authorityType, sa.newAuthority], ["setAuthority", "accountOwner", ATTACKER]);
  assert.deepEqual([as.type, as.account, as.owner], ["assign", W.publicKey, SHADY]);
});

test("policy: config is validated", () => {
  assert.throws(() => resolveSolanaPolicy({ max_tx_usd: -1 }), /non-negative/);
  assert.throws(() => resolveSolanaPolicy({ programs_allow: ["uniswap"] }), /preset/);
  assert.throws(() => resolveSolanaPolicy({ maxTxUsd: 5 }), /not a known setting/);
  assert.throws(() => resolveSolanaPolicy({ clusters_allow: ["mainnet-beta"] }), /must be one of/);
  assert.throws(() => resolveSolanaPolicy({ program_caps: { pumpfun: { max_usd: 5 } } }), /max_tx_usd/);
  const p = resolveSolanaPolicy({ programs_allow: ["jupiter", "pumpfun"] });
  assert.ok(p.programs.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"));
  assert.ok(p.recipients.has(s.JITO_TIP_ACCOUNTS[0]), "jito tips known by default");
  assert.equal(p.tokenInfo.EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.usd_price, 1);
});

test("policy: kill switch, wrong signer, cluster and block list", () => {
  const policy = resolveSolanaPolicy({ ...BASE, clusters_allow: ["mainnet"], addresses_block: [ATTACKER] });
  const op = { kind: "sol_tx", cluster: "devnet", signers: [W.publicKey], keys: [W.publicKey], instructions: [], fee: { lamports: 5000n }, sim: null };
  const wallets = new Set([W.publicKey]);
  assert.match(decideSolana({ op, policy, wallets, killed: true }).reason, /Kill switch/);
  assert.match(decideSolana({ op: { ...op, signers: [FRIEND] }, policy, wallets }).reason, /Not signed by a configured wallet/);
  assert.match(decideSolana({ op, policy, wallets }).reason, /devnet is not on clusters_allow/);
  assert.match(decideSolana({ op: { ...op, cluster: "mainnet", keys: [W.publicKey, ATTACKER] }, policy, wallets }).reason, /block list/);
  assert.match(decideSolana({ op: { kind: "unsupported", method: "sendBundle" }, policy, wallets }).reason, /sendBundle/);
});

// ---------- end to end ----------
test("reads pass through; browsers refused; status; the upstream key never leaks", async () => {
  const g = await setup();
  try {
    assert.equal((await g.call("getBalance", [W.publicKey])).result.value, 5_000_000_000);
    const b = await g.post([{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "getHealth" }]);
    assert.equal(b.body[1].result, "ok");
    assert.equal((await g.post({ jsonrpc: "2.0", id: 1, method: "getSlot" }, { origin: "https://evil.example" })).status, 403);
    const st = (await g.call("tas_guardStatus", [])).result;
    assert.equal(st.mode, "solana"); assert.equal(st.cluster, "devnet"); assert.equal(st.limits.max_tx_usd, 100);
    const info = await fetch(g.url).then((r) => r.json());
    assert.equal(info.mode, "solana");
    assert.ok(!JSON.stringify([info, st, g.logs]).includes("SECRET-123"));
  } finally { await g.stop(); }
});

test("within limits: a pump.fun buy goes through and is counted toward the daily and per-program totals", async () => {
  const g = await setup();
  try {
    const r = await g.send([s.ix.createAta(W.publicKey, A.wMeme, W.publicKey, MEME), dexBuy(100_000_000n, 5_000_000_000n)]);
    assert.ok(r.result, JSON.stringify(r));
    assert.equal(g.chain.tokenBalance(A.wMeme), 5_000_000_000n);
    const st = (await g.call("tas_guardStatus", [])).result;
    assert.equal(st.today.transactions, 1);
    assert.ok(Math.abs(st.today.usd_used - 15) < 0.01, st.today.usd_used);
    assert.ok(Math.abs(st.today.by_program.pumpfun - 15) < 0.01);
    const line = g.state.verifyAudit();
    assert.ok(line.ok && line.lines >= 1);
  } finally { await g.stop(); }
});

test("per-program caps: per transaction and per day", async () => {
  const g = await setup();
  try {
    await g.send([s.ix.createAta(W.publicKey, A.wMeme, W.publicKey, MEME)]); // known programs only, tiny value
    let r = await g.send([dexBuy(300_000_000n, 1n)]);
    assert.match(r.error.message, /pumpfun per-transaction cap of \$30\.00/);
    r = await g.send([dexBuy(150_000_000n, 1n)]);
    assert.ok(r.result, JSON.stringify(r));
    r = await g.send([dexBuy(150_000_000n, 2n)]);
    assert.match(r.error.message, /today's pumpfun total .* over its daily cap of \$40\.00/);
  } finally { await g.stop(); }
});

test("hard limits: per transaction, daily total, fee cap, failing transactions", async () => {
  const g = await setup({ policy: { approve_over_usd: 1000 } });
  try {
    let r = await g.send([s.ix.tokenTransferChecked(A.wUsdc, USDC, A.fUsdc, W.publicKey, 200_000000n, 6)]);
    assert.match(r.error.message, /\$200\.00 .* over the per-transaction limit of \$100\.00/);
    for (let i = 0; i < 3; i++) assert.ok((await g.send([s.ix.tokenTransfer(A.wUsdc, A.fUsdc, W.publicKey, 90_000000n + BigInt(i))])).result);
    r = await g.send([s.ix.tokenTransfer(A.wUsdc, A.fUsdc, W.publicKey, 50_000000n)]);
    assert.match(r.error.message, /over the daily limit of \$300\.00/);
    r = await g.send([s.ix.cuLimit(1_400_000), s.ix.cuPrice(100_000_000n), s.ix.memo("gm")]);
    assert.match(r.error.message, /max_fee_sol/);
    r = await g.send([s.ix.transfer(W.publicKey, FRIEND, 99_000_000_000n)]);
    assert.match(r.error.message, /would fail/);
    assert.equal(g.chain.tokenBalance(A.fUsdc), 270_000003n, "only the three allowed transfers landed");
  } finally { await g.stop(); }
});

test("drainer patterns are blocked: unlimited delegation, hidden delegation inside another program, wallet assign, token account takeover", async () => {
  const g = await setup({ policy: { programs_allow: ["pumpfun", SHADY] } });
  try {
    let r = await g.send([s.ix.approve(A.wUsdc, ATTACKER, W.publicKey, s.U64_MAX)]);
    assert.match(r.error.message, /Unlimited token delegation/);
    r = await g.send([shady()]);
    assert.match(r.error.message, /Unlimited token delegation/, "caught from the simulated account state, not the instruction");
    r = await g.send([s.ix.assign(W.publicKey, SHADY)]);
    assert.match(r.error.message, /Hands your wallet .* over to program/);
    r = await g.send([s.ix.setAuthority(A.wUsdc, W.publicKey, "accountOwner", ATTACKER)]);
    assert.match(r.error.message, /Gives ownership of your token account/);
    r = await g.send([s.ix.approve(A.wUsdc, ATTACKER, W.publicKey, 500_000000n)]);
    assert.match(r.error.message, /delegation worth \$500\.00 is over the per-transaction limit/);
    assert.equal(g.chain.sent.length, 0);
    assert.equal(s.parseTokenAccount(g.chain.get(A.wUsdc)).delegate, null);
  } finally { await g.stop(); }
});

test("soft rules hold for approval: new recipient, unknown program; approve from the CLI path, deny", async () => {
  const g = await setup({ policy: { approval_ttl_minutes: 1, programs_allow: [], program_caps: {} } });
  try {
    const p = g.send([s.ix.transfer(W.publicKey, s.addr("stranger"), 10_000_000n)]);
    const id = await g.pendingId();
    assert.match(g.state.pending().items[0].summary, /send 0\.01 SOL to/);
    g.state.decideApproval(id, true, "cli");
    const r = await p;
    assert.ok(r.result, JSON.stringify(r));
    const q = g.send([s.ix.tokenTransfer(A.wUsdc, A.aUsdc, W.publicKey, 1_000000n)]);
    const id2 = await g.pendingId();
    assert.match(g.state.pending().items.find((i) => i.id === id2).reason, /Token recipient .* is not on recipients_allow/);
    g.state.decideApproval(id2, false, "cli");
    assert.match((await q).error.message, /denied/);
    assert.equal(g.chain.tokenBalance(A.aUsdc), 0n);
    const u = g.send([s.ix.createAta(W.publicKey, A.wMeme, W.publicKey, MEME), dexBuy(10_000_000n, 1n)]);
    const id3 = await g.pendingId();
    assert.match(g.state.pending().items.find((i) => i.id === id3).reason, /not on programs_allow/);
    g.state.decideApproval(id3, false, "cli");
    await u;
  } finally { await g.stop(); }
});

test("blockhash expires while waiting for approval: the re-signed transaction goes through without asking again", async () => {
  const g = await setup({ policy: { approval_ttl_minutes: 1 } });
  try {
    const ixs = [s.ix.transfer(W.publicKey, s.addr("stranger"), 10_000_000n)];
    const p = g.send(ixs);
    const id = await g.pendingId();
    g.chain.expireBlockhashes();
    g.state.decideApproval(id, true, "telegram");
    const r = await p;
    assert.match(r.error.message, /blockhash expired .* send it again/);
    const r2 = await g.send(ixs); // fresh blockhash, new signature, same transaction
    assert.ok(r2.result, JSON.stringify(r2));
    const r3 = await Promise.race([g.send(ixs), sleep(400).then(() => "held")]);
    assert.equal(r3, "held", "the approval was used once");
  } finally { await g.stop(); }
});

test("kill switch blocks sends but not reads; base58 encoding and v0 lookup tables work", async () => {
  const g = await setup();
  try {
    const lt = s.addr("table");
    g.chain.lookupTable(lt, [A.fUsdc, USDC]);
    let r = await g.send([s.ix.tokenTransferChecked(A.wUsdc, USDC, A.fUsdc, W.publicKey, 1_000000n, 6)], { version: 0, lookupTables: [{ table: lt, addresses: [A.fUsdc, USDC] }] });
    assert.ok(r.result, JSON.stringify(r));
    r = await g.send([s.ix.transfer(W.publicKey, FRIEND, 1_000_000n)], { base58: true });
    assert.ok(r.result, JSON.stringify(r));
    g.state.kill("test");
    r = await g.send([s.ix.transfer(W.publicKey, FRIEND, 1_000_000n)]);
    assert.match(r.error.message, /Kill switch/);
    assert.ok((await g.call("getBalance", [W.publicKey])).result);
    g.state.resume();
  } finally { await g.stop(); }
});

test("unsupported senders, garbage and a transaction not signed by the wallet are blocked", async () => {
  const g = await setup();
  try {
    assert.match((await g.call("sendBundle", [["abc"]])).error.message, /sendBundle/);
    assert.match((await g.call("sendTransaction", ["not-base58-0OIl"])).error.message, /Couldn't check this transaction/);
    const other = s.keypair("someone-else");
    g.chain.fund(other.publicKey, 1_000_000_000n);
    const raw = s.buildTransaction({ payer: other.publicKey, signers: [other], instructions: [s.ix.transfer(other.publicKey, FRIEND, 1n)], blockhash: g.chain.blockhash });
    assert.match((await g.call("sendTransaction", [raw.toString("base64"), { encoding: "base64" }])).error.message, /Not signed by a configured wallet/);
  } finally { await g.stop(); }
});

test("simulation off: only decoded transfers are valued; other programs need approval", async () => {
  const g = await setup({ policy: { simulate: false } });
  try {
    let r = await g.send([s.ix.tokenTransfer(A.wUsdc, A.fUsdc, W.publicKey, 120_000000n)]);
    assert.match(r.error.message, /\$120\.00/, "token decimals read from the mint account");
    const p = g.send([dexBuy(10_000_000n, 1n)]);
    const id = await g.pendingId();
    assert.match(g.state.pending().items.find((i) => i.id === id).reason, /simulation is off/);
    g.state.decideApproval(id, false, "cli");
    await p;
  } finally { await g.stop(); }
});

test("websocket upgrades pass through to the upstream (same port and port+1); browser websockets refused", async () => {
  const chain = new MockSolana();
  await chain.listen();
  const guard = new SolRpcGuard({ upstream: chain.url, wallets: [W.publicKey], policy: resolveSolanaPolicy(BASE), state: new State(mkdtempSync(join(tmpdir(), "tg-ws-")), "ws"), log: () => {} });
  const port = await new Promise((r) => { const sv = net.createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  await guard.listen("127.0.0.1", port);
  const ws = (p, extra = "") => new Promise((resolve) => {
    const sock = net.connect(p, "127.0.0.1");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.startsWith("HTTP/1.1 101") && buf.includes("\r\n\r\n") && !sock.sentFrame) {
        sock.sentFrame = true;
        const payload = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"slotSubscribe"}');
        const mask = Buffer.from([1, 2, 3, 4]);
        sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
      } else if (buf.includes('"result":42')) { sock.destroy(); resolve("ok"); }
      else if (buf.startsWith("HTTP/1.1 403")) { sock.destroy(); resolve("403"); }
    });
    sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
  });
  try {
    assert.equal(await ws(port), "ok");
    assert.equal(await ws(port + 1), "ok");
    assert.equal(await ws(port, "Origin: https://evil.example\r\n"), "403");
    assert.equal(chain.wsHits, 2);
  } finally { await guard.close(); await chain.close(); }
});

test("transaction v1 (SIMD-0385): decodes, absolute priority fee, guarded end to end", async () => {
  const raw = s.buildTransaction({ version: 1, payer: W.publicKey, signers: [W], config: { priorityFee: 20_000n, computeUnitLimit: 50_000 }, instructions: [s.ix.cuPrice(999_999_999n), s.ix.transfer(W.publicKey, FRIEND, 123n)] });
  assert.equal(raw[0], 0x81);
  const tx = s.decodeTransaction(raw);
  assert.equal(tx.version, 1);
  assert.deepEqual(tx.config, { priorityFee: 20_000n, computeUnitLimit: 50_000 });
  const al = s.accountList(tx);
  const ixs = tx.instructions.map((i) => s.decodeInstruction(i, al.keys));
  assert.deepEqual([ixs[1].type, ixs[1].to, ixs[1].lamports], ["transfer", FRIEND, 123n]);
  assert.equal(s.computeFee(ixs, 1, tx).lamports, 25_000n, "compute budget instructions are ignored in v1");
  assert.throws(() => s.decodeTransaction(Buffer.concat([raw, Buffer.alloc(1)])), /trailing/);
  const bad = Buffer.from(raw); bad.writeUInt32LE(0b100000, 4);
  assert.throws(() => s.decodeTransaction(bad), /unknown config bits/);
  const g = await setup();
  try {
    let r = await g.send([s.ix.transfer(W.publicKey, FRIEND, 1_000_000n)], { version: 1, config: { priorityFee: 10_000n } });
    assert.ok(r.result, JSON.stringify(r));
    r = await g.send([s.ix.memo("gm")], { version: 1, config: { priorityFee: 50_000_000n } });
    assert.match(r.error.message, /max_fee_sol.*50000000 lamports \(v1 transaction\)/);
    r = await g.send([s.ix.approve(A.wUsdc, ATTACKER, W.publicKey, s.U64_MAX)], { version: 1 });
    assert.match(r.error.message, /Unlimited token delegation/);
  } finally { await g.stop(); }
});
