// Telegram approvals and phone controls, using your own bot (create one with @BotFather).
// Approve / Deny buttons for held actions, alerts, and /kill /resume /status /pending from your phone.
// Decisions go through the shared state files, so several guards (and the CLI) can share one bot.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramApprover {
  /**
   * @param {{bot_token:string, chat_id:string|number, api_base?:string, wait_seconds?:number, notify_blocked?:boolean, notify_executed?:boolean}} cfg
   * @param {import('./state.js').State} state
   * @param {(s:string)=>void} log
   * @param {() => object} statusFn  returns the guard's status object for /status
   */
  constructor(cfg, state, log, statusFn) {
    if (!cfg?.bot_token || !cfg?.chat_id) throw new Error("approvals.telegram needs bot_token and chat_id (run: npx tas-guard telegram-setup)");
    this.token = String(cfg.bot_token);
    this.chatId = String(cfg.chat_id);
    this.base = (cfg.api_base || "https://api.telegram.org").replace(/\/$/, "");
    this.waitMs = (cfg.wait_seconds ?? 45) * 1000; // stay under typical MCP client tool-call timeouts
    this.notifyBlocked = cfg.notify_blocked !== false;
    this.notifyExecuted = cfg.notify_executed === true;
    this.state = state;
    this.log = log;
    this.statusFn = statusFn;
    this.sent = new Map(); // approval id -> telegram message id
    this.offset = 0;
    this.stopped = false;
  }

  async api(method, body = {}, timeoutMs = 15_000) {
    const r = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Object.assign(new Error(`telegram ${method}: ${j.description || r.status}`), { status: j.error_code || r.status });
    return j.result;
  }

  async send(text, keyboard) {
    const m = await this.api("sendMessage", { chat_id: this.chatId, text: text.slice(0, 4000), ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
    return m.message_id;
  }

  async notify(text) {
    try { await this.send(text); } catch (e) { this.log("telegram notify failed: " + e.message); }
  }

  /** Send Approve / Deny buttons for a pending approval. */
  async ask(item, mode) {
    const text = `🛡 TAS Guard (${mode}): approval needed\n\n${item.summary}\n\nWhy: ${item.reason}\nGuard: ${item.guard} · request ${item.id}`;
    const msgId = await this.send(text, [[{ text: "✅ Approve", callback_data: `tg|${item.id}|a` }, { text: "❌ Deny", callback_data: `tg|${item.id}|d` }]]);
    this.sent.set(item.id, { msgId, text });
  }

  /** Wait (up to wait_seconds) for this approval to be decided by phone or CLI. Returns 'approved' | 'denied' | 'pending'. */
  async waitFor(id) {
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline && !this.stopped) {
      const item = this.state.pending().items.find((i) => i.id === id);
      if (item && item.status !== "pending") return item.status === "denied" ? "denied" : "approved";
      await sleep(400);
    }
    return "pending";
  }

  /** Long-poll Telegram for button taps and commands. Only one process can poll a bot at a time;
   *  others get 409 Conflict and simply rely on the shared state file. */
  async run() {
    while (!this.stopped) {
      let updates = [];
      try {
        updates = await this.api("getUpdates", { offset: this.offset, timeout: 20, allowed_updates: ["callback_query", "message"] }, 30_000);
      } catch (e) {
        if (this.stopped) break;
        if (e.status !== 409) this.log("telegram poll: " + e.message);
        await sleep(e.status === 409 ? 5000 : 3000);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        try { await this.handle(u); } catch (e) { this.log("telegram update: " + e.message); }
      }
      await this.refreshMessages();
    }
  }

  stop() { this.stopped = true; }

  fromOwner(u) {
    const from = u.callback_query?.from?.id ?? u.message?.from?.id;
    const chat = u.callback_query?.message?.chat?.id ?? u.message?.chat?.id;
    return String(from) === this.chatId && String(chat) === this.chatId;
  }

  async handle(u) {
    if (!this.fromOwner(u)) {
      if (u.callback_query) await this.api("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: "Not authorized." }).catch(() => {});
      return; // ignore anyone who isn't the configured user, in the configured chat
    }
    if (u.callback_query) {
      const [tag, id, act] = String(u.callback_query.data || "").split("|");
      if (tag !== "tg" || !id) return;
      let text;
      try {
        const it = this.state.decideApproval(id, act === "a", "telegram");
        text = act === "a" ? "Approved" : "Denied";
        this.state.audit({ tool: it.tool, outcome: act === "a" ? "approved" : "denied", approval_id: id, approved_by: "telegram" });
      } catch (e) {
        text = e.message.includes("already") ? "Already decided" : "Request not found";
      }
      await this.api("answerCallbackQuery", { callback_query_id: u.callback_query.id, text }).catch(() => {});
      return;
    }
    const cmd = String(u.message?.text || "").trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
    if (cmd === "/kill") {
      this.state.kill("telegram");
      this.state.audit({ tool: "kill_switch", outcome: "kill_on", approved_by: "telegram" });
      await this.notify("🛑 Kill switch ON. Every guard now blocks new orders. Reads, cancels and closing positions still work.\nSend /resume to turn it off.");
    } else if (cmd === "/resume") {
      this.state.resume();
      this.state.audit({ tool: "kill_switch", outcome: "kill_off", approved_by: "telegram" });
      await this.notify("▶️ Kill switch off.");
    } else if (cmd === "/status") {
      const s = this.statusFn();
      await this.notify(`🛡 ${s.guard} (${s.mode})\nKill switch: ${s.kill_switch ? "ON" : "off"}\nToday: ${s.today.value_used} used, ${s.today.value_left} left · ${s.today.orders} orders, ${s.today.orders_left} left\nLimits: ${s.limits.max_order_value}/order, ${s.limits.max_daily_value}/day, approval over ${s.limits.approve_over}\nPending approvals: ${s.pending_approvals.length}`);
    } else if (cmd === "/pending") {
      const items = this.state.pending().items.filter((i) => i.status === "pending");
      if (!items.length) await this.notify("Nothing is waiting for approval.");
      for (const i of items.slice(0, 5)) {
        await this.send(`⏳ ${i.summary}\nWhy: ${i.reason}\nGuard: ${i.guard} · request ${i.id}`, [[{ text: "✅ Approve", callback_data: `tg|${i.id}|a` }, { text: "❌ Deny", callback_data: `tg|${i.id}|d` }]]).catch(() => {});
      }
    } else if (cmd === "/start" || cmd === "/help") {
      await this.notify("TAS Guard controls:\n/status: limits and today's usage\n/pending: actions waiting for you\n/kill: stop all new orders\n/resume: turn the kill switch off");
    }
  }

  /** Replace the buttons on decided or expired requests with the outcome. */
  async refreshMessages() {
    if (!this.sent.size) return;
    const items = new Map(this.state.pending().items.map((i) => [i.id, i]));
    for (const [id, { msgId, text }] of this.sent) {
      const it = items.get(id);
      const st = !it ? "expired" : it.status;
      if (st === "pending") continue;
      const label = { approved: "✅ Approved", used: "✅ Approved and sent", denied: "❌ Denied", expired: "⌛ Expired" }[st] || st;
      const by = it?.decided_by ? ` (via ${it.decided_by === "cli" ? "CLI" : it.decided_by})` : "";
      await this.api("editMessageText", { chat_id: this.chatId, message_id: msgId, text: `${text}\n\n${label}${by}` }).catch(() => {});
      if (st !== "approved") this.sent.delete(id); // keep 'approved' until it's used so the label can update once more
    }
  }
}

/** One-off helper for `tas-guard telegram-setup`: wait for the user to message the bot and return their chat id. */
export async function findChatId(token, apiBase = "https://api.telegram.org", timeoutMs = 120_000) {
  const base = apiBase.replace(/\/$/, "");
  const call = async (method, body) => {
    const r = await fetch(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(35_000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || "HTTP " + r.status);
    return j.result;
  };
  const me = await call("getMe");
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    const ups = await call("getUpdates", { offset, timeout: 20, allowed_updates: ["message"] });
    for (const u of ups) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.chat?.type === "private" && m.from?.id) {
        await call("getUpdates", { offset, timeout: 0 }); // acknowledge
        await call("sendMessage", { chat_id: m.chat.id, text: "✅ TAS Guard is linked to this chat. You'll get approval requests and alerts here." });
        return { bot: me.username, chat_id: String(m.chat.id), name: m.from.first_name || "" };
      }
    }
  }
  throw new Error(`No message received. Open t.me/${me.username}, press Start, and run this again.`);
}
