// In-process fake of the Telegram Bot API, enough for TAS Guard's approval flow.
import { createServer } from "node:http";

export async function startMockTelegram(token = "TESTTOKEN") {
  const s = { sent: [], edits: [], answers: [], queue: [], nextUpdate: 1, nextMsg: 100, waiters: [] };
  const flush = () => { for (const w of s.waiters.splice(0)) w(); };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      const ok = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
      if (!m || m[1] !== token) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" })); }
      const b = body ? JSON.parse(body) : {};
      switch (m[2]) {
        case "getMe": return ok({ id: 1, is_bot: true, username: "tas_test_bot" });
        case "sendMessage": { const id = s.nextMsg++; s.sent.push({ ...b, message_id: id }); flush(); return ok({ message_id: id }); }
        case "editMessageText": s.edits.push(b); flush(); return ok(true);
        case "answerCallbackQuery": s.answers.push(b); return ok(true);
        case "getUpdates": {
          const pick = () => s.queue.filter((u) => u.update_id >= (b.offset || 0));
          if (!pick().length && b.timeout) await new Promise((r) => { s.waiters.push(r); setTimeout(r, Math.min(b.timeout * 1000, 300)); });
          const ups = pick();
          s.queue = s.queue.filter((u) => u.update_id >= (b.offset || 0)); // acknowledged ones drop off
          return ok(ups);
        }
        default: return ok(true);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const push = (u) => { s.queue.push({ update_id: s.nextUpdate++, ...u }); flush(); };
  return {
    base, token, s,
    tap(approvalId, approve, fromId) {
      push({ callback_query: { id: "cb" + s.nextUpdate, data: `tg|${approvalId}|${approve ? "a" : "d"}`, from: { id: fromId }, message: { message_id: 1, chat: { id: fromId } } } });
    },
    say(text, fromId) { push({ message: { message_id: 2, text, from: { id: fromId, first_name: "Owner" }, chat: { id: fromId, type: "private" } } }); },
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const r = pred(s); if (r) return r; await new Promise((x) => setTimeout(x, 30)); }
      throw new Error("mock telegram: condition not met in time. sent=" + JSON.stringify(s.sent.map((m) => m.text)));
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
