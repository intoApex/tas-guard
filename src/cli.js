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
import { RpcGuard } from "./rpc.js";
import { resolveOnchainPolicy } from "./onchain-policy.js";
import { startMockEvm, DEMO_REVERT_CONTRACT } from "./demo-evm.js";
import { SolRpcGuard } from "./sol-rpc.js";
import { resolveSolanaPolicy } from "./solana-policy.js";
import { runSolDemo } from "./sol-demo.js";
import { HlServer, HL_PROFILE, approveFee } from "./hyperliquid.js";
import { feePercent } from "./hl-fee.js";

const HELP = `TAS Guard ${VERSION}: trading-aware safety proxy for AI agents using broker and exchange MCP servers.

Run (your MCP client starts this):
  tas-guard run --config guard.json
  tas-guard run --profile alpaca-mcp-server [--policy policy.json] [--name alpaca] -- <upstream command> [args...]

Try it with no broker account (built-in paper broker, simulated prices):
  tas-guard demo                 add this as an MCP server in your AI app, then ask it to trade

Onchain (EVM) mode: a local JSON-RPC proxy your agent uses as its RPC URL:
  tas-guard rpc --config guard.json [--listen 127.0.0.1:8547]
  tas-guard rpc-demo [--port 8547]   the same, in front of a built-in mock chain (no keys, no money)

Solana mode: the same idea for Solana agents (simulates every transaction before it is sent):
  tas-guard sol-rpc --config guard.json [--listen 127.0.0.1:8890]
  tas-guard sol-demo             watch it handle 7 agent transactions on a mock chain (no keys, no money)
  tas-guard init solana          print a starter guard.json for Solana

Hyperliquid mode: trade Hyperliquid directly through the same limits, approvals and kill switch:
  tas-guard hl [--testnet] [--config guard.json]
                                 your MCP client starts this; needs HL_ACCOUNT (your main address) and
                                 HL_API_PRIVATE_KEY (an API wallet: it can trade, it can't withdraw)
  tas-guard hl approve-fee [--testnet] [--yes]
                                 approve the ${feePercent()} builder fee once (reads HL_MAIN_PRIVATE_KEY for this
                                 command only). Or turn the fee off with TAS_GUARD_HL_BUILDER_FEE=0
  tas-guard init hyperliquid     print a starter guard.json for Hyperliquid

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

// `tas-guard rpc`: the onchain (EVM) guard, an HTTP JSON-RPC proxy in front of your upstream RPC.
function parseListen(s, portFlag) {
  const m = String(s).match(/^(.*):(\d+)$/);
  const host = m ? m[1].replace(/^\[|\]$/g, "") : "127.0.0.1";
  const port = portFlag !== undefined ? Number(portFlag) : m ? Number(m[2]) : 8547;
  return [host || "127.0.0.1", port];
}
function serveUntilSignal(guard) {
  const stop = () => guard.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
async function cmdRpc(argv) {
  const cfgPath = flag(argv, "--config");
  if (!cfgPath) throw new Error("Usage: tas-guard rpc --config guard.json");
  const path = resolve(cfgPath);
  const cfg = expandEnv(readJson(path));
  if (!cfg.upstream_rpc) throw new Error(`${path}: "upstream_rpc" is required (your RPC provider URL; use \${VAR} for the API key)`);
  const policy = resolveOnchainPolicy(cfg.onchain || {});
  const state = new State(cfg.state_dir ? resolve(dirname(path), cfg.state_dir) : defaultStateDir(), cfg.name || "evm");
  const guard = new RpcGuard({ upstream: cfg.upstream_rpc, headers: cfg.upstream_headers || {}, wallets: cfg.wallets, policy, state, approvals: cfg.approvals || {} });
  const [host, port] = parseListen(flag(argv, "--listen", cfg.listen || "127.0.0.1:8547"), flag(argv, "--port"));
  await guard.listen(host, port);
  serveUntilSignal(guard);
}

// `tas-guard sol-rpc`: the Solana guard, an HTTP JSON-RPC (+ WebSocket) proxy in front of your upstream RPC.
async function cmdSolRpc(argv) {
  const cfgPath = flag(argv, "--config");
  if (!cfgPath) throw new Error("Usage: tas-guard sol-rpc --config guard.json");
  const path = resolve(cfgPath);
  const cfg = expandEnv(readJson(path));
  if (!cfg.upstream_rpc) throw new Error(`${path}: "upstream_rpc" is required (your Solana RPC URL; use \${VAR} for the API key)`);
  const policy = resolveSolanaPolicy(cfg.solana || {});
  const state = new State(cfg.state_dir ? resolve(dirname(path), cfg.state_dir) : defaultStateDir(), cfg.name || "solana");
  const guard = new SolRpcGuard({ upstream: cfg.upstream_rpc, upstreamWs: cfg.upstream_ws, headers: cfg.upstream_headers || {}, wallets: cfg.wallets, policy, state, approvals: cfg.approvals || {} });
  const [host, port] = parseListen(flag(argv, "--listen", cfg.listen || "127.0.0.1:8890"), flag(argv, "--port"));
  await guard.listen(host, port);
  serveUntilSignal(guard);
}

// `tas-guard hl`: Hyperliquid mode, a stdio MCP server that trades Hyperliquid's API directly (no upstream server).
const HL_CONFIG_KEYS = new Set(["$schema", "name", "testnet", "account", "policy", "approvals", "state_dir"]);
async function cmdHl(argv) {
  if (argv[0] === "approve-fee") {
    await approveFee({ testnet: argv.includes("--testnet"), yes: argv.includes("--yes") });
    return;
  }
  const cfgPath = flag(argv, "--config");
  const path = cfgPath ? resolve(cfgPath) : null;
  const cfg = path ? expandEnv(readJson(path)) : {};
  const unknown = Object.keys(cfg).filter((k) => !HL_CONFIG_KEYS.has(k));
  if (unknown.length) throw new Error(`${path}: unknown setting(s) ${unknown.join(", ")}. Allowed: ${[...HL_CONFIG_KEYS].filter((k) => k !== "$schema").join(", ")}. Keys never go in this file: use the HL_API_PRIVATE_KEY environment variable.`);
  const testnet = argv.includes("--testnet") || cfg.testnet === true;
  const account = process.env.HL_ACCOUNT || cfg.account;
  if (!account) throw new Error("Set HL_ACCOUNT to your Hyperliquid account's main address (the one you deposit to).");
  if (!process.env.HL_API_PRIVATE_KEY) throw new Error("Set HL_API_PRIVATE_KEY to the private key of a Hyperliquid API wallet. Create one at https://app.hyperliquid.xyz/API: it can trade but can't withdraw.");
  const policy = resolvePolicy(cfg.policy || {});
  const name = cfg.name || (testnet ? "hyperliquid-testnet" : "hyperliquid");
  const state = new State(cfg.state_dir ? resolve(dirname(path), cfg.state_dir) : defaultStateDir(), name);
  const log = (s) => process.stderr.write("[tas-guard] " + s + "\n");
  const server = new HlServer({ account, apiKey: process.env.HL_API_PRIVATE_KEY, testnet, version: VERSION, log });
  const proxy = new GuardProxy({ profile: HL_PROFILE, policy, state, local: server, mode: testnet ? "testnet" : "live", approvals: cfg.approvals || {}, log });
  proxy.onClosed = () => process.exit(0);
  server.startup();
}
export const HL_STARTER = {
  name: "hyperliquid",
  testnet: false,
  policy: { max_order_value: 200, max_daily_value: 1000, approve_over: 100, max_orders_per_minute: 3, max_orders_per_day: 20, symbols_allow: ["BTC", "ETH", "SOL"], live_requires_approval: false },
  approvals: {},
};

// `tas-guard rpc-demo`: the onchain guard in front of a built-in mock chain (Base, chain id 8453).
export const DEMO_WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // well-known public test account (Hardhat #0)
const DEMO_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DEMO_FRIEND = "0x1111111111111111111111111111111111111111";
export const DEMO_ONCHAIN = {
  chains_allow: [8453], native_usd: { 8453: 3000 },
  tokens: { [DEMO_USDC]: { symbol: "USDC", decimals: 6, usd_price: "stable" } },
  max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 25, max_tx_per_minute: 10,
  recipients_allow: [DEMO_FRIEND], contracts_allow: [DEMO_REVERT_CONTRACT],
};
async function cmdRpcDemo(argv) {
  const chain = await startMockEvm({ chainId: 8453, rawSender: DEMO_WALLET });
  const state = new State(defaultStateDir(), "evm-demo");
  const guard = new RpcGuard({ upstream: chain.url, wallets: [DEMO_WALLET], policy: resolveOnchainPolicy(DEMO_ONCHAIN), state });
  const url = await guard.listen("127.0.0.1", Number(flag(argv, "--port", 8547)));
  const word = (h) => h.replace(/^0x/, "").padStart(64, "0");
  const req = (method, params) => `curl -s ${url} -H 'content-type: application/json' -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}'`;
  const tx = (to, value, data) => [{ from: DEMO_WALLET, to, ...(value ? { value } : {}), ...(data ? { data } : {}) }];
  process.stderr.write(`[tas-guard] rpc-demo: guarding a mock Base chain (no keys, no real money). Point any EVM agent at ${url}
  Limits: $100 per transaction, $300 per day, approval over $25, ETH = $3,000, USDC is a known stablecoin. Wallet: ${DEMO_WALLET}

  Try these in another terminal:
  1. Allowed: send 0.005 ETH ($15) to a known address
     ${req("eth_sendTransaction", tx(DEMO_FRIEND, "0x11c37937e08000"))}
  2. Held for you: send 30 USDC to a new address (then run: npx tas-guard approve <id>)
     ${req("eth_sendTransaction", tx(DEMO_USDC, null, "0xa9059cbb" + word("2222222222222222222222222222222222222222") + word((30_000_000).toString(16))))}
  3. Blocked: unlimited USDC approval
     ${req("eth_sendTransaction", tx(DEMO_USDC, null, "0x095ea7b3" + word("3333333333333333333333333333333333333333") + "f".repeat(64)))}
  4. Blocked by the pre-flight revert check: a call that reverts
     ${req("eth_sendTransaction", tx(DEMO_REVERT_CONTRACT, null, "0xd0e30db0"))}
  5. Reads pass straight through:
     ${req("eth_blockNumber", [])}
  6. What the agent is working under:
     ${req("tas_guardStatus", [])}
`);
  serveUntilSignal({ close: async () => { await guard.close(); await chain.close(); } });
}

const state = (argv) => new State(defaultStateDir(), flag(argv, "--name", "default"));

const commands = {
  run: cmdRun,
  demo: cmdDemo,
  rpc: cmdRpc,
  "rpc-demo": cmdRpcDemo,
  "sol-rpc": cmdSolRpc,
  "sol-demo": () => runSolDemo(),
  hl: cmdHl,
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
    if (slug === "hyperliquid") return console.log(JSON.stringify(HL_STARTER, null, 2));
    if (slug === "solana") {
      return console.log(JSON.stringify({
        name: "solana", upstream_rpc: "https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}", listen: "127.0.0.1:8890",
        wallets: ["<your agent's wallet address>"],
        solana: { clusters_allow: ["mainnet"], sol_usd: 150, max_tx_usd: 50, max_daily_usd: 200, approve_over_usd: 25, max_fee_sol: 0.005, programs_allow: ["jupiter", "pumpfun", "pumpswap"], program_caps: { pumpfun: { max_tx_usd: 20, max_daily_usd: 100 } }, recipients_allow: [] },
        approvals: {},
      }, null, 2));
    }
    const p = slug ? loadProfile(slug) : null;
    if (!p) throw new Error(`Usage: tas-guard init <profile>. Profiles: ${listBuiltinProfiles().join(", ")}, or "solana" or "hyperliquid"`);
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
