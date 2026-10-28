// Solana mode: a local HTTP JSON-RPC proxy for Solana. Point your agent's RPC URL here.
// Reads pass straight through. sendTransaction is decoded, simulated and checked against the
// Solana policy before it reaches the network; some transactions are held for a human, some blocked.
// WebSocket subscriptions (used to confirm transactions) are passed through to the upstream.
import net from "node:net";
import tls from "node:tls";
import { createServer } from "node:http";
import { RpcGuard } from "./rpc.js";
import { canonical, sha256 } from "./state.js";
import { VERSION } from "./proxy.js";
import { usd } from "./onchain-policy.js";
import { decideSolana, describeSolana } from "./solana-policy.js";
import {
  b58decode, isPubkey, decodeTransaction, parseLookupTable, accountList, decodeInstruction, computeFee,
  parseTokenAccount, parseMint, rpcAccount, CLUSTERS, WSOL, ATA, short,
} from "./solana.js";

const SEND = "sendTransaction";
const SENDING = /^send/i; // sendBundle, sendRawTransaction, ...: can't be checked, blocked by default
const isGuardedSol = (m) => m && typeof m.method === "string" && (m.method === SEND || m.method === "tas_guardStatus" || SENDING.test(m.method));
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const jsonBig = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const WS_HEADERS = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"];

export class SolRpcGuard extends RpcGuard {
  /** Same options as RpcGuard, plus o.upstreamWs (defaults to the upstream URL with ws:// or wss://). */
  constructor(o) {
    super(o);
    const ws = new URL(o.upstreamWs || o.upstream);
    if (!o.upstreamWs) ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    this.upstreamWs = ws;
    this.secrets.push(ws.toString(), ws.pathname.length > 1 ? ws.pathname : null, ws.search || null);
    this.secrets = this.secrets.filter(Boolean);
    this.mintCache = new Map();
    this.sockets = new Set();
  }

  // ---------- hooks ----------
  parseWallets(wallets) { return new Set((wallets || []).map((w) => { if (!isPubkey(w)) throw new Error(`wallets: '${w}' is not a Solana address`); return w; })); }
  isGuarded(m) { return isGuardedSol(m); }
  prepare() { return this.clusterName().catch(() => {}); }
  modeName() { return `solana-${this.cluster || "?"}`; }
  summarize(op) { return describeSolana(op, this.policy, this.wallets); }
  needsCheck(op) { return op.kind === "sol_tx"; }
  decideNow(op) { return decideSolana({ op, policy: this.policy, usage: this.state.usage(), wallets: this.wallets, killed: this.state.killed() }); }
  onExecuted(op, fresh) { this.state.recordExecuted(fresh.spend, Date.now(), fresh.buckets); }
  info() { return { tas_guard: VERSION, mode: "solana", upstream: this.upstreamHost, cluster: this.cluster ?? null }; }
  async announce() {
    if (this.deferAnnounce) return;
    const c = await this.clusterName().catch(() => null);
    this.log(`solana guard listening on ${this.url} (websocket on the same port${this.wsUrl ? ` and ${this.wsUrl}` : ""}) -> upstream ${this.upstreamHost} (${c || "cluster not read yet"}), wallets ${[...this.wallets].join(", ")}`);
    if (c && this.policy.clusters_allow.length && !this.policy.clusters_allow.includes(c)) this.log(`warning: upstream cluster ${c} is not on clusters_allow: every transaction will be blocked`);
    if (!this.policy.sol_usd) this.log('warning: no "sol_usd" price set, so SOL leaving the wallet can\'t be valued (unknown_value applies)');
  }

  /**
   * Approval key: the transaction without its signatures and blockhash, so the same transaction
   * re-signed with a fresh blockhash (they expire in about a minute) matches an earlier approval.
   */
  fingerprint(m, op) {
    if (op.kind !== "sol_tx") return sha256(this.state.guard + "|" + m.method + "|" + canonical(m.params ?? null));
    const t = op.tx;
    return sha256(this.state.guard + "|sol|" + canonical({ v: t.version, h: t.header, k: t.staticKeys, i: t.instructions.map((x) => [x.programIdIndex, x.accounts, x.data.toString("hex")]), l: t.lookups }));
  }

  /** Before sending (and again after an approval wait): re-simulate. Returns a block reason, or null. */
  async check(op, after) {
    if (!after) return null; // the first simulation already ran while decoding
    try { await this.inspect(op); } catch (e) { return `Couldn't re-check the transaction (${this.scrub(e.message)}), so it was not sent.`; }
    if (op.sim && /BlockhashNotFound|blockhash/i.test(op.sim.err || "")) {
      // The blockhash expired while a human was deciding. Keep the approval for a re-signed copy.
      const fp = this.fingerprint(after.m, op);
      const item = this.state.requestApproval({ fingerprint: fp, tool: SEND, summary: this.summarize(op), reason: "re-approval after blockhash expiry" });
      this.state.decideApproval(item.id, true, after.approvedBy === "cli" ? "cli" : after.approvedBy);
      this.state.audit({ tool: SEND, class: op.kind, mode: this.modeName(), decision: "approve", outcome: "blockhash_expired", approved_by: after.approvedBy, summary: this.summarize(op) });
      return { response: { error: { code: -32003, message: `TAS Guard: approved, but the transaction's blockhash expired while waiting for the approval. Rebuild the SAME transaction with a fresh blockhash, sign it and send it again within ${this.policy.approval_ttl_minutes} minutes: it will go through without asking again.`, data: { tas_guard: { decision: "approved_blockhash_expired" } } } } };
    }
    return null;
  }

  auditArgs(op) {
    if (op.kind !== "sol_tx") return { method: op.method };
    return jsonBig({
      cluster: op.cluster, signers: op.signers, fee_lamports: op.fee?.lamports,
      instructions: op.instructions.map((i) => { const { accounts, programId, ...rest } = i; return { programId, ...rest }; }),
      sim: op.sim ? { err: op.sim.err, sol_out: op.sim.solOut, sol_in: op.sim.solIn, tokens: op.sim.tokens, inner_programs: op.sim.innerPrograms } : undefined,
    });
  }

  // ---------- upstream helpers ----------
  async clusterName() {
    if (this.cluster) return this.cluster;
    const h = await this.rpc("getGenesisHash", []);
    this.cluster = CLUSTERS[h] || "localnet";
    return this.cluster;
  }
  async accounts(keys) {
    const out = [];
    for (const part of chunk(keys, 100)) {
      const r = await this.rpc("getMultipleAccounts", [part, { encoding: "base64", commitment: "confirmed" }]);
      out.push(...r.value.map(rpcAccount));
    }
    return out;
  }
  async decimals(mints) {
    const need = [...new Set(mints)].filter((m) => !this.mintCache.has(m));
    if (need.length) (await this.accounts(need)).forEach((a, i) => this.mintCache.set(need[i], parseMint(a)?.decimals ?? null));
    return Object.fromEntries([...new Set(mints)].map((m) => [m, this.mintCache.get(m)]));
  }

  // ---------- decoding ----------
  async decode(m) {
    const op = { method: m.method, send: false };
    if (m.method === "tas_guardStatus") return op;
    if (m.method !== SEND) return { ...op, kind: "unsupported" };
    op.send = true;
    try {
      const p = Array.isArray(m.params) ? m.params : [];
      if (typeof p[0] !== "string") throw new Error("expected an encoded transaction string");
      const enc = p[1]?.encoding || "base58";
      if (enc !== "base58" && enc !== "base64") throw new Error(`unsupported encoding '${enc}'`);
      op.raw = enc === "base64" ? Buffer.from(p[0], "base64") : b58decode(p[0]);
      if (enc === "base64" && op.raw.toString("base64") !== p[0].replace(/\s/g, "")) throw new Error("not valid base64");
      op.tx = decodeTransaction(op.raw);
      op.kind = "sol_tx";
      await this.prepare();
      op.cluster = this.cluster;
      const tables = {};
      if (op.tx.lookups.length) {
        const accs = await this.accounts(op.tx.lookups.map((l) => l.table));
        op.tx.lookups.forEach((l, i) => { if (accs[i]) tables[l.table] = parseLookupTable(accs[i].data); });
      }
      const al = accountList(op.tx, tables);
      Object.assign(op, { keys: al.keys, writable: al.keys.filter((_, i) => al.writable[i]), signers: al.signers, feePayer: al.feePayer });
      op.instructions = op.tx.instructions.map((ix) => decodeInstruction(ix, al.keys));
      op.fee = computeFee(op.instructions, op.tx.signatures.length, op.tx);
      op.created = {};
      for (const i of op.instructions) if (i.programId === ATA && i.account) op.created[i.account] = i.owner;
      await this.inspect(op);
    } catch (e) {
      op.kind = op.kind === "sol_tx" ? "sol_tx" : "undecodable";
      op.error = `Couldn't check this transaction: ${this.scrub(e.message)}`;
      if (!op.instructions) op.kind = "undecodable";
    }
    return op;
  }

  /** Read the writable accounts, simulate, and work out what leaves the agent's wallets. Sets op.pre and op.sim. */
  async inspect(op) {
    const keys = op.writable;
    const pre = await this.accounts(keys);
    const tokenAccounts = {};
    keys.forEach((k, i) => { const t = parseTokenAccount(pre[i]); if (t) tokenAccounts[k] = t; });
    const mints = new Set(Object.values(tokenAccounts).map((t) => t.mint));
    for (const i of op.instructions) if (i.mint) mints.add(i.mint);
    op.pre = { tokenAccounts, mints: {} };
    if (!this.policy.simulate) { op.pre.mints = await this.decimals([...mints]); op.sim = null; return; }

    const r = await this.rpc("simulateTransaction", [op.raw.toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: keys } }]);
    const v = r.value || r;
    const sim = { err: v.err ? errText(v.err, v.logs) : null, logs: (v.logs || []).slice(-30), solOut: 0n, solIn: 0n, tokens: [], ownerChanges: [], delegations: [], closeAuthChanges: [], owners: {}, innerPrograms: [] };
    for (const l of v.logs || []) { const x = /^Program (\w{32,44}) invoke \[(\d+)\]/.exec(l); if (x && Number(x[2]) >= 2 && !sim.innerPrograms.includes(x[1])) sim.innerPrograms.push(x[1]); }
    op.sim = sim;
    if (sim.err) return;
    if (!Array.isArray(v.accounts) || v.accounts.length !== keys.length) throw new Error("the RPC's simulation didn't return the accounts it was asked for");
    const post = v.accounts.map(rpcAccount);

    let lamports = 0n;
    const tok = {};
    keys.forEach((k, i) => {
      const a = pre[i], b = post[i];
      if (this.wallets.has(k)) {
        lamports += (b?.lamports ?? 0n) - (a?.lamports ?? 0n);
        if (a && b && a.owner !== b.owner) sim.ownerChanges.push(`Your wallet ${short(k)} would be owned by program ${short(b.owner)} after this transaction, which gives that program control of it.`);
        return;
      }
      const ta = parseTokenAccount(a), tb = parseTokenAccount(b);
      if (tb) sim.owners[k] = tb.owner;
      const ownA = !!ta && this.wallets.has(ta.owner), ownB = !!tb && this.wallets.has(tb.owner);
      if (!ownA && !ownB) return;
      if (ownA && tb && !ownB) sim.ownerChanges.push(`Your token account ${short(k)} would belong to ${short(tb.owner)} after this transaction.`);
      // The SOL in a token account you own is yours (rent, or the wrapped SOL in a wSOL account).
      lamports += (ownB ? b.lamports : 0n) - (ownA ? a.lamports : 0n);
      const mint = (ta || tb).mint;
      if (mint !== WSOL) tok[mint] = (tok[mint] || 0n) + (ownB ? tb.amount : 0n) - (ownA ? ta.amount : 0n);
      if (ownB && tb.delegate && !this.wallets.has(tb.delegate) && tb.delegatedAmount > 0n && (!ta || ta.delegate !== tb.delegate || tb.delegatedAmount > ta.delegatedAmount)) {
        sim.delegations.push({ account: k, mint: tb.mint, delegate: tb.delegate, amount: tb.delegatedAmount });
      }
      if (ownB && tb.closeAuthority && !this.wallets.has(tb.closeAuthority) && tb.closeAuthority !== ta?.closeAuthority) {
        sim.closeAuthChanges.push(`${short(tb.closeAuthority)} would be able to close your token account ${short(k)}.`);
      }
    });
    const dec = await this.decimals([...Object.keys(tok), ...sim.delegations.map((d) => d.mint), ...mints].filter((m) => m !== WSOL));
    op.pre.mints = dec;
    for (const d of sim.delegations) d.decimals = d.mint === WSOL ? 9 : dec[d.mint];
    sim.solOut = lamports < 0n ? -lamports : 0n;
    sim.solIn = lamports > 0n ? lamports : 0n;
    sim.tokens = Object.entries(tok).filter(([, d]) => d !== 0n).map(([mint, d]) => ({ mint, decimals: dec[mint], out: d < 0n ? -d : 0n, in: d > 0n ? d : 0n }));
  }

  // ---------- status ----------
  status() {
    const u = this.state.usage();
    const p = this.policy;
    const pending = this.state.pending().items.filter((i) => i.guard === this.state.guard && i.status === "pending");
    return {
      guard: this.state.guard, mode: "solana", cluster: this.cluster ?? null, upstream: this.upstreamHost, wallets: [...this.wallets], kill_switch: this.state.killed(),
      limits: { max_tx_usd: p.max_tx_usd, max_daily_usd: p.max_daily_usd, approve_over_usd: p.approve_over_usd, max_tx_per_minute: p.max_tx_per_minute, max_tx_per_day: p.max_tx_per_day, max_fee_sol: p.max_fee_sol, clusters_allow: p.clusters_allow, programs_allow: p.programs_allow, program_caps: p.program_caps, sol_usd: p.sol_usd },
      today: { day: u.day, usd_used: u.spent, usd_left: Math.max(0, p.max_daily_usd - u.spent), transactions: u.orders, transactions_left: Math.max(0, p.max_tx_per_day - u.orders), by_program: u.buckets },
      pending_approvals: pending.map((i) => ({ id: i.id, method: i.tool, summary: i.summary })),
    };
  }
  telegramStatus() {
    const s = this.status();
    return { ...s, mode: `solana ${s.cluster || ""}`.trim(), today: { value_used: s.today.usd_used, value_left: s.today.usd_left, orders: s.today.transactions, orders_left: s.today.transactions_left }, limits: { max_order_value: s.limits.max_tx_usd, max_daily_value: s.limits.max_daily_usd, approve_over: s.limits.approve_over_usd } };
  }

  // ---------- HTTP + WebSocket ----------
  /**
   * Listen for JSON-RPC (and WebSocket upgrades) on host:port, and also on port+1, which is where
   * @solana/web3.js looks for the WebSocket when the RPC URL has an explicit port.
   */
  async listen(host = "127.0.0.1", port = 8890, { wsPort = port === 0 ? 0 : port + 1 } = {}) {
    this.deferAnnounce = true;
    const url = await super.listen(host, port);
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    if (wsPort !== false && wsPort !== null) {
      this.wsServer = createServer((req, res) => this.onHttp(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } }));
      this.wsServer.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
      this.wsServer.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
      await new Promise((resolve, reject) => { this.wsServer.once("error", reject); this.wsServer.listen(wsPort, host, resolve); });
      const a = this.wsServer.address();
      this.wsUrl = `ws://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`;
    }
    this.deferAnnounce = false;
    await this.announce();
    return url;
  }

  close() {
    for (const s of this.sockets) s.destroy();
    const closeWs = new Promise((r) => (this.wsServer ? this.wsServer.close(() => r()) : r()));
    return Promise.all([super.close(), closeWs]);
  }

  onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    if (req.headers.origin || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const u = this.upstreamWs;
    const secure = u.protocol === "wss:";
    const port = Number(u.port) || (secure ? 443 : 80);
    const up = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect(port, u.hostname);
    this.sockets.add(up);
    up.on("close", () => this.sockets.delete(up));
    const onReady = () => {
      const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
      for (const h of WS_HEADERS) if (req.headers[h]) lines.push(`${h}: ${req.headers[h]}`);
      for (const [k, v] of Object.entries(this.headers)) if (k !== "content-type") lines.push(`${k}: ${v}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    };
    up.once(secure ? "secureConnect" : "connect", onReady);
    up.on("error", (e) => { this.log("websocket upstream error: " + this.scrub(e.message)); socket.destroy(); });
    socket.on("close", () => up.destroy());
  }
}

/** Simulation error -> readable text (with the most useful log line). */
function errText(err, logs = []) {
  const e = typeof err === "string" ? err : JSON.stringify(err);
  const hint = [...(logs || [])].reverse().find((l) => /error|failed|insufficient|slippage|exceed/i.test(l));
  return hint ? `${e}; ${hint.slice(0, 160)}` : e;
}

export { usd };
