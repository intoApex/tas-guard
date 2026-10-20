// stdio MCP proxy: client <-> TAS Guard <-> upstream trading MCP server.
// Speaks MCP's newline-delimited JSON-RPC directly, so the guard has no dependencies.
import { spawn } from "node:child_process";
import { classify, detectMode } from "./profiles.js";
import { decide, staticAction } from "./policy.js";
import { canonical, sha256 } from "./state.js";

export const GUARD_TOOL = "tas_guard_status";
const VERSION = "0.1.1";

export class LineChannel {
  constructor(readable, writable, onMessage, onBadLine) {
    this.w = writable;
    let buf = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { onBadLine?.(line); continue; }
        onMessage(msg);
      }
    });
  }
  send(msg) { this.w.write(JSON.stringify(msg) + "\n"); }
}

const isRequest = (m) => m && typeof m.method === "string" && m.id !== undefined;
const isNotification = (m) => m && typeof m.method === "string" && m.id === undefined;
const isResponse = (m) => m && m.method === undefined && m.id !== undefined;
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export class GuardProxy {
  /**
   * @param {object} o
   * @param {object|null} o.profile  connector profile (null = heuristics)
   * @param {object} o.policy        resolved policy
   * @param {import('./state.js').State} o.state
   * @param {{command:string,args?:string[],env?:object,cwd?:string}} o.upstream
   * @param {NodeJS.ReadableStream} [o.input]  client side (default stdin)
   * @param {NodeJS.WritableStream} [o.output] client side (default stdout)
   * @param {(s:string)=>void} [o.log]
   */
  constructor({ profile, policy, state, upstream, input = process.stdin, output = process.stdout, log = (s) => process.stderr.write("[tas-guard] " + s + "\n") }) {
    this.profile = profile;
    this.policy = policy;
    this.state = state;
    this.log = log;
    this.env = { ...process.env, ...(upstream.env || {}) };
    this.mode = detectMode(profile, this.env);
    this.ccy = profile?.quote_currency === "quote" ? "(quote ccy)" : profile?.quote_currency || "";
    this.tools = new Map();
    this.clientCaps = {};
    this.seq = 0;
    this.toUpstream = new Map(); // our id -> { clientId } | { resolve, reject }
    this.toClient = new Map();   // our id -> { upstreamId } | { resolve, reject }
    this.orderLock = Promise.resolve();

    // Windows can't spawn .cmd shims (npx, uvx installed via npm) without a shell; quote args for cmd.exe.
    const win = process.platform === "win32";
    const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    this.child = spawn(win ? q(upstream.command) : upstream.command, (upstream.args || []).map((a) => (win ? q(a) : a)), { env: this.env, cwd: upstream.cwd, stdio: ["pipe", "pipe", "inherit"], shell: win, windowsHide: true });
    this.child.on("error", (e) => { this.log(`could not start upstream '${upstream.command}': ${e.message}`); process.exitCode = 1; this.close(); });
    this.child.on("exit", (code) => { this.log(`upstream exited (${code})`); this.onUpstreamExit?.(code); });
    this.up = new LineChannel(this.child.stdout, this.child.stdin, (m) => this.fromUpstream(m), (l) => this.log("bad line from upstream: " + l.slice(0, 200)));
    this.inflight = 0;
    this.client = new LineChannel(input, output, (m) => { this.inflight++; this.fromClient(m).catch((e) => this.log("error: " + e.stack)).finally(() => this.inflight--); }, (l) => this.log("bad line from client: " + l.slice(0, 200)));
    input.on("end", () => this.drainThenClose());
    log(`guarding '${upstream.command}' with profile ${profile ? profile.slug : "auto (heuristics)"}, mode ${this.mode}`);
    // Which credentials the upstream gets, and from where (never the values): makes stale keys easy to spot.
    for (const [k, v] of Object.entries(this.env)) {
      if (!/(API_?KEY|KEY_?ID|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE)/i.test(k) || !v) continue;
      if (!(k in (upstream.env || {})) && !(profile?.mode?.env && k.startsWith(profile.mode.env.split("_")[0]))) continue;
      const from = upstream.env?.[k] !== undefined && process.env[k] !== upstream.env[k] ? "guard config" : "client env";
      const shown = /SECRET|TOKEN|PASSWORD|PASSPHRASE/i.test(k) ? `set, ${String(v).length} chars` : `...${String(v).slice(-4)}`;
      log(`credential ${k}: ${shown} (from ${from})`);
    }
  }

  close() { try { this.child.stdin.end(); this.child.kill(); } catch {} }

  /** Client hung up: let in-flight calls finish (up to 10s) so no order result is lost, then stop. */
  async drainThenClose() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await this.orderLock;
      await new Promise((r) => setTimeout(r, 25));
      if (this.toUpstream.size === 0 && this.inflight === 0) break;
    }
    this.close();
  }

  // ---- plumbing ----
  nextId(prefix) { return `tg-${prefix}-${++this.seq}`; }
  requestUpstream(method, params) {
    const id = this.nextId("u");
    return new Promise((resolve, reject) => {
      this.toUpstream.set(id, { resolve, reject });
      this.up.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  requestClient(method, params, timeoutMs = 300_000) {
    const id = this.nextId("c");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.toClient.delete(id); reject(new Error("timed out waiting for the client")); }, timeoutMs);
      this.toClient.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.client.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  reply(id, result) { this.client.send({ jsonrpc: "2.0", id, result }); }
  replyError(id, error) { this.client.send({ jsonrpc: "2.0", id, error }); }

  fromUpstream(m) {
    if (isResponse(m)) {
      const p = this.toUpstream.get(m.id);
      if (!p) return;
      this.toUpstream.delete(m.id);
      if (p.clientId !== undefined) this.client.send({ ...m, id: p.clientId });
      else if (m.error) p.reject(Object.assign(new Error(m.error.message), { rpc: m.error }));
      else p.resolve(m.result);
    } else if (isRequest(m)) {
      // Server-initiated request (sampling, elicitation, roots, ping): relay to the client.
      const id = this.nextId("r");
      this.toClient.set(id, { upstreamId: m.id });
      this.client.send({ ...m, id });
    } else if (isNotification(m)) {
      this.client.send(m);
    }
  }

  async fromClient(m) {
    if (isResponse(m)) {
      const p = this.toClient.get(m.id);
      if (!p) return;
      this.toClient.delete(m.id);
      if (p.upstreamId !== undefined) this.up.send({ ...m, id: p.upstreamId });
      else if (m.error) p.reject(Object.assign(new Error(m.error.message), { rpc: m.error }));
      else p.resolve(m.result);
      return;
    }
    if (isNotification(m)) {
      if (m.method === "notifications/cancelled" && m.params?.requestId !== undefined) {
        for (const [ours, p] of this.toUpstream) if (p.clientId === m.params.requestId) { this.up.send({ ...m, params: { ...m.params, requestId: ours } }); return; }
      }
      this.up.send(m);
      return;
    }
    if (!isRequest(m)) return;
    if (m.method === "initialize") {
      this.clientCaps = m.params?.capabilities || {};
      try {
        const r = await this.requestUpstream("initialize", m.params);
        const note = `Tool calls pass through TAS Guard (${this.mode} mode). Orders over policy limits are blocked; some need human approval. Call ${GUARD_TOOL} to see limits.`;
        r.instructions = r.instructions ? r.instructions + "\n\n" + note : note;
        r.capabilities = { ...(r.capabilities || {}), tools: r.capabilities?.tools || {} };
        this.reply(m.id, r);
      } catch (e) { this.replyError(m.id, e.rpc || { code: -32603, message: e.message }); }
      return;
    }
    if (m.method === "tools/list") return this.handleList(m);
    if (m.method === "tools/call") return this.handleCall(m);
    // Everything else passes through untouched.
    const id = this.nextId("f");
    this.toUpstream.set(id, { clientId: m.id });
    this.up.send({ ...m, id });
  }

  // ---- guarded methods ----
  async handleList(m) {
    let r;
    try { r = await this.requestUpstream("tools/list", m.params); }
    catch (e) { return this.replyError(m.id, e.rpc || { code: -32603, message: e.message }); }
    const out = [];
    for (const t of r.tools || []) {
      this.tools.set(t.name, t);
      const info = classify(this.profile, t.name, t);
      const a = staticAction(this.policy, info.class);
      if (a === "block" && this.policy.hide_blocked_tools) continue;
      out.push({ ...t, description: this.tag(info, a) + (t.description || "") });
    }
    if (!m.params?.cursor) {
      out.push({
        name: GUARD_TOOL,
        description: "TAS Guard: show the trading limits that apply to this connection, today's usage, the kill switch and pending approvals. Read-only.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, title: "Guard status" },
      });
    }
    this.reply(m.id, { ...r, tools: out });
  }

  tag(info, a) {
    const p = this.policy, c = this.ccy ? " " + this.ccy : "";
    if (info.class === "order" && a === "check") return `[TAS Guard: max ${p.max_order_value}${c} per order, ${p.max_daily_value}${c} per day; orders over ${p.approve_over} need human approval] `;
    if (a === "approve") return "[TAS Guard: needs human approval] ";
    if (a === "block") return "[TAS Guard: blocked] ";
    return "";
  }

  status() {
    const u = this.state.usage();
    const p = this.policy;
    const pending = this.state.pending().items.filter((i) => i.guard === this.state.guard && i.status === "pending");
    return {
      guard: this.state.guard,
      profile: this.profile ? { slug: this.profile.slug, last_checked: this.profile.last_checked, source: this.profile.source } : "auto (heuristics)",
      mode: this.mode,
      kill_switch: this.state.killed(),
      currency: this.profile?.quote_currency || "unknown",
      limits: { max_order_value: p.max_order_value, max_daily_value: p.max_daily_value, max_orders_per_day: p.max_orders_per_day, max_orders_per_minute: p.max_orders_per_minute, approve_over: p.approve_over, symbols_allow: p.symbols_allow, symbols_block: p.symbols_block, live_requires_approval: p.live_requires_approval },
      today: { day: u.day, value_used: u.spent, value_left: Math.max(0, p.max_daily_value - u.spent), orders: u.orders, orders_left: Math.max(0, p.max_orders_per_day - u.orders) },
      pending_approvals: pending.map((i) => ({ id: i.id, tool: i.tool, summary: i.summary })),
    };
  }

  fingerprint(name, args) {
    const a = { ...(args || {}) };
    if (this.profile?.preview?.confirm_arg) delete a[this.profile.preview.confirm_arg];
    return sha256(this.state.guard + "|" + name + "|" + canonical(a));
  }

  summarize(name, d) {
    const o = d.order;
    if (!o) return name;
    const parts = [o.side, o.qty !== undefined ? o.qty : undefined, o.symbol, o.price !== undefined ? "@ " + o.price : undefined, o.notional !== undefined ? `(${o.notional} notional)` : undefined, o.value !== undefined ? `≈ ${Math.round(o.value * 100) / 100} ${this.profile?.quote_currency || ""}` : undefined].filter((x) => x !== undefined);
    return `${name}: ${parts.join(" ")}`.trim();
  }

  async askHuman(summary, reason) {
    if (!this.clientCaps.elicitation) return null;
    try {
      const r = await this.requestClient("elicitation/create", {
        message: `TAS Guard (${this.mode}) wants your approval.\n\n${summary}\n\nWhy: ${reason}`,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this action?", description: "Only you can answer this; the AI agent cannot." } }, required: ["approve"] },
      });
      return r?.action === "accept" && r?.content?.approve === true;
    } catch (e) {
      this.log("elicitation failed: " + e.message);
      return null;
    }
  }

  async handleCall(m) {
    const name = m.params?.name;
    const args = m.params?.arguments || {};
    if (name === GUARD_TOOL) return this.reply(m.id, textResult(JSON.stringify(this.status(), null, 2)));

    const info = classify(this.profile, name, this.tools.get(name) || {});
    const d = decide({ info, args, policy: this.policy, usage: this.state.usage(), mode: this.mode, killed: this.state.killed() });
    const summary = this.summarize(name, d);
    const base = { tool: name, class: info.class, classified_by: info.source, mode: this.mode, args, decision: d.action, reason: d.reason, order_value: d.order?.value };

    if (d.action === "block") {
      this.state.audit({ ...base, outcome: "blocked" });
      return this.reply(m.id, textResult(`TAS Guard blocked this call. ${d.reason}\nDo not retry with a workaround; tell the user what was blocked and why.`, true));
    }

    let approvedBy;
    if (d.action === "approve") {
      const fp = this.fingerprint(name, args);
      if (this.state.consumeApproval(fp, this.policy.approval_ttl_minutes)) approvedBy = "cli";
      else {
        const human = await this.askHuman(summary, d.reason);
        if (human === true) approvedBy = "client-prompt";
        else if (human === false) {
          this.state.audit({ ...base, outcome: "denied", approved_by: "client-prompt" });
          return this.reply(m.id, textResult(`The user declined this action in the approval prompt. ${summary}`, true));
        } else {
          const item = this.state.requestApproval({ fingerprint: fp, tool: name, summary, reason: d.reason });
          this.state.audit({ ...base, outcome: "held", approval_id: item.id });
          return this.reply(m.id, textResult(
            `TAS Guard is holding this action for human approval (request ${item.id}).\n${summary}\nWhy: ${d.reason}\n\n` +
            `Ask the user to approve it themselves by running:  npx tas-guard approve ${item.id}\n` +
            `Then repeat exactly the same call within ${this.policy.approval_ttl_minutes} minutes. You must not run the approve command yourself.`, true));
        }
      }
    }

    if (!d.counts) return this.forward(m, base, approvedBy, d);
    // Orders run one at a time, and limits are re-checked right before sending,
    // so parallel calls (or a long approval wait) can't slip past the daily caps or the kill switch.
    const run = this.orderLock.then(async () => {
      const fresh = decide({ info, args, policy: this.policy, usage: this.state.usage(), mode: this.mode, killed: this.state.killed() });
      if (fresh.action === "block") {
        this.state.audit({ ...base, decision: "block", reason: fresh.reason, outcome: "blocked", approved_by: approvedBy });
        return this.reply(m.id, textResult(`TAS Guard blocked this call. ${fresh.reason}\nDo not retry with a workaround; tell the user what was blocked and why.`, true));
      }
      if (fresh.action === "approve" && !approvedBy) {
        this.state.audit({ ...base, outcome: "blocked", reason: "needs approval (limits changed)" });
        return this.reply(m.id, textResult(`TAS Guard: this now needs human approval (${fresh.reason}). Repeat the call to start an approval.`, true));
      }
      return this.forward(m, base, approvedBy, fresh);
    });
    this.orderLock = run.catch(() => {});
    return run;
  }

  async forward(m, base, approvedBy, d) {
    let result;
    try { result = await this.requestUpstream("tools/call", m.params); }
    catch (e) {
      this.state.audit({ ...base, outcome: "upstream_error", approved_by: approvedBy, error: e.message });
      return this.replyError(m.id, e.rpc || { code: -32603, message: e.message });
    }
    const text = JSON.stringify(result?.content || "");
    const preview = !!(this.profile?.preview?.result_marker && text.includes(this.profile.preview.result_marker));
    const executed = d.counts && !result?.isError && !preview;
    if (executed) this.state.recordExecuted(d.order?.value);
    this.state.audit({ ...base, outcome: result?.isError ? "upstream_rejected" : preview ? "preview" : "executed", approved_by: approvedBy, counted: executed });
    this.reply(m.id, result);
  }
}

export { VERSION };
