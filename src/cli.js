#!/usr/bin/env node
// TAS Guard CLI. `run` is what your MCP client starts; the other commands are for you, the human.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardProxy, VERSION } from "./proxy.js";
import { State, defaultStateDir } from "./state.js";
import { loadProfile, listBuiltinProfiles, PROFILE_DIR } from "./profiles.js";
import { resolvePolicy } from "./policy.js";
import { readJson } from "./profiles.js";
import { findChatId } from "./telegram.js";

const HELP = `TAS Guard ${VERSION}: trading-aware safety proxy for AI agents using broker and exchange MCP servers.

Run (your MCP client starts this):
  tas-guard run --config guard.json
  tas-guard run --profile alpaca-mcp-server [--policy policy.json] [--name alpaca] -- <upstream command> [args...]

Try it with no broker account (built-in paper broker, simulated prices):
  tas-guard demo                 add this as an MCP server in your AI app, then ask it to trade

Human controls (run these yourself; never let the agent run them):
  tas-guard pending              list actions waiting for approval
  tas-guard approve <id>         approve one held action (the agent then repeats the call)
  tas-guard deny <id>            deny one held action
  tas-guard kill [reason]        kill switch: block all new orders on every guard
  tas-guard resume               turn the kill switch off
  tas-guard status [--name n]    limits and today's usage
  tas-guard log [--tail 20]      recent audit log entries
  tas-guard verify-log           check the audit log's hash chain for tampering

Phone approvals (Telegram):
  tas-guard telegram-setup --config guard.json
                                 link your own Telegram bot: approve/deny from your phone,
                                 alerts, and /kill /resume /status /pending

Setup:
  tas-guard profiles             list built-in connector profiles
  tas-guard init <profile>       print a starter guard.json for a profile

State lives in ${defaultStateDir()} (override with TAS_GUARD_HOME).`;

function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/** Replace ${VAR} in config strings with environment values, so secrets can stay out of the file. */
function expandEnv(v) {
  if (typeof v === "string") return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "");
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  return v;
}

function loadRunConfig(argv) {
  const cfgPath = flag(argv, "--config");
  if (cfgPath) {
    const path = resolve(cfgPath);
    const cfg = expandEnv(readJson(path));
    if (!cfg.upstream?.command) throw new Error(`${path}: "upstream.command" is required`);
    return { ...cfg, baseDir: dirname(path) };
  }
  const dd = argv.indexOf("--");
  if (dd < 0 || !argv[dd + 1]) throw new Error("Give --config guard.json, or the upstream command after --");
  const policyPath = flag(argv.slice(0, dd), "--policy");
  return {
    name: flag(argv.slice(0, dd), "--name"),
    profile: flag(argv.slice(0, dd), "--profile", "auto"),
    policy: policyPath ? readJson(resolve(policyPath)) : {},
    upstream: { command: argv[dd + 1], args: argv.slice(dd + 2) },
    baseDir: process.cwd(),
  };
}

function cmdRun(argv) {
  const cfg = loadRunConfig(argv);
  const profile = loadProfile(cfg.profile, cfg.baseDir);
  const policy = resolvePolicy(cfg.policy || {});
  const name = cfg.name || profile?.slug || "default";
  const state = new State(cfg.state_dir ? resolve(cfg.baseDir, cfg.state_dir) : defaultStateDir(), name);
  const proxy = new GuardProxy({ profile, policy, state, approvals: cfg.approvals || {}, upstream: { ...cfg.upstream, cwd: cfg.upstream.cwd ? resolve(cfg.baseDir, cfg.upstream.cwd) : undefined } });
  proxy.onUpstreamExit = (code) => process.exit(code ?? 1);
}

// `tas-guard demo`: the guard in front of a built-in fake paper broker. No broker account needed.
export const DEMO_POLICY = { max_order_value: 2000, max_daily_value: 5000, approve_over: 1000, symbols_allow: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"], live_requires_approval: false };
function cmdDemo(argv) {
  const broker = join(dirname(fileURLToPath(import.meta.url)), "demo-broker.js");
  const profile = loadProfile("alpaca-mcp-server");
  const policy = resolvePolicy(DEMO_POLICY);
  const state = new State(defaultStateDir(), "demo");
  process.stderr.write("[tas-guard] demo: guarding a built-in paper broker (simulated prices, no real money)\n");
  const proxy = new GuardProxy({ profile, policy, state, approvals: {}, upstream: { command: process.execPath, args: [broker], env: { ALPACA_PAPER_TRADE: "true" } } });
  proxy.onUpstreamExit = (code) => process.exit(code ?? 1);
}

const state = (argv) => new State(defaultStateDir(), flag(argv, "--name", "default"));

const commands = {
  run: cmdRun,
  demo: cmdDemo,
  pending() {
    const items = new State().pending().items.filter((i) => i.status === "pending");
    if (!items.length) return console.log("No actions are waiting for approval.");
    for (const i of items) console.log(`${i.id}  [${i.guard}]  ${i.created}\n        ${i.summary}\n        why: ${i.reason}`);
  },
  approve(argv) {
    const id = argv[0];
    if (!id) throw new Error("Usage: tas-guard approve <id>");
    const i = new State().decideApproval(id, true);
    console.log(`Approved ${i.id}: ${i.summary}\nThe agent can now repeat the same call once.`);
  },
  deny(argv) {
    const id = argv[0];
    if (!id) throw new Error("Usage: tas-guard deny <id>");
    const i = new State().decideApproval(id, false);
    console.log(`Denied ${i.id}: ${i.summary}`);
  },
  kill(argv) {
    new State().kill(argv.join(" ") || "manual");
    console.log("Kill switch ON. All guards now block new orders; reads, cancels and closing positions still work.\nTurn it off with: tas-guard resume");
  },
  resume() {
    new State().resume();
    console.log("Kill switch off.");
  },
  status(argv) {
    const s = state(argv);
    const u = s.usage();
    console.log(JSON.stringify({ guard: s.guard, kill_switch: s.killed(), today: u, state_dir: s.dir }, null, 2));
  },
  log(argv) {
    const s = new State();
    if (!existsSync(s.auditPath)) return console.log("The audit log is empty.");
    const n = Number(flag(argv, "--tail", 20));
    const lines = readFileSync(s.auditPath, "utf8").trimEnd().split("\n").slice(-n);
    for (const l of lines) {
      const e = JSON.parse(l);
      const via = { cli: "CLI", "client-prompt": "app prompt", telegram: "Telegram" }[e.approved_by] || e.approved_by;
      const by = e.approved_by ? `  [${e.outcome === "denied" ? "denied" : "approved"} via ${via}]` : e.approval_id ? `  [request ${e.approval_id}]` : "";
      console.log(`${e.ts}  ${e.guard}  ${e.outcome.padEnd(17)} ${e.tool}${e.class ? ` (${e.class})` : ""}  ${e.reason || ""}${by}`);
    }
  },
  "verify-log"() {
    const r = new State().verifyAudit();
    console.log(r.ok ? `Audit log OK: ${r.lines} entries, hash chain intact.` : `Audit log TAMPERED or corrupted at line ${r.broken_at} of ${r.lines}.`);
    if (!r.ok) process.exitCode = 2;
  },
  async "telegram-setup"(argv) {
    const cfgPath = flag(argv, "--config");
    if (!cfgPath) throw new Error("Usage: tas-guard telegram-setup --config guard.json");
    const path = resolve(cfgPath);
    const cfg = readJson(path);
    let token = process.env.TAS_TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.log("1. In Telegram, open @BotFather, send /newbot and follow the steps.\n2. Copy the token it gives you (looks like 123456789:ABC...).");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      token = (await rl.question("Bot token: ")).trim();
      rl.close();
    }
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("That doesn't look like a bot token (expected 123456789:ABC...).");
    console.log("3. Now open your bot in Telegram and press Start (or send it any message). Waiting up to 2 minutes...");
    const r = await findChatId(token, flag(argv, "--api-base", "https://api.telegram.org"));
    cfg.approvals = { ...(cfg.approvals || {}), telegram: { ...(cfg.approvals?.telegram || {}), bot_token: token, chat_id: r.chat_id } };
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log(`Linked @${r.bot} to ${r.name || "your"} chat (${r.chat_id}) and saved it in ${path}.\nRestart your AI app so the guard picks it up. On your phone: /status, /pending, /kill, /resume.`);
  },
  profiles() {
    for (const slug of listBuiltinProfiles()) {
      const p = loadProfile(slug);
      console.log(`${slug.padEnd(22)} ${p.name}, checked ${p.last_checked} against ${p.source}`);
    }
    console.log(`\nFiles: ${PROFILE_DIR}`);
  },
  init(argv) {
    const slug = argv[0];
    const p = slug ? loadProfile(slug) : null;
    if (!p) throw new Error(`Usage: tas-guard init <profile>. Profiles: ${listBuiltinProfiles().join(", ")}`);
    const upstream = {
      "alpaca-mcp-server": { command: "uvx", args: ["alpaca-mcp-server"], env: { ALPACA_API_KEY: "${ALPACA_API_KEY}", ALPACA_SECRET_KEY: "${ALPACA_SECRET_KEY}", ALPACA_PAPER_TRADE: "true" } },
      "ccxt-mcp-server": { command: "npx", args: ["-y", "ccxt-mcp"] },
    }[slug] || { command: "<upstream command>", args: [] };
    console.log(JSON.stringify({ name: slug, profile: slug, upstream, policy: { max_order_value: 500, max_daily_value: 2000, approve_over: 250, symbols_allow: [], live_requires_approval: true } }, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") console.log(HELP);
  else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
  else if (commands[cmd]) await commands[cmd](rest);
  else { console.error(`Unknown command '${cmd}'.\n\n${HELP}`); process.exitCode = 1; }
} catch (e) {
  console.error("tas-guard: " + e.message);
  process.exitCode = 1;
}
