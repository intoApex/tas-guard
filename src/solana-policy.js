// Pure decision engine for the Solana guard: given a decoded transaction (plus what a simulation and
// the accounts it touches show), the policy and today's usage, decide allow / approve / block.
// Same model as the other guards: hard limits block and can't be approved past; soft rules ask a human.
import { isPubkey, PROGRAM_PRESETS, JITO_TIP_ACCOUNTS, CORE_PROGRAMS, STABLES, WSOL, U64_MAX, SYSTEM, TOKEN, TOKEN_2022, programName, short } from "./solana.js";
import { usd } from "./onchain-policy.js";

export const DEFAULT_SOLANA = {
  clusters_allow: [],           // "mainnet" | "devnet" | "testnet"; empty = any
  sol_usd: null,                // USD price of SOL, used to value SOL (and wrapped SOL) leaving the wallet
  tokens: {},                   // { "<mint>": { symbol?, usd_price: number | "stable" } }; USDC/USDT are built in
  // Hard limits (approval can't override them). In USD.
  max_tx_usd: 100,
  max_daily_usd: 500,
  max_tx_per_minute: 3,
  max_tx_per_day: 20,
  max_fee_sol: 0.01,            // network + priority fee per transaction
  program_caps: {},             // { "<program id or preset>": { max_tx_usd?, max_daily_usd? } }
  addresses_block: [],          // any of these anywhere in a transaction blocks it
  // Soft limit: above this a human approves.
  approve_over_usd: 50,
  unknown_value: "approve",     // something leaves the wallet that can't be priced
  programs_allow: [],           // program ids or presets: jupiter, pumpfun, pumpswap, raydium, orca, meteora
  unknown_program: "approve",
  recipients_allow: [],         // known recipients of direct SOL and token transfers (your own wallets always count)
  jito_tips: true,              // Jito tip accounts count as known recipients
  new_recipient: "approve",
  token_delegation: "approve",  // SPL approve: someone else may spend from your token account
  unlimited_delegation: "block",// approve for the maximum amount (u64 max)
  owner_change: "block",        // your wallet or token account handed to another owner/program
  close_authority_change: "approve",
  unsupported_methods: "block", // other sending methods (sendBundle, ...)
  simulate: true,               // simulate every transaction: blocks ones that would fail and measures what leaves the wallet
  approval_ttl_minutes: 15,
};

const ACTION_KEYS = ["unknown_value", "unknown_program", "new_recipient", "token_delegation", "unlimited_delegation", "owner_change", "close_authority_change", "unsupported_methods"];
const NUM_KEYS = ["max_tx_usd", "max_daily_usd", "max_tx_per_minute", "max_tx_per_day", "max_fee_sol", "approve_over_usd", "approval_ttl_minutes"];
const CLUSTER_NAMES = ["mainnet", "devnet", "testnet", "localnet"];

const programIds = (entry, key) => {
  if (PROGRAM_PRESETS[entry]) return PROGRAM_PRESETS[entry];
  if (isPubkey(entry)) return [entry];
  throw new Error(`solana.${key}: '${entry}' is not a program id or a preset (${Object.keys(PROGRAM_PRESETS).join(", ")})`);
};
const keyList = (list, key) => (list || []).map((a) => { if (!isPubkey(a)) throw new Error(`solana.${key}: '${a}' is not a Solana address`); return a; });

export function resolveSolanaPolicy(user = {}) {
  for (const k of Object.keys(user)) if (!(k in DEFAULT_SOLANA) && !/^[$_]/.test(k)) throw new Error(`solana.${k} is not a known setting (typo?). Known: ${Object.keys(DEFAULT_SOLANA).join(", ")}`);
  const p = { ...DEFAULT_SOLANA, ...user };
  for (const k of ACTION_KEYS) if (!["allow", "approve", "block"].includes(p[k])) throw new Error(`solana.${k} must be allow, approve or block (got '${p[k]}')`);
  for (const k of NUM_KEYS) if (typeof p[k] !== "number" || !(p[k] >= 0)) throw new Error(`solana.${k} must be a non-negative number`);
  if (p.sol_usd !== null && !(typeof p.sol_usd === "number" && p.sol_usd > 0)) throw new Error("solana.sol_usd must be a positive number (the USD price of SOL)");
  p.clusters_allow = (p.clusters_allow || []).map((c) => { if (!CLUSTER_NAMES.includes(c)) throw new Error(`solana.clusters_allow: '${c}' must be one of ${CLUSTER_NAMES.join(", ")}`); return c; });
  p.programs = new Set((p.programs_allow || []).flatMap((e) => programIds(e, "programs_allow")));
  p.recipients = new Set([...keyList(p.recipients_allow, "recipients_allow"), ...(p.jito_tips ? JITO_TIP_ACCOUNTS : [])]);
  p.blocked = new Set(keyList(p.addresses_block, "addresses_block"));
  p.caps = Object.entries(p.program_caps || {}).map(([name, c]) => {
    for (const k of Object.keys(c || {})) if (!["max_tx_usd", "max_daily_usd"].includes(k)) throw new Error(`solana.program_caps.${name}.${k}: use max_tx_usd and/or max_daily_usd`);
    for (const k of ["max_tx_usd", "max_daily_usd"]) if (c[k] !== undefined && !(typeof c[k] === "number" && c[k] >= 0)) throw new Error(`solana.program_caps.${name}.${k} must be a non-negative number`);
    return { name, ids: new Set(programIds(name, "program_caps")), max_tx_usd: c.max_tx_usd, max_daily_usd: c.max_daily_usd };
  });
  const tokens = {};
  for (const [mint, t] of Object.entries(p.tokens || {})) {
    if (!isPubkey(mint)) throw new Error(`solana.tokens: '${mint}' is not a mint address`);
    if (t?.usd_price !== "stable" && !(typeof t?.usd_price === "number" && t.usd_price >= 0)) throw new Error(`solana.tokens.${mint}: usd_price must be a number or "stable"`);
    tokens[mint] = { symbol: t.symbol || short(mint), usd_price: t.usd_price === "stable" ? 1 : t.usd_price };
  }
  for (const [mint, sym] of Object.entries(STABLES)) if (!tokens[mint]) tokens[mint] = { symbol: sym, usd_price: 1 };
  p.tokenInfo = tokens;
  return p;
}

// ---------- valuation ----------
export const sol = (lamports) => Number(lamports) / 1e9;
const fmtAmount = (n) => (n === 0 ? "0" : n >= 1e6 ? n.toExponential(3).replace("e+", "e") : String(Number(n.toPrecision(6))));
export const symbolOf = (policy, mint) => (mint === WSOL ? "wSOL" : policy.tokenInfo[mint]?.symbol || `tokens of ${short(mint)}`);
/** USD of `amount` (raw units) of `mint`; undefined if it can't be priced. */
export function tokenUsd(policy, mint, amount, decimals) {
  if (mint === WSOL) return policy.sol_usd ? sol(amount) * policy.sol_usd : undefined;
  const t = policy.tokenInfo[mint];
  if (!t || decimals === undefined || decimals === null) return undefined;
  return (Number(amount) / 10 ** decimals) * t.usd_price;
}
export const solUsd = (policy, lamports) => (policy.sol_usd ? sol(lamports) * policy.sol_usd : undefined);
export const fmtToken = (policy, mint, amount, decimals) => (decimals === undefined || decimals === null ? `${amount} raw units of ${symbolOf(policy, mint)}` : `${fmtAmount(Number(amount) / 10 ** decimals)} ${symbolOf(policy, mint)}`);

/**
 * What leaves the agent's wallets. With a simulation: measured from the accounts' before/after state.
 * Without: the decoded SOL and token transfers signed by a wallet; other programs make the value unknown.
 * @returns {{usd:number|undefined, unpriced:string[], parts:string[]}}
 */
export function outflow(op, policy, wallets) {
  const parts = [], unpriced = [];
  let total = 0;
  const addSol = (lamports) => {
    if (lamports <= 0n) return;
    parts.push(`${fmtAmount(sol(lamports))} SOL`);
    const v = solUsd(policy, lamports);
    if (v === undefined) unpriced.push("SOL (set solana.sol_usd)"); else total += v;
  };
  const addToken = (mint, amount, decimals) => {
    if (amount <= 0n) return;
    parts.push(fmtToken(policy, mint, amount, decimals));
    const v = tokenUsd(policy, mint, amount, decimals);
    if (v === undefined) unpriced.push(symbolOf(policy, mint)); else total += v;
  };
  if (op.sim) {
    addSol(op.sim.solOut);
    for (const t of op.sim.tokens) addToken(t.mint, t.out, t.decimals);
  } else {
    let lamports = 0n;
    for (const i of op.instructions) {
      if (i.programId === SYSTEM && ["transfer", "transferWithSeed", "createAccount"].includes(i.type) && wallets.has(i.from) && !wallets.has(i.to ?? "")) lamports += i.lamports;
      if ((i.programId === TOKEN || i.programId === TOKEN_2022) && i.type === "transfer" && wallets.has(i.authority)) {
        const src = op.pre?.tokenAccounts?.[i.source];
        const mint = i.mint || src?.mint;
        if (!mint) { unpriced.push(`tokens from ${short(i.source)}`); continue; }
        addToken(mint, i.amount, i.decimals ?? op.pre?.mints?.[mint]);
      }
    }
    addSol(lamports);
    const other = [...new Set(op.instructions.filter((i) => !CORE_PROGRAMS.has(i.programId)).map((i) => i.program))];
    if (other.length) unpriced.push(`whatever ${other.join(", ")} moves (simulation is off)`);
  }
  return { usd: unpriced.length && !parts.length ? undefined : total, unpriced, parts };
}

// ---------- the decision ----------
/**
 * @param {object} o
 * @param {object} o.op      decoded request (see sol-rpc.js)
 * @param {object} o.policy  resolved Solana policy
 * @param {{spent:number, orders:number, recent:number[], buckets?:Record<string,number>}} o.usage
 * @param {Set<string>} o.wallets
 * @returns {{action:'allow'|'approve'|'block', reason:string, usd?:number, spend?:number, buckets?:Record<string,number>, counts:boolean}}
 */
export function decideSolana({ op, policy, usage = {}, wallets = new Set(), killed = false, now = Date.now() }) {
  const counts = op.kind === "sol_tx";
  const out = (action, reason, extra = {}) => ({ action, reason, counts, ...extra });
  if (killed) return out("block", "Kill switch is on: every transaction is blocked. Reads still work.");
  if (op.error) return out("block", op.error);
  if (op.kind === "unsupported") return act(policy.unsupported_methods, `'${op.method}' sends transactions, and TAS Guard can't check it.`, out);
  if (op.kind !== "sol_tx") return out("block", "Couldn't read this request.");

  if (!op.signers.some((s) => wallets.has(s))) return out("block", `Not signed by a configured wallet (signers: ${op.signers.map(short).join(", ")}).`);
  if (policy.clusters_allow.length && !policy.clusters_allow.includes(op.cluster)) return out("block", `Cluster ${op.cluster || "unknown"} is not on clusters_allow (${policy.clusters_allow.join(", ")}).`);
  const bad = op.keys.find((k) => policy.blocked.has(k));
  if (bad) return out("block", `The transaction touches ${bad}, which is on the block list.`);

  const recent = (usage.recent || []).filter((t) => now - t < 60_000).length;
  if (recent >= policy.max_tx_per_minute) return out("block", `Rate limit: ${policy.max_tx_per_minute} transactions per minute.`);
  if ((usage.orders || 0) + 1 > policy.max_tx_per_day) return out("block", `Daily transaction limit reached (${policy.max_tx_per_day}).`);
  if (sol(op.fee.lamports) > policy.max_fee_sol) return out("block", `Fee of ${fmtAmount(sol(op.fee.lamports))} SOL is over max_fee_sol (${policy.max_fee_sol} SOL). Priority fee: ${op.fee.microLamports} micro-lamports × ${op.fee.units} units.`);

  const flags = [];
  const flag = (a, r) => { if (a !== "allow" && !flags.some(([, x]) => x === r)) flags.push([a, r]); };
  const known = (who) => wallets.has(who) || policy.recipients.has(who);

  // Instructions the transaction itself contains
  const delegated = new Set();
  const checkDelegation = (account, mint, delegate, amount, decimals) => {
    delegated.add(account);
    if (amount === 0n) return null;
    if (amount === U64_MAX) {
      const a = act(policy.unlimited_delegation, `Unlimited token delegation to ${short(delegate)}.`, out);
      if (a.action === "block") return a;
      flag(a.action, a.reason);
    }
    const v = amount === U64_MAX ? Infinity : mint ? tokenUsd(policy, mint, amount, decimals) : undefined;
    if (v !== undefined && Number.isFinite(v) && v > policy.max_tx_usd) return out("block", `Token delegation worth ${usd(v)} is over the per-transaction limit of ${usd(policy.max_tx_usd)}.`, { usd: v });
    flag(policy.token_delegation, `Lets ${short(delegate)} spend ${amount === U64_MAX ? "all" : mint ? fmtToken(policy, mint, amount, decimals) : `${amount} units`} from your token account.`);
    if (v === undefined) flag(policy.unknown_value, `The delegated ${mint ? symbolOf(policy, mint) : "token"} can't be priced.`);
    return null;
  };
  for (const i of op.instructions) {
    if (i.programId === SYSTEM && (i.type === "assign" || i.type === "assignWithSeed") && wallets.has(i.account)) {
      const a = act(policy.owner_change, `Hands your wallet ${short(i.account)} over to program ${i.owner ? short(i.owner) : "(with seed)"}. That gives the program control of the wallet.`, out);
      if (a.action === "block") return a;
      flag(a.action, a.reason);
    }
    if ((i.programId === TOKEN || i.programId === TOKEN_2022) && wallets.has(i.authority)) {
      if (i.type === "setAuthority" && i.authorityType === "accountOwner" && !wallets.has(i.newAuthority)) {
        const a = act(policy.owner_change, `Gives ownership of your token account ${short(i.account)} to ${i.newAuthority ? short(i.newAuthority) : "nobody"}.`, out);
        if (a.action === "block") return a;
        flag(a.action, a.reason);
      }
      if (i.type === "setAuthority" && i.authorityType === "closeAccount" && i.newAuthority && !wallets.has(i.newAuthority)) flag(policy.close_authority_change, `Lets ${short(i.newAuthority)} close your token account ${short(i.account)}.`);
      if (i.type === "approve") {
        const mint = i.mint || op.pre?.tokenAccounts?.[i.source]?.mint;
        const r = checkDelegation(i.source, mint, i.delegate, i.amount, i.decimals ?? op.pre?.mints?.[mint]);
        if (r) return r;
      }
      if (i.type === "transfer") {
        const owner = op.pre?.tokenAccounts?.[i.destination]?.owner || op.created?.[i.destination] || op.sim?.owners?.[i.destination];
        const who = owner || i.destination;
        if (!known(who)) flag(policy.new_recipient, `Token recipient ${short(who)}${owner ? "" : " (account owner unknown)"} is not on recipients_allow.`);
      }
      if (i.type === "closeAccount" && !known(i.destination)) flag(policy.new_recipient, `Closing ${short(i.account)} sends its SOL to ${short(i.destination)}, which is not on recipients_allow.`);
    }
    if (i.programId === SYSTEM && ["transfer", "transferWithSeed", "withdrawNonce"].includes(i.type) && (wallets.has(i.from) || i.type === "withdrawNonce") && !known(i.to)) {
      flag(policy.new_recipient, `SOL recipient ${short(i.to)} is not on recipients_allow.`);
    }
  }
  const unknownPrograms = [...new Set(op.instructions.map((i) => i.programId).filter((p) => !CORE_PROGRAMS.has(p) && !policy.programs.has(p)))];
  if (unknownPrograms.length) flag(policy.unknown_program, `Calls ${unknownPrograms.length === 1 ? "program" : "programs"} not on programs_allow: ${unknownPrograms.map(programName).join(", ")}.`);

  // What the simulation shows (this catches changes made inside other programs too)
  if (op.sim) {
    if (op.sim.err) return out("block", `Simulation: the transaction would fail (${op.sim.err}).`);
    for (const c of op.sim.ownerChanges) {
      const a = act(policy.owner_change, c, out);
      if (a.action === "block") return a;
      flag(a.action, a.reason);
    }
    for (const d of op.sim.delegations) {
      if (delegated.has(d.account)) continue;
      const r = checkDelegation(d.account, d.mint, d.delegate, d.amount, d.decimals);
      if (r) return r;
    }
    for (const c of op.sim.closeAuthChanges) flag(policy.close_authority_change, c);
  }

  // Value leaving the wallets
  const o = outflow(op, policy, wallets);
  const spend = o.usd;
  if (o.unpriced.length) flag(policy.unknown_value, `Can't price ${o.unpriced.join(", ")}, so the value can't be fully checked.`);
  const touched = new Set([...op.instructions.map((i) => i.programId), ...(op.sim?.innerPrograms || [])]);
  const buckets = {};
  if (spend !== undefined) {
    if (spend > policy.max_tx_usd) return out("block", `Value ${usd(spend)} (${o.parts.join(" + ")}) is over the per-transaction limit of ${usd(policy.max_tx_usd)}.`, { usd: spend, spend });
    if ((usage.spent || 0) + spend > policy.max_daily_usd) return out("block", `Value ${usd(spend)} would take today's total to ${usd((usage.spent || 0) + spend)}, over the daily limit of ${usd(policy.max_daily_usd)}.`, { usd: spend, spend });
    for (const c of policy.caps) {
      if (![...c.ids].some((id) => touched.has(id))) continue;
      buckets[c.name] = spend;
      if (c.max_tx_usd !== undefined && spend > c.max_tx_usd) return out("block", `Value ${usd(spend)} is over the ${c.name} per-transaction cap of ${usd(c.max_tx_usd)}.`, { usd: spend, spend });
      const used = usage.buckets?.[c.name] || 0;
      if (c.max_daily_usd !== undefined && used + spend > c.max_daily_usd) return out("block", `Value ${usd(spend)} would take today's ${c.name} total to ${usd(used + spend)}, over its daily cap of ${usd(c.max_daily_usd)}.`, { usd: spend, spend });
    }
    if (spend > policy.approve_over_usd) flag("approve", `Value ${usd(spend)} is over the approval threshold of ${usd(policy.approve_over_usd)}.`);
  } else {
    for (const c of policy.caps) if ([...c.ids].some((id) => touched.has(id))) flag("approve", `${c.name} has a cap, but this transaction's value can't be measured.`);
  }

  const extra = { usd: spend, spend, buckets };
  const block = flags.find(([a]) => a === "block");
  if (block) return out("block", block[1] + (/Blocked by policy\.$/.test(block[1]) ? "" : " Blocked by policy."), extra);
  const asks = flags.filter(([a]) => a === "approve").map(([, r]) => r);
  if (asks.length) return out("approve", asks.join(" "), extra);
  return out("allow", spend !== undefined ? `Within limits (${usd(spend)}).` : "Allowed by policy.", extra);
}

function act(a, reason, out) {
  if (a === "block") return out("block", reason + " Blocked by policy.");
  if (a === "approve") return out("approve", reason);
  return out("allow", reason);
}

/** One-line human summary for logs, approvals and the agent. */
export function describeSolana(op, policy, wallets = new Set()) {
  if (op.kind === "unsupported") return `${op.method} (not supported by the guard)`;
  if (op.kind !== "sol_tx") return `${op.method} (couldn't decode)`;
  const where = `Solana ${op.cluster || "?"}`;
  const bits = [];
  for (const i of op.instructions) {
    if (i.programId === SYSTEM && i.type === "transfer") bits.push(`send ${fmtAmount(sol(i.lamports))} SOL to ${short(i.to)}`);
    else if ((i.programId === TOKEN || i.programId === TOKEN_2022) && i.type === "transfer") {
      const mint = i.mint || op.pre?.tokenAccounts?.[i.source]?.mint;
      const owner = op.pre?.tokenAccounts?.[i.destination]?.owner || op.created?.[i.destination];
      bits.push(`send ${mint ? fmtToken(policy, mint, i.amount, i.decimals ?? op.pre?.mints?.[mint]) : `${i.amount} token units`} to ${short(owner || i.destination)}`);
    } else if (i.type === "approve") bits.push(`delegate ${i.amount === U64_MAX ? "unlimited" : i.amount} tokens to ${short(i.delegate)}`);
    else if (i.type === "setAuthority") bits.push(`set ${i.authorityType} authority of ${short(i.account)} to ${i.newAuthority ? short(i.newAuthority) : "none"}`);
    else if ((i.type === "assign" || i.type === "assignWithSeed") && wallets.has(i.account)) bits.push(`assign wallet ${short(i.account)} to another program`);
    else if (i.type === "closeAccount") bits.push(`close ${short(i.account)}`);
    else if (!CORE_PROGRAMS.has(i.programId)) bits.push(`${programName(i.programId)} call`);
  }
  const uniq = [...new Set(bits)];
  let s = `${where}: ${uniq.length ? uniq.join("; ") : "transaction"}`;
  if (op.sim) {
    const o = outflow(op, policy, wallets);
    const gets = [];
    if (op.sim.solIn > 0n) gets.push(`${fmtAmount(sol(op.sim.solIn))} SOL`);
    for (const t of op.sim.tokens) if (t.in > 0n) gets.push(fmtToken(policy, t.mint, t.in, t.decimals));
    s += ` | spends ${o.parts.length ? o.parts.join(" + ") : "nothing"}${o.usd !== undefined && o.parts.length ? ` (${usd(o.usd)})` : ""}${gets.length ? `, receives ${gets.join(" + ")}` : ""}`;
  }
  s += ` | fee ${fmtAmount(sol(op.fee.lamports))} SOL`;
  return s;
}
