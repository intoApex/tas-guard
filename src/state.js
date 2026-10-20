// On-disk state: daily usage, pending approvals, the kill switch and the audit log.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

export function defaultStateDir() {
  return process.env.TAS_GUARD_HOME || join(homedir(), ".tas-guard");
}

const today = (now = new Date()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, data) {
  const tmp = path + "." + process.pid + "." + randomBytes(3).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Canonical JSON (sorted keys) so the same call always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const SECRET_KEY = /key|secret|token|password|passphrase|signature|private|auth/i;
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && k !== "confirm" ? "[redacted]" : redact(x);
    return o;
  }
  return v;
}

export class State {
  constructor(dir = defaultStateDir(), guardName = "default") {
    this.dir = dir;
    this.guard = guardName;
    mkdirSync(join(dir, "guards"), { recursive: true, mode: 0o700 });
    this.usagePath = join(dir, "guards", guardName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".usage.json");
    this.pendingPath = join(dir, "pending.json");
    this.auditPath = join(dir, "audit.jsonl");
    this.killPath = join(dir, "KILL");
  }

  // --- kill switch (global across guards) ---
  killed() { return existsSync(this.killPath); }
  kill(reason = "manual") { writeFileSync(this.killPath, JSON.stringify({ at: new Date().toISOString(), reason }) + "\n"); }
  resume() { rmSync(this.killPath, { force: true }); }

  // --- daily usage (per guard) ---
  usage(now = Date.now()) {
    const u = readJson(this.usagePath, null);
    if (!u || u.day !== today(now)) return { day: today(now), spent: 0, orders: 0, recent: [] };
    u.recent = (u.recent || []).filter((t) => now - t < 60_000);
    return u;
  }
  recordExecuted(value, now = Date.now()) {
    const u = this.usage(now);
    u.orders += 1;
    if (Number.isFinite(value)) u.spent = Math.round((u.spent + value) * 100) / 100;
    u.recent.push(now);
    writeJson(this.usagePath, u);
    return u;
  }

  // --- approvals (global, so the CLI can find them) ---
  pending() { return readJson(this.pendingPath, { items: [] }); }
  savePending(p) {
    const cutoff = Date.now() - 7 * 864e5; // keep a week of history
    p.items = p.items.filter((i) => Date.parse(i.created) > cutoff);
    writeJson(this.pendingPath, p);
  }
  /** Create (or reuse) a pending approval for this exact call. */
  requestApproval({ fingerprint, tool, summary, reason, cli_allowed = true }) {
    const p = this.pending();
    const existing = p.items.find((i) => i.fingerprint === fingerprint && i.guard === this.guard && i.status === "pending");
    if (existing) return existing;
    const item = { id: randomBytes(3).toString("hex"), guard: this.guard, fingerprint, tool, summary, reason, created: new Date().toISOString(), status: "pending", ...(cli_allowed ? {} : { cli_allowed: false }) };
    p.items.push(item);
    this.savePending(p);
    return item;
  }
  /** If this exact call was approved and not yet used or expired, mark it used and return it. */
  consumeApproval(fingerprint, ttlMinutes) {
    const p = this.pending();
    const now = Date.now();
    const item = p.items.find((i) => i.fingerprint === fingerprint && i.guard === this.guard && i.status === "approved" && now - Date.parse(i.decided_at) < ttlMinutes * 60_000);
    if (!item) return null;
    item.status = "used";
    item.used_at = new Date(now).toISOString();
    this.savePending(p);
    return item;
  }
  decideApproval(id, approve, by = "cli") {
    const p = this.pending();
    const item = p.items.find((i) => i.id === id);
    if (!item) throw new Error(`No approval request with id ${id}`);
    if (item.status !== "pending") throw new Error(`Request ${id} is already ${item.status}`);
    if (by === "cli" && item.cli_allowed === false) throw new Error(`Request ${id} can only be approved or denied from your phone (this guard has "cli": false).`);
    item.status = approve ? "approved" : "denied";
    item.decided_at = new Date().toISOString();
    item.decided_by = by;
    this.savePending(p);
    return item;
  }

  // --- audit log: append-only JSONL, each line chained to the previous line's hash ---
  lastHash() {
    if (!existsSync(this.auditPath)) return "0".repeat(64);
    const lines = readFileSync(this.auditPath, "utf8").trimEnd().split("\n");
    const last = lines[lines.length - 1];
    try { return JSON.parse(last).hash; } catch { return "0".repeat(64); }
  }
  audit(entry) {
    const prev = this.lastHash();
    // Round-trip through JSON so undefined fields are dropped before hashing (verify sees the same object).
    const body = JSON.parse(JSON.stringify({ ts: new Date().toISOString(), guard: this.guard, ...entry, args: entry.args === undefined ? undefined : redact(entry.args), prev }));
    const line = { ...body, hash: sha256(prev + canonical(body)) };
    appendFileSync(this.auditPath, JSON.stringify(line) + "\n", { mode: 0o600 });
    return line;
  }
  /** Verify the hash chain. Returns { ok, lines, broken_at? }. */
  verifyAudit() {
    if (!existsSync(this.auditPath)) return { ok: true, lines: 0 };
    const lines = readFileSync(this.auditPath, "utf8").trimEnd().split("\n").filter(Boolean);
    let prev = "0".repeat(64);
    for (let i = 0; i < lines.length; i++) {
      const { hash, ...body } = JSON.parse(lines[i]);
      if (body.prev !== prev || sha256(prev + canonical(body)) !== hash) return { ok: false, lines: lines.length, broken_at: i + 1 };
      prev = hash;
    }
    return { ok: true, lines: lines.length };
  }
}
