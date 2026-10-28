// Solana helpers for the Solana guard, with no dependencies: base58, the transaction wire format
// (legacy and v0 with address lookup tables), instruction decoders for the core programs, account
// layouts (SPL token accounts and mints), and a small transaction builder used by the demo and tests.
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";

// ---------- base58 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function b58encode(bytes) {
  bytes = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export function b58decode(str) {
  if (typeof str !== "string") throw new Error("base58: expected a string");
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const v = B58_MAP[str[i]];
    if (v === undefined) throw new Error(`base58: bad character '${str[i]}'`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function isPubkey(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

// ---------- well-known programs and accounts ----------
export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const WSOL = "So11111111111111111111111111111111111111112";

/** Programs that only move what their instructions say (decoded below). Always allowed. */
export const CORE_PROGRAMS = new Set([SYSTEM, TOKEN, TOKEN_2022, ATA, COMPUTE_BUDGET, MEMO, MEMO_V1]);

/** Named presets for `programs_allow` and `program_caps`. Sources: each project's own docs (checked Oct 2026). */
export const PROGRAM_PRESETS = {
  jupiter: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  pumpfun: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
  pumpswap: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
  raydium: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"],
  orca: ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
  meteora: ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"],
};

/** Jito tip accounts (from Jito's getTipAccounts). `jito_tips: true` treats them as known recipients. */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

/** Stablecoins priced at $1 by default. */
export const STABLES = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC (devnet)",
};

export const CLUSTERS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

const PROGRAM_NAMES = { [SYSTEM]: "System", [TOKEN]: "Token", [TOKEN_2022]: "Token-2022", [ATA]: "Associated Token", [COMPUTE_BUDGET]: "Compute Budget", [MEMO]: "Memo", [MEMO_V1]: "Memo" };
for (const [name, ids] of Object.entries(PROGRAM_PRESETS)) for (const id of ids) PROGRAM_NAMES[id] = name;
export const programName = (id) => PROGRAM_NAMES[id] || short(id);
export const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));

// ---------- byte reading ----------
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error("transaction is truncated"); }
  u8() { this.need(1); return this.b[this.o++]; }
  bytes(n) { this.need(n); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  key() { return b58encode(this.bytes(32)); }
  shortvec() {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      len |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) return len;
    }
    throw new Error("bad compact-u16 length");
  }
}
const shortvec = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const u64 = (buf, o) => buf.readBigUInt64LE(o);
export const U64_MAX = (1n << 64n) - 1n;

// ---------- transaction wire format ----------
/**
 * Decode a signed transaction (bytes). Lookup-table accounts are left unresolved: see resolveLookups.
 * @returns {{signatures:string[], message:Buffer, version:'legacy'|number, header:object, staticKeys:string[], blockhash:string, instructions:{programIdIndex:number, accounts:number[], data:Buffer}[], lookups:{table:string, writable:number[], readonly:number[]}[]}}
 */
export function decodeTransaction(buf) {
  buf = Buffer.from(buf);
  if (buf[0] === V1_BYTE) return decodeV1(buf);
  const r = new Reader(buf);
  const nsig = r.shortvec();
  if (nsig === 0 || nsig > 64) throw new Error(`bad signature count ${nsig}`);
  const signatures = [];
  for (let i = 0; i < nsig; i++) signatures.push(b58encode(r.bytes(64)));
  const msgStart = r.o;
  let version = "legacy";
  if (r.b[r.o] & 0x80) {
    version = r.u8() & 0x7f;
    if (version !== 0) throw new Error(`unsupported transaction version ${version}`);
  }
  const header = { numRequiredSignatures: r.u8(), numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  const nkeys = r.shortvec();
  const staticKeys = [];
  for (let i = 0; i < nkeys; i++) staticKeys.push(r.key());
  const blockhash = r.key();
  const nix = r.shortvec();
  const instructions = [];
  for (let i = 0; i < nix; i++) {
    const programIdIndex = r.u8();
    const na = r.shortvec();
    const accounts = [...r.bytes(na)];
    const data = Buffer.from(r.bytes(r.shortvec()));
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups = [];
  if (version === 0) {
    const nl = r.shortvec();
    for (let i = 0; i < nl; i++) {
      const table = r.key();
      const writable = [...r.bytes(r.shortvec())];
      const readonly = [...r.bytes(r.shortvec())];
      lookups.push({ table, writable, readonly });
    }
  }
  if (r.o !== r.b.length) throw new Error("trailing bytes after the transaction");
  if (header.numRequiredSignatures !== nsig) throw new Error(`header expects ${header.numRequiredSignatures} signatures, transaction has ${nsig}`);
  const ns = header.numRequiredSignatures;
  if (ns > nkeys || header.numReadonlySigned >= ns || header.numReadonlyUnsigned > nkeys - ns) {
    throw new Error("bad message header");
  }
  return { signatures, message: r.b.subarray(msgStart), version, header, staticKeys, blockhash, instructions, lookups };
}

// Transaction v1 (SIMD-0385, live on mainnet since Sept 2026): version byte 129, header, config mask,
// blockhash, u8 counts, inline addresses (no lookup tables), config values, 4-byte instruction headers,
// instruction payloads, then the signatures at the end.
export const V1_BYTE = 0x81;
const V1_KNOWN_MASK = 0b11111;
function decodeV1(buf) {
  const r = new Reader(buf);
  r.u8();
  const header = { numRequiredSignatures: r.u8(), numReadonlySigned: r.u8(), numReadonlyUnsigned: r.u8() };
  r.need(4); const mask = buf.readUInt32LE(r.o); r.o += 4;
  if (mask & ~V1_KNOWN_MASK) throw new Error(`v1 transaction sets unknown config bits (0x${mask.toString(16)})`);
  if ((mask & 1) !== ((mask >> 1) & 1)) throw new Error("v1 priority fee needs both config bits 0 and 1");
  const blockhash = r.key();
  const nix = r.u8(), nkeys = r.u8();
  if (nix > 64 || nkeys > 64) throw new Error("v1 transaction has too many instructions or addresses");
  const staticKeys = [];
  for (let i = 0; i < nkeys; i++) staticKeys.push(r.key());
  if (new Set(staticKeys).size !== staticKeys.length) throw new Error("v1 transaction has duplicate addresses");
  const config = {};
  if (mask & 1) { r.need(8); config.priorityFee = buf.readBigUInt64LE(r.o); r.o += 8; }
  if (mask & 4) { r.need(4); config.computeUnitLimit = buf.readUInt32LE(r.o); r.o += 4; }
  if (mask & 8) { r.need(4); config.loadedAccountsDataSizeLimit = buf.readUInt32LE(r.o); r.o += 4; }
  if (mask & 16) { r.need(4); config.heapSize = buf.readUInt32LE(r.o); r.o += 4; }
  const heads = [];
  for (let i = 0; i < nix; i++) { r.need(4); heads.push({ programIdIndex: buf[r.o], na: buf[r.o + 1], dl: buf.readUInt16LE(r.o + 2) }); r.o += 4; }
  const instructions = heads.map((h) => ({ programIdIndex: h.programIdIndex, accounts: [...r.bytes(h.na)], data: Buffer.from(r.bytes(h.dl)) }));
  const ns = header.numRequiredSignatures;
  const message = buf.subarray(0, r.o);
  const signatures = [];
  for (let i = 0; i < ns; i++) signatures.push(b58encode(r.bytes(64)));
  if (r.o !== buf.length) throw new Error("trailing bytes after the transaction");
  if (ns < 1 || ns > nkeys || header.numReadonlySigned >= ns || nkeys < ns + header.numReadonlyUnsigned) throw new Error("bad message header");
  return { signatures, message, version: 1, header, staticKeys, blockhash, instructions, lookups: [], config, mask };
}

/** Address lookup table account data -> addresses (state layout: 56-byte header, then 32-byte keys). */
export function parseLookupTable(data) {
  if (data.length < 56 || data.readUInt32LE(0) !== 1) throw new Error("not an address lookup table");
  const out = [];
  for (let o = 56; o + 32 <= data.length; o += 32) out.push(b58encode(data.subarray(o, o + 32)));
  return out;
}

/**
 * Full ordered account list and writability, given the lookup tables' contents.
 * @param {object} tx decoded transaction
 * @param {Record<string,string[]>} tables table address -> its addresses
 */
export function accountList(tx, tables = {}) {
  const { header, staticKeys } = tx;
  const n = staticKeys.length, ns = header.numRequiredSignatures;
  const keys = [...staticKeys];
  const writable = staticKeys.map((_, i) => (i < ns ? i < ns - header.numReadonlySigned : i < n - header.numReadonlyUnsigned));
  const wl = [], rl = [];
  for (const l of tx.lookups) {
    const t = tables[l.table];
    if (!t) throw new Error(`lookup table ${l.table} could not be read`);
    for (const i of l.writable) { if (i >= t.length) throw new Error(`lookup table ${short(l.table)} has no index ${i}`); wl.push(t[i]); }
    for (const i of l.readonly) { if (i >= t.length) throw new Error(`lookup table ${short(l.table)} has no index ${i}`); rl.push(t[i]); }
  }
  keys.push(...wl, ...rl);
  writable.push(...wl.map(() => true), ...rl.map(() => false));
  for (const ix of tx.instructions) {
    if (ix.programIdIndex >= keys.length || ix.accounts.some((a) => a >= keys.length)) throw new Error("instruction refers to an account that doesn't exist");
  }
  return { keys, writable, signers: staticKeys.slice(0, ns), feePayer: staticKeys[0] };
}

// ---------- instruction decoding ----------
const SYS_TYPES = ["createAccount", "assign", "transfer", "createAccountWithSeed", "advanceNonce", "withdrawNonce", "initializeNonce", "authorizeNonce", "allocate", "allocateWithSeed", "assignWithSeed", "transferWithSeed", "upgradeNonce"];
const AUTH_TYPES = ["mintTokens", "freezeAccount", "accountOwner", "closeAccount"];

/** Decode one instruction into { program, programId, type, accounts, ...fields }. Unknown programs get type "call". */
export function decodeInstruction(ix, keys) {
  const programId = keys[ix.programIdIndex];
  const a = ix.accounts.map((i) => keys[i]);
  const d = ix.data;
  const out = { programId, program: programName(programId), type: "call", accounts: a };
  try {
    if (programId === SYSTEM) {
      if (d.length < 4) return { ...out, type: "unknown" };
      const t = SYS_TYPES[d.readUInt32LE(0)] || "unknown";
      out.type = t;
      if (t === "transfer") Object.assign(out, { from: a[0], to: a[1], lamports: u64(d, 4) });
      else if (t === "transferWithSeed") Object.assign(out, { from: a[0], to: a[2], lamports: u64(d, 4) });
      else if (t === "createAccount") Object.assign(out, { from: a[0], account: a[1], lamports: u64(d, 4), owner: b58encode(d.subarray(20, 52)) });
      else if (t === "createAccountWithSeed") Object.assign(out, { from: a[0], account: a[1] });
      else if (t === "assign") Object.assign(out, { account: a[0], owner: b58encode(d.subarray(4, 36)) });
      else if (t === "assignWithSeed") Object.assign(out, { account: a[0] });
      else if (t === "withdrawNonce") Object.assign(out, { nonce: a[0], to: a[1], lamports: u64(d, 4) });
      return out;
    }
    if (programId === TOKEN || programId === TOKEN_2022) {
      if (!d.length) return { ...out, type: "unknown" };
      const tag = d[0];
      if (tag === 3) return { ...out, type: "transfer", source: a[0], destination: a[1], authority: a[2], amount: u64(d, 1) };
      if (tag === 12) return { ...out, type: "transfer", source: a[0], mint: a[1], destination: a[2], authority: a[3], amount: u64(d, 1), decimals: d[9] };
      if (tag === 4) return { ...out, type: "approve", source: a[0], delegate: a[1], authority: a[2], amount: u64(d, 1) };
      if (tag === 13) return { ...out, type: "approve", source: a[0], mint: a[1], delegate: a[2], authority: a[3], amount: u64(d, 1), decimals: d[9] };
      if (tag === 5) return { ...out, type: "revoke", source: a[0] };
      if (tag === 6) return { ...out, type: "setAuthority", account: a[0], authority: a[1], authorityType: AUTH_TYPES[d[1]] || `type ${d[1]}`, newAuthority: d[2] ? b58encode(d.subarray(3, 35)) : null };
      if (tag === 9) return { ...out, type: "closeAccount", account: a[0], destination: a[1], authority: a[2] };
      if (tag === 8 || tag === 15) return { ...out, type: "burn", account: a[0], mint: a[1], amount: u64(d, 1) };
      if (tag === 7 || tag === 14) return { ...out, type: "mintTo", mint: a[0], account: a[1], amount: u64(d, 1) };
      if (tag === 17) return { ...out, type: "syncNative", account: a[0] };
      if ([1, 16, 18].includes(tag)) return { ...out, type: "initializeAccount", account: a[0], mint: a[1], owner: tag === 1 ? a[2] : b58encode(d.subarray(1, 33)) };
      return { ...out, type: `token instruction ${tag}` };
    }
    if (programId === ATA) {
      const t = !d.length || d[0] === 0 ? "create" : d[0] === 1 ? "createIdempotent" : `ata instruction ${d[0]}`;
      return { ...out, type: t, payer: a[0], account: a[1], owner: a[2], mint: a[3] };
    }
    if (programId === COMPUTE_BUDGET) {
      if (d[0] === 2) return { ...out, type: "setComputeUnitLimit", units: d.readUInt32LE(1) };
      if (d[0] === 3) return { ...out, type: "setComputeUnitPrice", microLamports: u64(d, 1) };
      return { ...out, type: "computeBudget" };
    }
    if (programId === MEMO || programId === MEMO_V1) return { ...out, type: "memo", text: d.toString("utf8").slice(0, 120) };
  } catch {
    return { ...out, type: "undecodable" };
  }
  return out;
}

/** Transaction fee in lamports: 5000 per signature plus the priority fee (unit price × unit limit). */
export function computeFee(ixs, numSignatures, tx) {
  if (tx?.version === 1) { // v1: an absolute priority fee in the config; compute budget instructions are ignored
    const priority = tx.config?.priorityFee ?? 0n;
    return { lamports: 5000n * BigInt(numSignatures) + priority, priority, units: BigInt(tx.config?.computeUnitLimit ?? 0), microLamports: null };
  }
  let limit, price = 0n, nonBudget = 0;
  for (const ix of ixs) {
    if (ix.type === "setComputeUnitLimit") limit = ix.units;
    else if (ix.type === "setComputeUnitPrice") price = ix.microLamports;
    else if (ix.programId !== COMPUTE_BUDGET) nonBudget++;
  }
  const units = BigInt(limit ?? Math.min(1_400_000, 200_000 * Math.max(1, nonBudget)));
  const priority = (price * units + 999_999n) / 1_000_000n;
  return { lamports: 5000n * BigInt(numSignatures) + priority, priority, units, microLamports: price };
}

// ---------- account layouts ----------
/** SPL token account (Token and Token-2022 share the first 165 bytes). Returns null if it isn't one. */
export function parseTokenAccount(acc) {
  if (!acc || (acc.owner !== TOKEN && acc.owner !== TOKEN_2022) || acc.data.length < 165) return null;
  if (acc.owner === TOKEN && acc.data.length !== 165) return null;
  if (acc.owner === TOKEN_2022 && acc.data.length > 165 && acc.data[165] !== 2) return null; // 2 = account type "Account"
  const d = acc.data;
  const state = d[108];
  if (state === 0) return null; // uninitialized
  return {
    mint: b58encode(d.subarray(0, 32)), owner: b58encode(d.subarray(32, 64)), amount: u64(d, 64),
    delegate: d.readUInt32LE(72) ? b58encode(d.subarray(76, 108)) : null, state,
    isNative: d.readUInt32LE(109) !== 0, delegatedAmount: u64(d, 121),
    closeAuthority: d.readUInt32LE(129) ? b58encode(d.subarray(133, 165)) : null,
  };
}

/** SPL mint: decimals is byte 44. */
export function parseMint(acc) {
  if (!acc || (acc.owner !== TOKEN && acc.owner !== TOKEN_2022) || acc.data.length < 82) return null;
  return { decimals: acc.data[44], supply: u64(acc.data, 36) };
}

/** RPC account JSON ({lamports, owner, data:[b64,'base64']}) -> {lamports: bigint, owner, data: Buffer}. */
export function rpcAccount(a) {
  if (!a) return null;
  const data = Array.isArray(a.data) ? Buffer.from(a.data[0], a.data[1] === "base58" ? undefined : "base64") : Buffer.alloc(0);
  return { lamports: BigInt(a.lamports), owner: a.owner, data: Array.isArray(a.data) && a.data[1] === "base58" ? b58decode(a.data[0]) : data, executable: !!a.executable };
}
export function toRpcAccount(acc) {
  if (!acc) return null;
  return { lamports: Number(acc.lamports), owner: acc.owner, data: [Buffer.from(acc.data).toString("base64"), "base64"], executable: !!acc.executable, rentEpoch: 0, space: acc.data.length };
}

/** Encode an SPL token account (165 bytes) — used by the demo chain and tests. */
export function encodeTokenAccount({ mint, owner, amount = 0n, delegate = null, delegatedAmount = 0n, closeAuthority = null, isNative = false }) {
  const d = Buffer.alloc(165);
  b58decode(mint).copy(d, 0); b58decode(owner).copy(d, 32);
  d.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) { d.writeUInt32LE(1, 72); b58decode(delegate).copy(d, 76); }
  d[108] = 1;
  if (isNative) { d.writeUInt32LE(1, 109); d.writeBigUInt64LE(2039280n, 113); }
  d.writeBigUInt64LE(BigInt(delegatedAmount), 121);
  if (closeAuthority) { d.writeUInt32LE(1, 129); b58decode(closeAuthority).copy(d, 133); }
  return d;
}
export function encodeMint(decimals, supply = 0n) {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(BigInt(supply), 36); d[44] = decimals; d[45] = 1;
  return d;
}

// ---------- keys, building and signing (demo + tests) ----------
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function keypair(seed) {
  const key = seed ? createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, createHash("sha256").update(String(seed)).digest()]), format: "der", type: "pkcs8" }) : generateKeyPairSync("ed25519").privateKey;
  const pub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: b58encode(pub), sign: (msg) => edSign(null, msg, key) };
}
/** A deterministic, valid-looking address (not a real key) for tests: base58 of sha256(label). */
export const addr = (label) => b58encode(createHash("sha256").update(String(label)).digest());

/**
 * Build and sign a transaction.
 * @param {object} o
 * @param {string} o.payer fee payer (must be among signers)
 * @param {{publicKey:string, sign:Function}[]} o.signers
 * @param {{programId:string, keys:{pubkey:string, isSigner?:boolean, isWritable?:boolean}[], data:Buffer}[]} o.instructions
 * @param {string} [o.blockhash]
 * @param {0|'legacy'} [o.version]
 * @param {{table:string, addresses:string[]}[]} [o.lookupTables] v0 only: accounts found in these tables are loaded through them
 */
export function buildTransaction({ payer, signers, instructions, blockhash = addr("blockhash"), version = "legacy", lookupTables = [], config = {} }) {
  const metas = new Map();
  const add = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) || { pubkey, isSigner: false, isWritable: false };
    m.isSigner ||= isSigner; m.isWritable ||= isWritable;
    metas.set(pubkey, m);
  };
  add(payer, true, true);
  for (const ix of instructions) { for (const k of ix.keys) add(k.pubkey, !!k.isSigner, !!k.isWritable); add(ix.programId, false, false); }
  const programIds = new Set(instructions.map((i) => i.programId));
  let all = [...metas.values()];
  const lookedUp = [];
  if (version === 0) {
    for (const lt of lookupTables) {
      const w = [], ro = [];
      for (const m of all) {
        if (m.isSigner || programIds.has(m.pubkey) || lookedUp.some((x) => x.pubkey === m.pubkey)) continue;
        const i = lt.addresses.indexOf(m.pubkey);
        if (i < 0) continue;
        (m.isWritable ? w : ro).push({ ...m, idx: i });
      }
      if (w.length || ro.length) lookedUp.push(...w, ...ro), lt._w = w, lt._r = ro;
    }
    all = all.filter((m) => !lookedUp.some((x) => x.pubkey === m.pubkey));
  }
  const rank = (m) => (m.pubkey === payer ? -1 : m.isSigner ? (m.isWritable ? 0 : 1) : m.isWritable ? 2 : 3);
  all.sort((x, y) => rank(x) - rank(y));
  const keys = all.map((m) => m.pubkey);
  const lw = lookupTables.flatMap((lt) => (lt._w || []).map((m) => m.pubkey));
  const lr = lookupTables.flatMap((lt) => (lt._r || []).map((m) => m.pubkey));
  const index = [...keys, ...lw, ...lr];
  const header = Buffer.from([all.filter((m) => m.isSigner).length, all.filter((m) => m.isSigner && !m.isWritable).length, all.filter((m) => !m.isSigner && !m.isWritable).length]);
  const parts = [];
  if (version === 0) parts.push(Buffer.from([0x80]));
  parts.push(header, shortvec(keys.length), ...keys.map((k) => b58decode(k)), b58decode(blockhash), shortvec(instructions.length));
  for (const ix of instructions) {
    const idx = ix.keys.map((k) => index.indexOf(k.pubkey));
    parts.push(Buffer.from([index.indexOf(ix.programId)]), shortvec(idx.length), Buffer.from(idx), shortvec(ix.data.length), ix.data);
  }
  if (version === 0) {
    const used = lookupTables.filter((lt) => lt._w?.length || lt._r?.length);
    parts.push(shortvec(used.length));
    for (const lt of used) parts.push(b58decode(lt.table), shortvec(lt._w.length), Buffer.from(lt._w.map((m) => m.idx)), shortvec(lt._r.length), Buffer.from(lt._r.map((m) => m.idx)));
    for (const lt of lookupTables) { delete lt._w; delete lt._r; }
  }
  if (version === 1) {
    const mask = (config.priorityFee !== undefined ? 3 : 0) | (config.computeUnitLimit !== undefined ? 4 : 0);
    const vals = [];
    if (config.priorityFee !== undefined) vals.push(le64(config.priorityFee));
    if (config.computeUnitLimit !== undefined) vals.push(le32(config.computeUnitLimit));
    const headsV1 = [], payloads = [];
    for (const ix of instructions) {
      const idx = ix.keys.map((k) => keys.indexOf(k.pubkey));
      const h = Buffer.alloc(4); h[0] = keys.indexOf(ix.programId); h[1] = idx.length; h.writeUInt16LE(ix.data.length, 2);
      headsV1.push(h); payloads.push(Buffer.from(idx), ix.data);
    }
    const msgV1 = Buffer.concat([Buffer.from([V1_BYTE]), header, le32(mask), b58decode(blockhash), Buffer.from([instructions.length, keys.length]), ...keys.map((k) => b58decode(k)), ...vals, ...headsV1, ...payloads]);
    const sigsV1 = keys.slice(0, header[0]).map((k) => { const sg = signers.find((x) => x.publicKey === k); if (!sg) throw new Error(`no signer for ${k}`); return sg.sign(msgV1); });
    return Buffer.concat([msgV1, ...sigsV1]);
  }
  const message = Buffer.concat(parts);
  const order = keys.slice(0, header[0]);
  const sigs = order.map((k) => { const s = signers.find((x) => x.publicKey === k); if (!s) throw new Error(`no signer for ${k}`); return s.sign(message); });
  return Buffer.concat([shortvec(sigs.length), ...sigs, message]);
}

// Instruction builders
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const ix = {
  transfer: (from, to, lamports) => ({ programId: SYSTEM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isWritable: true }], data: Buffer.concat([le32(2), le64(lamports)]) }),
  assign: (account, owner) => ({ programId: SYSTEM, keys: [{ pubkey: account, isSigner: true, isWritable: true }], data: Buffer.concat([le32(1), b58decode(owner)]) }),
  tokenTransfer: (source, destination, authority, amount, program = TOKEN) => ({ programId: program, keys: [{ pubkey: source, isWritable: true }, { pubkey: destination, isWritable: true }, { pubkey: authority, isSigner: true }], data: Buffer.concat([Buffer.from([3]), le64(amount)]) }),
  tokenTransferChecked: (source, mint, destination, authority, amount, decimals, program = TOKEN) => ({ programId: program, keys: [{ pubkey: source, isWritable: true }, { pubkey: mint }, { pubkey: destination, isWritable: true }, { pubkey: authority, isSigner: true }], data: Buffer.concat([Buffer.from([12]), le64(amount), Buffer.from([decimals])]) }),
  approve: (source, delegate, authority, amount, program = TOKEN) => ({ programId: program, keys: [{ pubkey: source, isWritable: true }, { pubkey: delegate }, { pubkey: authority, isSigner: true }], data: Buffer.concat([Buffer.from([4]), le64(amount)]) }),
  revoke: (source, authority, program = TOKEN) => ({ programId: program, keys: [{ pubkey: source, isWritable: true }, { pubkey: authority, isSigner: true }], data: Buffer.from([5]) }),
  setAuthority: (account, current, authorityType, newAuthority, program = TOKEN) => ({ programId: program, keys: [{ pubkey: account, isWritable: true }, { pubkey: current, isSigner: true }], data: Buffer.concat([Buffer.from([6, AUTH_TYPES.indexOf(authorityType), newAuthority ? 1 : 0]), newAuthority ? b58decode(newAuthority) : Buffer.alloc(0)]) }),
  closeAccount: (account, destination, authority, program = TOKEN) => ({ programId: program, keys: [{ pubkey: account, isWritable: true }, { pubkey: destination, isWritable: true }, { pubkey: authority, isSigner: true }], data: Buffer.from([9]) }),
  createAta: (payer, account, owner, mint, program = TOKEN) => ({ programId: ATA, keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: account, isWritable: true }, { pubkey: owner }, { pubkey: mint }, { pubkey: SYSTEM }, { pubkey: program }], data: Buffer.from([1]) }),
  cuLimit: (units) => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([2]), le32(units)]) }),
  cuPrice: (microLamports) => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([3]), le64(microLamports)]) }),
  memo: (text) => ({ programId: MEMO, keys: [], data: Buffer.from(text) }),
};
