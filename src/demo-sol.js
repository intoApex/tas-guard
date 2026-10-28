// A small in-memory Solana "chain" that speaks enough JSON-RPC for the Solana guard: accounts,
// simulation, sending (with signature checks), lookup tables and a WebSocket stub. It executes the
// System, Token, Associated Token, Compute Budget and Memo programs, plus a fake DEX program that
// stands in for pump.fun in demos. Used by `tas-guard sol-demo` and the tests. No real money, no network.
import { createServer } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  b58decode, b58encode, decodeTransaction, accountList, decodeInstruction, computeFee, parseTokenAccount,
  encodeTokenAccount, encodeMint, toRpcAccount, addr, SYSTEM, TOKEN, TOKEN_2022, ATA, WSOL, PROGRAM_PRESETS, U64_MAX,
} from "./solana.js";

export const DEMO_GENESIS = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };
export const DEX = PROGRAM_PRESETS.pumpfun[0];     // the fake DEX answers to pump.fun's program id
export const SHADY = addr("shady-program");          // a program that sets a delegate behind your back
const RENT_TOKEN = 2039280n;
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }]));
class TxError extends Error { constructor(err, logs) { super(typeof err === "string" ? err : JSON.stringify(err)); this.err = err; this.logs = logs; } }

export function encodeLookupTable(addresses) {
  const d = Buffer.alloc(56 + 32 * addresses.length);
  d.writeUInt32LE(1, 0); d.writeBigUInt64LE(U64_MAX, 4);
  addresses.forEach((a, i) => b58decode(a).copy(d, 56 + 32 * i));
  return d;
}

export class MockSolana {
  constructor({ cluster = "devnet" } = {}) {
    this.genesis = DEMO_GENESIS[cluster] || cluster;
    this.accts = new Map();
    this.slot = 1000;
    this.blockhashes = new Set();
    this.newBlockhash();
    this.sent = [];
    this.calls = [];
  }
  newBlockhash() { this.blockhash = addr("bh" + this.slot++); this.blockhashes.add(this.blockhash); return this.blockhash; }
  expireBlockhashes() { this.blockhashes.clear(); this.newBlockhash(); }

  // ---------- setup helpers ----------
  set(a, v) { this.accts.set(a, { lamports: BigInt(v.lamports ?? 0), owner: v.owner ?? SYSTEM, data: Buffer.from(v.data ?? []), executable: !!v.executable }); }
  get(a) { return this.accts.get(a) || null; }
  fund(a, lamports) { const x = this.get(a); if (x) x.lamports += BigInt(lamports); else this.set(a, { lamports }); }
  createMint(mint, decimals) { this.set(mint, { lamports: 1461600, owner: TOKEN, data: encodeMint(decimals, 10n ** 15n) }); }
  tokenAccount(a, o) { this.set(a, { lamports: RENT_TOKEN + (o.mint === WSOL ? BigInt(o.amount || 0) : 0n), owner: o.program || TOKEN, data: encodeTokenAccount({ ...o, isNative: o.mint === WSOL }) }); }
  lookupTable(a, addresses) { this.set(a, { lamports: 1e6, owner: "AddressLookupTab1e1111111111111111111111111", data: encodeLookupTable(addresses) }); }
  balance(a) { return this.get(a)?.lamports ?? 0n; }
  tokenBalance(a) { return parseTokenAccount(this.get(a))?.amount ?? 0n; }

  // ---------- execution ----------
  execute(raw, accts, { checkSigs = true, checkBlockhash = true } = {}) {
    const tx = decodeTransaction(raw);
    const logs = [];
    if (checkBlockhash && !this.blockhashes.has(tx.blockhash)) throw new TxError("BlockhashNotFound", logs);
    if (checkSigs) {
      tx.signatures.forEach((s, i) => {
        const key = createPublicKey({ key: Buffer.concat([SPKI, b58decode(tx.staticKeys[i])]), format: "der", type: "spki" });
        if (!verify(null, tx.message, key, b58decode(s))) throw new TxError("SignatureFailure", logs);
      });
    }
    const tables = {};
    for (const l of tx.lookups) {
      const t = accts.get(l.table);
      if (!t) throw new TxError("AddressLookupTableNotFound", logs);
      const d = t.data; tables[l.table] = [];
      for (let o = 56; o + 32 <= d.length; o += 32) tables[l.table].push(b58encode(d.subarray(o, o + 32)));
    }
    const al = accountList(tx, tables);
    const signers = new Set(al.signers);
    const writable = new Set(al.keys.filter((_, i) => al.writable[i]));
    const ixs = tx.instructions.map((i) => decodeInstruction(i, al.keys));
    const fee = computeFee(ixs, tx.signatures.length).lamports;
    const payer = accts.get(al.feePayer);
    if (!payer || payer.lamports < fee) throw new TxError("InsufficientFundsForFee", logs);
    payer.lamports -= fee;

    const acc = (a) => accts.get(a);
    const need = (a) => { const x = acc(a); if (!x) throw new Error(`account ${a} not found`); return x; };
    const W = (a) => { if (!writable.has(a)) throw new Error(`${a} is not writable`); return need(a); };
    const tokenOf = (a) => { const t = parseTokenAccount(acc(a)); if (!t) throw new Error(`${a} is not a token account`); return t; };
    const saveToken = (a, t) => { const x = W(a); x.data = encodeTokenAccount({ ...t, isNative: t.mint === WSOL }); };
    const moveLamports = (from, to, n) => {
      const f = W(from); if (f.lamports < n) throw Object.assign(new Error("insufficient lamports"), { custom: 1 });
      f.lamports -= n;
      if (!acc(to)) accts.set(to, { lamports: 0n, owner: SYSTEM, data: Buffer.alloc(0) });
      W(to).lamports += n;
    };
    const tokenTransfer = (src, dst, authority, amount, depth) => {
      const s = tokenOf(src), d = tokenOf(dst);
      if (s.mint !== d.mint) throw Object.assign(new Error("mint mismatch"), { custom: 3 });
      if (s.amount < amount) throw Object.assign(new Error("insufficient funds"), { custom: 1 });
      if (authority === s.owner) { if (!signers.has(authority) && depth === 1) throw new Error("owner did not sign"); }
      else if (authority === s.delegate && s.delegatedAmount >= amount) s.delegatedAmount -= amount, s.delegatedAmount === 0n && (s.delegate = null);
      else throw Object.assign(new Error("owner does not match"), { custom: 4 });
      s.amount -= amount; d.amount += amount;
      saveToken(src, s); saveToken(dst, d);
      if (s.mint === WSOL) { W(src).lamports -= amount; W(dst).lamports += amount; }
    };

    ixs.forEach((i, idx) => {
      const pid = i.programId;
      logs.push(`Program ${pid} invoke [1]`);
      try {
        if (pid === SYSTEM) {
          if (i.type === "transfer") { if (!signers.has(i.from)) throw new Error("missing signature"); moveLamports(i.from, i.to, i.lamports); }
          else if (i.type === "assign") { if (!signers.has(i.account)) throw new Error("missing signature"); W(i.account).owner = i.owner; }
          else if (i.type === "createAccount") { moveLamports(i.from, i.account, i.lamports); W(i.account).owner = i.owner; }
          else throw new Error(`mock chain doesn't run system ${i.type}`);
        } else if (pid === TOKEN || pid === TOKEN_2022) {
          if (i.type === "transfer") tokenTransfer(i.source, i.destination, i.authority, i.amount, 1);
          else if (i.type === "approve") { const t = tokenOf(i.source); if (t.owner !== i.authority || !signers.has(i.authority)) throw new Error("owner does not match"); t.delegate = i.delegate; t.delegatedAmount = i.amount; saveToken(i.source, t); }
          else if (i.type === "revoke") { const t = tokenOf(i.source); t.delegate = null; t.delegatedAmount = 0n; saveToken(i.source, t); }
          else if (i.type === "setAuthority") {
            const t = tokenOf(i.account);
            if (t.owner !== i.authority || !signers.has(i.authority)) throw new Error("owner does not match");
            if (i.authorityType === "accountOwner") t.owner = i.newAuthority; else if (i.authorityType === "closeAccount") t.closeAuthority = i.newAuthority; else throw new Error("unsupported authority type");
            saveToken(i.account, t);
          } else if (i.type === "closeAccount") {
            const t = tokenOf(i.account);
            if (t.amount !== 0n && t.mint !== WSOL) throw new Error("non-native account can only be closed if its balance is zero");
            if ((t.closeAuthority || t.owner) !== i.authority) throw new Error("owner does not match");
            const n = W(i.account).lamports; W(i.account).lamports = 0n;
            if (!acc(i.destination)) accts.set(i.destination, { lamports: 0n, owner: SYSTEM, data: Buffer.alloc(0) });
            W(i.destination).lamports += n; accts.delete(i.account);
          } else if (i.type === "syncNative") { /* balances are already in sync here */ }
          else throw new Error(`mock chain doesn't run token ${i.type}`);
        } else if (pid === ATA) {
          if (acc(i.account)) { if (i.type !== "createIdempotent") throw new Error("account already in use"); }
          else { moveLamports(i.payer, i.account, RENT_TOKEN); const x = W(i.account); x.owner = TOKEN; x.data = encodeTokenAccount({ mint: i.mint, owner: i.owner, isNative: i.mint === WSOL }); }
        } else if (pid === DEX) {
          // data: [0, solIn u64, tokensOut u64]  accounts: [user (signer), user token account, pool, pool token account]
          const d = tx.instructions[idx].data;
          const [user, userAta, pool, poolAta] = i.accounts;
          if (d[0] !== 0) throw new Error("unknown dex instruction");
          moveLamports(user, pool, d.readBigUInt64LE(1));
          logs.push(`Program ${TOKEN} invoke [2]`);
          tokenTransfer(poolAta, userAta, tokenOf(poolAta).owner, d.readBigUInt64LE(9), 2);
          logs.push(`Program ${TOKEN} success`);
        } else if (pid === SHADY) {
          // "claim your airdrop": quietly makes the attacker a delegate of the user's token account (as if by CPI)
          const [userAta, attacker] = i.accounts;
          const t = tokenOf(userAta);
          logs.push(`Program ${TOKEN} invoke [2]`);
          t.delegate = attacker; t.delegatedAmount = U64_MAX; saveToken(userAta, t);
          logs.push(`Program ${TOKEN} success`);
        } else if (i.type !== "setComputeUnitLimit" && i.type !== "setComputeUnitPrice" && i.type !== "memo" && i.type !== "computeBudget") {
          throw new Error(`program ${pid} is not deployed on the mock chain`);
        }
        logs.push(`Program ${pid} success`);
      } catch (e) {
        logs.push(`Program ${pid} failed: ${e.message}`);
        throw new TxError({ InstructionError: [idx, e.custom !== undefined ? { Custom: e.custom } : "InvalidAccountData"] }, logs);
      }
    });
    return { tx, logs, sig: tx.signatures[0] };
  }

  // ---------- JSON-RPC ----------
  handle(m) {
    const p = m.params || [];
    this.calls.push(m.method);
    switch (m.method) {
      case "getGenesisHash": return this.genesis;
      case "getHealth": return "ok";
      case "getSlot": return this.slot;
      case "getLatestBlockhash": return { context: { slot: this.slot }, value: { blockhash: this.blockhash, lastValidBlockHeight: this.slot + 150 } };
      case "isBlockhashValid": return { context: { slot: this.slot }, value: this.blockhashes.has(p[0]) };
      case "getBalance": return { context: { slot: this.slot }, value: Number(this.balance(p[0])) };
      case "getAccountInfo": return { context: { slot: this.slot }, value: toRpcAccount(this.get(p[0])) };
      case "getMultipleAccounts": return { context: { slot: this.slot }, value: p[0].map((a) => toRpcAccount(this.get(a))) };
      case "getMinimumBalanceForRentExemption": return Number(RENT_TOKEN);
      case "requestAirdrop": this.fund(p[0], p[1]); return b58encode(createHash("sha256").update("airdrop" + this.slot++).digest().subarray(0, 64));
      case "simulateTransaction": {
        const raw = Buffer.from(p[0], p[1]?.encoding === "base64" ? "base64" : undefined);
        const bytes = p[1]?.encoding === "base64" ? raw : b58decode(p[0]);
        const copy = clone(this.accts);
        let err = null, logs = [];
        try { logs = this.execute(bytes, copy, { checkSigs: !!p[1]?.sigVerify, checkBlockhash: !p[1]?.replaceRecentBlockhash }).logs; }
        catch (e) { if (!(e instanceof TxError)) throw e; err = e.err; logs = e.logs; }
        const want = p[1]?.accounts?.addresses;
        return { context: { slot: this.slot }, value: { err, logs, accounts: err || !want ? null : want.map((a) => toRpcAccount(copy.get(a))), unitsConsumed: 1000 } };
      }
      case "sendTransaction": {
        const bytes = p[1]?.encoding === "base64" ? Buffer.from(p[0], "base64") : b58decode(p[0]);
        const copy = clone(this.accts);
        const { sig } = this.execute(bytes, copy);
        this.accts = copy;
        this.sent.push(sig);
        this.slot++;
        return sig;
      }
      case "getSignatureStatuses": return { context: { slot: this.slot }, value: p[0].map((s) => (this.sent.includes(s) ? { slot: this.slot, confirmations: null, err: null, confirmationStatus: "confirmed" } : null)) };
      default: throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 });
    }
  }

  async listen(port = 0, host = "127.0.0.1") {
    this.server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const one = (m) => {
        try { return { jsonrpc: "2.0", id: m.id, result: this.handle(m) }; }
        catch (e) {
          if (e instanceof TxError) return { jsonrpc: "2.0", id: m.id, error: { code: -32002, message: `Transaction simulation failed: ${e.message}`, data: { err: e.err, logs: e.logs } } };
          return { jsonrpc: "2.0", id: m.id, error: { code: e.code || -32603, message: e.message } };
        }
      };
      const msg = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
    // WebSocket stub: completes the handshake, then answers every frame with a fixed subscription id.
    this.server.on("upgrade", (req, socket) => {
      this.wsHits = (this.wsHits || 0) + 1;
      const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", () => { const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 })); socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg])); });
      socket.on("error", () => {});
    });
    this.socks = new Set();
    this.server.on("connection", (c) => { this.socks.add(c); c.on("close", () => this.socks.delete(c)); });
    await new Promise((r) => this.server.listen(port, host, r));
    this.url = `http://${host}:${this.server.address().port}`;
    return this.url;
  }
  close() { for (const c of this.socks || []) c.destroy(); this.server?.closeAllConnections?.(); return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }
}
