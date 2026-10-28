// Onchain mode: a local HTTP JSON-RPC proxy for EVM chains. Point your agent's RPC URL here.
// Reads pass straight through to the upstream RPC. Money-moving methods (sends and signatures) are
// decoded and checked against the onchain policy first; some are held for a human, some blocked.
import { createServer } from "node:http";
import { decodeRawTx, normalizeTxObject, decodeCall, decodeTypedData, revertReason, isAddress, lowerAddr } from "./evm.js";
import { decideOnchain, describe, chainName, usd } from "./onchain-policy.js";
import { canonical, sha256 } from "./state.js";
import { TelegramApprover } from "./telegram.js";
import { VERSION } from "./proxy.js";

const RAW_SEND = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);
const TYPED = new Set(["eth_signTypedData", "eth_signTypedData_v1", "eth_signTypedData_v3", "eth_signTypedData_v4"]);
const HANDLED = new Set([...RAW_SEND, ...TYPED, "eth_sendTransaction", "personal_sign", "eth_sign", "tas_guardStatus"]);
// Anything else that can send or sign is blocked by default (unsupported_methods): eth_signTransaction,
// eth_sendUserOperation, personal_sendTransaction, wallet_sendCalls, bundles, ...
const SIGNING = /^(eth_send|eth_sign|personal_|wallet_|mev_|flashbots_)/i; // case-insensitive: odd casing is blocked, not passed through
const MAX_BODY = 5 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isGuardedEvm = (m) => m && typeof m.method === "string" && (HANDLED.has(m.method) || SIGNING.test(m.method));
const jsonBig = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export class RpcGuard {
  /**
   * @param {object} o
   * @param {string} o.upstream        upstream RPC URL (may hold an API key: never logged)
   * @param {object} [o.headers]       extra headers for the upstream (e.g. an API key header)
   * @param {string[]} o.wallets       the agent's wallet addresses
   * @param {object} o.policy          resolved onchain policy
   * @param {import('./state.js').State} o.state
   * @param {object} [o.approvals]     { cli?: boolean, telegram?: {...} }
   */
  constructor({ upstream, headers = {}, wallets, policy, state, approvals = {}, log = (s) => process.stderr.write("[tas-guard] " + s + "\n") }) {
    const u = new URL(upstream);
    this.headers = { "content-type": "application/json", ...headers };
    if (u.username || u.password) { // fetch refuses URLs with credentials: move them to a header
      this.headers.authorization = "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64");
      u.username = ""; u.password = "";
    }
    this.upstream = u.toString();
    this.upstreamHost = u.host;
    this.secrets = [upstream, this.upstream, u.pathname.length > 1 ? u.pathname : null, u.search || null].filter(Boolean);
    this.wallets = this.parseWallets(wallets);
    if (!this.wallets.size) throw new Error('"wallets" is required: the agent\'s wallet address(es), so the guard can check the sender and run the pre-flight check.');
    this.policy = policy;
    this.state = state;
    this.log = log;
    this.approvalsCfg = approvals;
    this.seq = 0;
    this.sendLock = Promise.resolve();
    this.nextNonce = new Map();
    if (approvals.telegram) {
      this.tg = new TelegramApprover({ wait_seconds: 45, ...approvals.telegram }, state, log, () => this.telegramStatus());
      this.tg.run();
      log("telegram approvals on");
    }
  }

  // ---------- hooks (the Solana guard overrides these) ----------
  parseWallets(wallets) { return new Set((wallets || []).map((w) => { if (!isAddress(w)) throw new Error(`wallets: '${w}' is not a 0x address`); return w.toLowerCase(); })); }
  isGuarded(m) { return isGuardedEvm(m); }
  prepare() { return this.chainId().catch(() => {}); }
  modeName() { return chainName(this.cid ?? null); }
  summarize(op) { return describe(op, this.policy); }
  needsCheck(op) { return op.send && this.policy.preflight; }
  check(op) { return this.preflight(op); }
  fingerprint(m) { return sha256(this.state.guard + "|" + m.method + "|" + canonical(m.params ?? null)); }
  onExecuted(op, fresh) {
    this.state.recordExecuted(fresh.spend);
    if (op.raw && op.from) this.nextNonce.set(op.from, op.nonce + 1n);
  }
  auditArgs(op) { return auditArgs(op); }
  info() { return { tas_guard: VERSION, mode: "onchain", upstream: this.upstreamHost, chain_id: this.cid ?? null }; }
  async announce(host) {
    const cid = await this.chainId().catch(() => null);
    this.log(`onchain guard listening on ${this.url} -> upstream ${this.upstreamHost} (${cid === null ? "chain id not read yet" : chainName(cid)}), wallets ${[...this.wallets].join(", ")}`);
    if (cid !== null && this.policy.chains_allow.length && !this.policy.chains_allow.includes(cid)) this.log(`warning: upstream chain ${cid} is not on chains_allow: every send and signature will be blocked`);
  }

  /** Remove the upstream URL (and its API key) from anything we might log or return. */
  scrub(s) { let t = String(s); for (const x of this.secrets) t = t.split(x).join("<upstream>"); return t; }

  async listen(host = "127.0.0.1", port = 8547) {
    this.server = createServer((req, res) => this.onHttp(req, res).catch((e) => {
      this.log("error: " + this.scrub(e.stack || e.message));
      if (!res.headersSent) this.send(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "TAS Guard internal error" } });
    }));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, resolve); });
    const a = this.server.address();
    this.url = `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`;
    await this.announce(host);
    if (!/^(127\.|::1$|localhost$)/.test(host)) this.log(`warning: listening on ${host}, not loopback. Anyone who can reach this port can use your RPC through the guard.`);
    return this.url;
  }

  close() { this.tg?.stop(); this.server?.closeAllConnections?.(); return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }

  // ---------- upstream ----------
  async upstreamRaw(body) {
    const r = await fetch(this.upstream, { method: "POST", headers: this.headers, body, signal: AbortSignal.timeout(60_000) });
    return { status: r.status, text: await r.text() };
  }
  async rpc(method, params) {
    const { text } = await this.upstreamRaw(JSON.stringify({ jsonrpc: "2.0", id: `tg-${++this.seq}`, method, params }));
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`upstream returned non-JSON for ${method}`); }
    if (j.error) throw Object.assign(new Error(j.error.message || "upstream error"), { rpc: j.error });
    return j.result;
  }
  chainId() {
    if (this.cid !== undefined) return Promise.resolve(this.cid);
    return this.rpc("eth_chainId", []).then((r) => (this.cid = Number(BigInt(r))));
  }

  // ---------- HTTP ----------
  send(res, status, obj) {
    if (res.writableEnded || res.destroyed) return;
    const body = typeof obj === "string" ? obj : JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async onHttp(req, res) {
    // Browsers send Origin on cross-site requests: refuse them, so a web page can't use your agent's RPC.
    if (req.headers.origin) return this.send(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "TAS Guard refuses browser (cross-origin) requests" } });
    if (req.method === "GET") return this.send(res, 200, this.info());
    if (req.method !== "POST") return this.send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST JSON-RPC only" } });
    let body = "", size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return this.send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } }); body += c; }
    let msg;
    try { msg = JSON.parse(body); } catch { return this.send(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const ctx = { gone: false };
    res.on("close", () => { if (!res.writableEnded) ctx.gone = true; });

    const guarded = Array.isArray(msg) ? msg.some((m) => this.isGuarded(m)) : this.isGuarded(msg);
    // Forward what we parsed (not the raw bytes), so the upstream can't read a different request
    // than the guard did (e.g. JSON with duplicate "method" keys).
    if (!guarded) return this.passThrough(res, JSON.stringify(msg));
    if (!Array.isArray(msg)) {
      const out = await this.handle(msg, ctx);
      return out ? this.send(res, 200, out) : ctx.gone ? undefined : (res.writeHead(204), res.end());
    }
    const outs = await Promise.all(msg.map((m) => (this.isGuarded(m) ? this.handle(m, ctx) : this.forward(m))));
    this.send(res, 200, outs.filter(Boolean));
  }

  async passThrough(res, body) {
    try {
      const r = await this.upstreamRaw(body);
      this.send(res, r.status, r.text);
    } catch (e) {
      this.send(res, 502, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "TAS Guard: upstream RPC unreachable: " + this.scrub(e.message) } });
    }
  }

  /** Forward one message unchanged; returns the upstream's response object (null for notifications). */
  async forward(m) {
    try {
      const { text } = await this.upstreamRaw(JSON.stringify(m));
      if (m.id === undefined) return null;
      return JSON.parse(text);
    } catch (e) {
      return m.id === undefined ? null : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "TAS Guard: upstream RPC error: " + this.scrub(e.message) } };
    }
  }

  // ---------- decoding ----------
  async decode(m) {
    const p = Array.isArray(m.params) ? m.params : [];
    const op = { method: m.method, send: false };
    try {
      if (RAW_SEND.has(m.method)) {
        Object.assign(op, { send: true, raw: true });
        const tx = decodeRawTx(p[0]);
        Object.assign(op, tx, decodeCall(tx), { to: tx.to });
        try { op.from = await this.inferSender(tx); } catch (e) { op.error = "Sender check: " + this.scrub(e.message); }
      } else if (m.method === "eth_sendTransaction") {
        op.send = true;
        const tx = normalizeTxObject(p[0]);
        if (!tx.from) throw new Error("the transaction has no 'from' address");
        Object.assign(op, tx, decodeCall(tx), { to: tx.to });
      } else if (TYPED.has(m.method)) {
        const ai = p.findIndex((x) => isAddress(x));
        if (ai < 0 || p.length !== 2) throw new Error("expected [address, typedData]");
        let td = p[1 - ai];
        if (typeof td === "string") { try { td = JSON.parse(td); } catch { throw new Error("typed data is not valid JSON"); } }
        Object.assign(op, { from: lowerAddr(p[ai]) }, decodeTypedData(td));
      } else if (m.method === "personal_sign" || m.method === "eth_sign") {
        const [data, addr] = m.method === "personal_sign" ? [p[0], p[1]] : [p[1], p[0]];
        if (!isAddress(addr)) throw new Error("no signer address");
        Object.assign(op, { kind: m.method, from: addr.toLowerCase(), preview: preview(data, m.method === "eth_sign") });
      } else {
        op.kind = "unsupported";
      }
    } catch (e) {
      op.kind = op.kind || "undecodable";
      op.error = op.error || `Couldn't decode ${m.method}: ${this.scrub(e.message)}`;
    }
    return op;
  }

  /**
   * The sender of a raw transaction can't be recovered without secp256k1, so match its nonce
   * against the configured wallets: it must be between the wallet's mined and pending nonce.
   */
  async inferSender(tx) {
    const seen = [];
    for (const w of this.wallets) {
      let latest, pending;
      try { [latest, pending] = (await Promise.all([this.rpc("eth_getTransactionCount", [w, "latest"]), this.rpc("eth_getTransactionCount", [w, "pending"])])).map((x) => BigInt(x)); }
      catch (e) { throw new Error(`couldn't read the nonce of ${w} from the upstream (${this.scrub(e.message)})`); }
      const hi = [pending, this.nextNonce.get(w) ?? 0n].reduce((a, b) => (a > b ? a : b));
      if (tx.nonce >= latest && tx.nonce <= hi) return w;
      seen.push(`${w} expects ${hi}`);
    }
    throw new Error(`its nonce ${tx.nonce} doesn't match any configured wallet (${seen.join(", ")}). It is probably signed by a key that isn't in "wallets", so it is blocked.`);
  }

  /** eth_call + eth_estimateGas at "latest". Catches reverts, not every way a transaction can go wrong. */
  async preflight(op) {
    const call = { from: op.from, ...(op.to ? { to: op.to } : {}), data: op.data || "0x", value: "0x" + (op.value || 0n).toString(16) };
    for (const method of ["eth_call", "eth_estimateGas"]) {
      try { await this.rpc(method, method === "eth_call" ? [call, "latest"] : [call]); }
      catch (e) {
        if (e.rpc?.code === -32601) continue; // method not supported upstream
        if (e.rpc) return `Pre-flight revert check: ${method} failed: ${revertReason(e.rpc)}`;
        return `Pre-flight revert check couldn't run (${this.scrub(e.message)}), so the transaction is blocked.`;
      }
    }
    return null;
  }

  // ---------- the guarded path ----------
  status() {
    const u = this.state.usage();
    const p = this.policy;
    const pending = this.state.pending().items.filter((i) => i.guard === this.state.guard && i.status === "pending");
    return {
      guard: this.state.guard, mode: "onchain", chain: chainName(this.cid ?? null), upstream: this.upstreamHost, wallets: [...this.wallets], kill_switch: this.state.killed(),
      limits: { max_tx_usd: p.max_tx_usd, max_daily_usd: p.max_daily_usd, approve_over_usd: p.approve_over_usd, max_tx_per_minute: p.max_tx_per_minute, max_tx_per_day: p.max_tx_per_day, chains_allow: p.chains_allow, unlimited_approval: p.unlimited_approval, preflight: p.preflight },
      today: { day: u.day, usd_used: u.spent, usd_left: Math.max(0, p.max_daily_usd - u.spent), transactions: u.orders, transactions_left: Math.max(0, p.max_tx_per_day - u.orders) },
      pending_approvals: pending.map((i) => ({ id: i.id, method: i.tool, summary: i.summary })),
    };
  }
  telegramStatus() {
    const s = this.status();
    return { ...s, mode: s.chain, today: { value_used: s.today.usd_used, value_left: s.today.usd_left, orders: s.today.transactions, orders_left: s.today.transactions_left }, limits: { max_order_value: s.limits.max_tx_usd, max_daily_value: s.limits.max_daily_usd, approve_over: s.limits.approve_over_usd } };
  }

  decideNow(op) {
    return decideOnchain({ op, policy: this.policy, usage: this.state.usage(), wallets: this.wallets, upstreamChainId: this.cid ?? null, killed: this.state.killed() });
  }

  async handle(m, ctx) {
    const id = m.id;
    const reply = (x) => (id === undefined ? null : { jsonrpc: "2.0", id, ...x });
    if (m.method === "tas_guardStatus") return reply({ result: this.status() });

    await this.prepare();
    const op = await this.decode(m);
    op.upstreamChainId = this.cid ?? null;
    let d = this.decideNow(op);
    const summary = this.summarize(op);
    const base = { tool: m.method, class: op.kind, mode: this.modeName(), args: this.auditArgs(op), decision: d.action, reason: d.reason, order_value: finite(d.usd), summary };
    const blocked = (reason, extra = {}) => {
      this.state.audit({ ...base, decision: "block", reason, outcome: "blocked", ...extra });
      if (this.tg?.notifyBlocked) this.tg.notify(`🚫 Blocked (${this.state.guard}, ${base.mode})\n${summary}\nWhy: ${reason}`);
      this.log(`blocked ${m.method}: ${reason}`);
      return reply({ error: { code: -32003, message: `TAS Guard blocked this: ${reason}${/[.!?)]$/.test(reason) ? "" : "."} Do not retry with a workaround; tell the user what was blocked and why.`, data: { tas_guard: { decision: "block", reason, summary } } } });
    };
    if (d.action === "block") return blocked(d.reason);

    if (this.needsCheck(op)) {
      const why = await this.check(op);
      if (why) return blocked(why);
    }

    let approvedBy;
    if (d.action === "approve") {
      const a = await this.getApproval(m, op, summary, d, base, ctx);
      if (a.response !== undefined) return a.response === null ? null : reply(a.response);
      approvedBy = a.by;
    }

    const go = async () => {
      if (approvedBy && this.needsCheck(op)) { // time has passed while waiting: check again
        const why = await this.check(op, { approvedBy, m });
        if (why && typeof why === "object") return reply(why.response);
        if (why) return blocked(why, { approved_by: approvedBy });
      }
      const fresh = this.decideNow(op);
      if (fresh.action === "block") return blocked(fresh.reason, { approved_by: approvedBy });
      if (fresh.action === "approve" && !approvedBy) return blocked(`needs approval now (${fresh.reason}). Send it again to start an approval.`);
      const r = await this.forward(m);
      const ok = r === null || (r && r.error === undefined);
      if (ok && op.send) {
        this.onExecuted(op, fresh);
        if (this.tg?.notifyExecuted) this.tg.notify(`✅ Sent (${this.state.guard})\n${summary}${approvedBy ? `\nApproved via ${approvedBy}` : ""}`);
      }
      this.state.audit({ ...base, outcome: ok ? (op.send ? "executed" : "signed") : "upstream_rejected", approved_by: approvedBy, counted: ok && op.send, result: ok && typeof r?.result === "string" ? r.result.slice(0, 66) : undefined, error: ok ? undefined : this.scrub(r?.error?.message || "") });
      this.log(`${ok ? "forwarded" : "upstream rejected"} ${m.method}: ${summary}${approvedBy ? ` (approved via ${approvedBy})` : ""}`);
      return r;
    };
    if (!op.send) return go();
    // Sends run one at a time and limits are re-checked right before forwarding,
    // so parallel requests (or a long approval wait) can't slip past the daily caps or the kill switch.
    const run = this.sendLock.then(go);
    this.sendLock = run.catch(() => {});
    return run;
  }

  /** Hold the request until a human decides (terminal or Telegram), the TTL passes, or the client hangs up. */
  async getApproval(m, op, summary, d, base, ctx) {
    const ttl = this.policy.approval_ttl_minutes;
    const fp = this.fingerprint(m, op);
    const prior = this.state.consumeApproval(fp, ttl);
    if (prior) return { by: prior.decided_by || "cli" };
    const item = this.state.requestApproval({ fingerprint: fp, tool: m.method, summary: `${summary}${d.usd !== undefined && Number.isFinite(d.usd) ? ` [${usd(d.usd)}]` : ""}`, reason: d.reason, cli_allowed: !(this.tg && this.approvalsCfg.cli === false) });
    this.state.audit({ ...base, outcome: "held", approval_id: item.id });
    this.log(`HELD ${item.id}: ${item.summary}\n            why: ${d.reason}\n            approve: tas-guard approve ${item.id}   deny: tas-guard deny ${item.id}`);
    if (this.tg && !this.tg.sent.has(item.id)) {
      try { await this.tg.ask(item, base.mode); } catch (e) { this.log("telegram ask failed: " + e.message); }
    }
    const deadline = Date.now() + ttl * 60_000;
    while (Date.now() < deadline) {
      if (ctx.gone) return { response: null }; // the agent gave up; the request stays pending, and the same request sent again picks up the decision
      const it = this.state.pending().items.find((i) => i.id === item.id);
      if (it && it.status === "denied") {
        this.state.audit({ ...base, outcome: "denied", approved_by: it.decided_by, approval_id: item.id });
        return { response: { error: { code: 4001, message: `TAS Guard: the user denied this request (${item.id}). ${summary}. Do not retry it unless the user asks.`, data: { tas_guard: { decision: "denied", approval_id: item.id } } } } };
      }
      if (it && it.status !== "pending") {
        if (this.state.consumeApproval(fp, ttl)) return { by: it.decided_by || "cli" };
        return { response: { error: { code: -32003, message: `TAS Guard: approval ${item.id} was already used by an identical request.` } } };
      }
      await sleep(300);
    }
    this.state.audit({ ...base, outcome: "expired", approval_id: item.id });
    return { response: { error: { code: -32003, message: `TAS Guard: nobody approved request ${item.id} within ${ttl} minutes, so it was not sent. ${summary}`, data: { tas_guard: { decision: "expired", approval_id: item.id } } } } };
  }
}

const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined);

function preview(data, raw) {
  if (typeof data !== "string") return String(data);
  if (raw || !/^0x([0-9a-f]{2})*$/i.test(data)) return data.slice(0, 200);
  const s = Buffer.from(data.slice(2), "hex").toString("utf8");
  return /^[\x20-\x7e\s]*$/.test(s) ? s.slice(0, 200) : data.slice(0, 66) + (data.length > 66 ? "…" : "");
}

/** The decoded request for the audit log: BigInts as strings, calldata trimmed, no signature fields. */
function auditArgs(op) {
  const { method, send, upstreamChainId, yParity, v, error, ...rest } = op;
  if (typeof rest.data === "string" && rest.data.length > 202) rest.data = rest.data.slice(0, 202) + "…";
  return jsonBig(rest);
}
