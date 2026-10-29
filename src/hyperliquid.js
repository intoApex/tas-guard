// Hyperliquid mode: TAS Guard as a stdio MCP server that trades Hyperliquid directly through its public
// HTTP API (POST /info, POST /exchange). There is no upstream MCP server: HlServer below plays that role
// in-process, and GuardProxy runs every call through the same policy, approvals, kill switch and audit log
// as the other modes. Orders are signed locally with an API ("agent") wallet, which can trade but can't withdraw.
import { createInterface } from "node:readline/promises";
import { parsePrivateKey, privateKeyToAddress } from "./eth-crypto.js";
import { orderWire, orderAction, cancelAction, updateLeverageAction, signL1Action, signApproveBuilderFee, slippagePrice, fitLimitPrice, fitSize } from "./hl-sign.js";
import { BUILDER_ADDRESS, BUILDER_FEE, feePercent, feeOptedOut } from "./hl-fee.js";

export const HL_URLS = { mainnet: "https://api.hyperliquid.xyz", testnet: "https://api.hyperliquid-testnet.xyz" };
const DEFAULT_SLIPPAGE_PCT = 1;
const MAX_SLIPPAGE_PCT = 10;
const MARKETS_TTL_MS = 5 * 60_000;
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const round2 = (n) => Math.round(n * 100) / 100;

/** The built-in connector profile: how each hl_ tool is classed for the shared policy engine. */
export const HL_PROFILE = {
  profile_version: 1,
  slug: "hyperliquid",
  name: "Hyperliquid (built in)",
  source: "Hyperliquid API docs and hyperliquid-python-sdk 0.24.0",
  last_checked: "2026-10-29",
  quote_currency: "USDC",
  tools: {
    hl_get_account: { class: "read" },
    hl_get_mids: { class: "read" },
    hl_get_open_orders: { class: "read" },
    // The guard values orders itself (HlServer.prepare): size x limit price, or mid +/- slippage for market orders.
    hl_place_order: { class: "order", fields: { symbol: "coin", side: "side", qty: "size", price: "price", notional: "notional" } },
    hl_cancel_order: { class: "cancel" },
    hl_close_position: { class: "close" },
    hl_update_leverage: { class: "leverage" },
  },
};

/** Thin client for Hyperliquid's HTTP API. `fetch` is injectable so tests run offline. */
export class HlClient {
  constructor({ testnet = false, fetch = globalThis.fetch, baseUrl } = {}) {
    this.base = (baseUrl || (testnet ? HL_URLS.testnet : HL_URLS.mainnet)).replace(/\/$/, "");
    this.fetch = fetch;
    this.lastNonce = 0;
  }
  /** Millisecond timestamps, strictly increasing within this process (Hyperliquid rejects reused nonces). */
  nonce() { this.lastNonce = Math.max(Date.now(), this.lastNonce + 1); return this.lastNonce; }
  async post(path, body) {
    let r, text;
    try {
      r = await this.fetch(this.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      text = await r.text();
    } catch (e) {
      throw Object.assign(new Error(`couldn't reach Hyperliquid (${e.message})`), { unknownOutcome: true });
    }
    if (r.status >= 500) throw Object.assign(new Error(`Hyperliquid ${path} returned HTTP ${r.status}: ${String(text).slice(0, 200)}`), { unknownOutcome: true });
    if (r.status >= 400) throw new Error(`Hyperliquid ${path} returned HTTP ${r.status}: ${String(text).slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error(`Hyperliquid ${path} returned non-JSON: ${String(text).slice(0, 200)}`); }
  }
  info(body) { return this.post("/info", body); }
  exchange(payload) { return this.post("/exchange", payload); }
}

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg) => ({ ...text(msg), isError: true });
const COIN = { type: "string", description: "Perp name like BTC or ETH, or a spot pair like HYPE/USDC" };
const SLIPPAGE = { type: "number", description: `Market orders: worst price allowed, in percent away from the mid price (default ${DEFAULT_SLIPPAGE_PCT}, max ${MAX_SLIPPAGE_PCT})` };

/** The in-process "upstream" MCP server for Hyperliquid. GuardProxy calls request(), prepare() and summarize(). */
export class HlServer {
  #key;
  /**
   * @param {object} o
   * @param {string} o.account      the user's main address (HL_ACCOUNT): whose account is traded and read
   * @param {string} o.apiKey       the API (agent) wallet private key (HL_API_PRIVATE_KEY). Never logged.
   * @param {boolean} [o.testnet]
   * @param {Function} [o.fetch]    injectable for tests
   * @param {string|null} [o.builderAddress]  defaults to the BUILDER_ADDRESS constant in hl-fee.js
   * @param {number} [o.builderFee]  tenths of a basis point, defaults to BUILDER_FEE
   * @param {object} [o.env]         for the TAS_GUARD_HL_BUILDER_FEE opt-out
   */
  constructor({ account, apiKey, testnet = false, fetch, baseUrl, builderAddress = BUILDER_ADDRESS, builderFee = BUILDER_FEE, env = process.env, version = "", log = () => {} }) {
    if (!isAddress(account)) throw new Error("HL_ACCOUNT must be your Hyperliquid account's main address (0x followed by 40 hex characters)");
    let key;
    try { key = parsePrivateKey(apiKey); } catch (e) { throw new Error(`HL_API_PRIVATE_KEY: ${e.message}. Create an API wallet at https://app.hyperliquid.xyz/API and use its private key.`); }
    this.#key = key;
    this.account = account.toLowerCase();
    this.agent = privateKeyToAddress(key);
    if (this.agent === this.account) {
      throw new Error("HL_API_PRIVATE_KEY is the private key of your main wallet (it matches HL_ACCOUNT). Use an API wallet instead: create one at https://app.hyperliquid.xyz/API. It can trade but can't withdraw, so a leaked key can't drain the account.");
    }
    this.testnet = !!testnet;
    this.network = this.testnet ? "testnet" : "mainnet";
    this.client = new HlClient({ testnet, fetch, baseUrl });
    this.version = version;
    this.log = log;
    if (builderAddress !== null && builderAddress !== undefined && !isAddress(builderAddress)) throw new Error(`builder address '${builderAddress}' is not a 0x address`);
    this.builderFee = builderFee;
    this.feeState = !builderAddress ? "no_address" : feeOptedOut(env) ? "opted_out" : "on";
    this.builder = this.feeState === "on" ? { b: builderAddress.toLowerCase(), f: builderFee } : null;
    this.markets = null;
  }

  describe() { return `Hyperliquid ${this.network} (account ${this.account}, API wallet ${this.agent})`; }

  /** One-time startup messages, plus non-blocking checks of the API wallet and the fee approval. */
  async startup() {
    this.log(`hyperliquid ${this.network}: trading account ${this.account} with API wallet ${this.agent} (it can trade, it can't withdraw)`);
    if (this.feeState === "no_address") this.log("warning: no builder address is set in this build (src/hl-fee.js), so orders are sent without a builder fee");
    else if (this.feeState === "opted_out") this.log("builder fee off (TAS_GUARD_HL_BUILDER_FEE=0): orders are sent without TradingAgentStack's builder code");
    else this.log(`builder fee: ${feePercent(this.builderFee)} per order to TradingAgentStack (${this.builder.b}); turn it off with TAS_GUARD_HL_BUILDER_FEE=0`);
    try {
      // {"role":"agent","data":{"user":"0x.."}} for an API wallet; "user", "vault", "subAccount" or "missing" otherwise.
      const role = await this.client.info({ type: "userRole", user: this.agent });
      if (role?.role === "agent" && role.data?.user && role.data.user.toLowerCase() !== this.account) {
        this.walletProblem = `HL_API_PRIVATE_KEY is an API wallet of account ${role.data.user.toLowerCase()}, not of HL_ACCOUNT ${this.account}, so its orders would trade the other account. Fix one of the two settings and restart.`;
      } else if (["user", "vault", "subAccount"].includes(role?.role)) {
        this.walletProblem = `HL_API_PRIVATE_KEY belongs to a regular Hyperliquid account (${this.agent}), not to an API wallet of HL_ACCOUNT ${this.account}, so its orders would trade that account. Use an API wallet created at https://app.hyperliquid.xyz/API and restart.`;
      } else if (role?.role === "missing") this.log(`warning: Hyperliquid doesn't know API wallet ${this.agent} yet. Authorize it for your account at https://app.hyperliquid.xyz/API.`);
      if (this.walletProblem) this.log("error: " + this.walletProblem + " Until then, every order, cancel and leverage change is refused.");
    } catch {}
    if (this.builder) {
      try {
        const max = Number(await this.client.info({ type: "maxBuilderFee", user: this.account, builder: this.builder.b }));
        if (Number.isFinite(max) && max < this.builder.f) this.log(`warning: the ${feePercent(this.builderFee)} builder fee isn't approved for this account yet, so Hyperliquid will reject orders. Approve it once with: npx tas-guard hl approve-fee${this.testnet ? " --testnet" : ""} (or set TAS_GUARD_HL_BUILDER_FEE=0)`);
      } catch {}
    }
  }

  status() {
    return {
      venue: "hyperliquid", network: this.network, api: this.client.base, account: this.account, api_wallet: this.agent,
      builder_fee: this.feeState === "on" ? { rate: feePercent(this.builderFee), to: this.builder.b, paid_to: "TradingAgentStack", turn_off: "TAS_GUARD_HL_BUILDER_FEE=0" } : this.feeState === "opted_out" ? "off (TAS_GUARD_HL_BUILDER_FEE=0)" : "off (no builder address in this build)",
    };
  }

  // ---------- MCP ----------
  tools() {
    const fee = this.builder ? ` Each order includes a ${feePercent(this.builderFee)} builder fee paid to TradingAgentStack (shown in Hyperliquid's fee breakdown).` : "";
    const ro = { readOnlyHint: true, destructiveHint: false };
    return [
      { name: "hl_get_account", description: `Hyperliquid (${this.network}) account: margin summary, withdrawable USDC, open perp positions and spot balances.`, inputSchema: { type: "object", properties: {} }, annotations: { ...ro, title: "Account state" } },
      { name: "hl_get_mids", description: "Current mid prices. Give coins to filter (e.g. [\"BTC\", \"HYPE/USDC\"]); without it, every listed market.", inputSchema: { type: "object", properties: { coins: { type: "array", items: { type: "string" } } } }, annotations: { ...ro, title: "Mid prices" } },
      { name: "hl_get_open_orders", description: "Open (resting) orders, with their order ids (oid) for hl_cancel_order.", inputSchema: { type: "object", properties: {} }, annotations: { ...ro, title: "Open orders" } },
      {
        name: "hl_place_order",
        description: `Place one order. type "limit" needs price; type "market" sends an immediate-or-cancel order priced at the mid plus or minus max_slippage_pct. size is in coin units (e.g. 0.01 BTC). Prices and sizes are rounded to Hyperliquid's tick rules, never in the user's disfavor.${fee}`,
        inputSchema: {
          type: "object",
          properties: {
            coin: COIN,
            side: { type: "string", enum: ["buy", "sell"] },
            size: { type: ["number", "string"], description: "Amount in coin units" },
            type: { type: "string", enum: ["limit", "market"] },
            price: { type: ["number", "string"], description: "Limit price (limit orders)" },
            max_slippage_pct: SLIPPAGE,
            reduce_only: { type: "boolean", description: "Only reduce an existing position (default false)" },
            tif: { type: "string", enum: ["Gtc", "Ioc", "Alo"], description: "Limit orders: Gtc (default), Ioc (immediate or cancel) or Alo (post only)" },
          },
          required: ["coin", "side", "size", "type"],
        },
        annotations: { destructiveHint: true, title: "Place order" },
      },
      { name: "hl_cancel_order", description: "Cancel one open order by coin and order id (oid).", inputSchema: { type: "object", properties: { coin: COIN, oid: { type: "integer" } }, required: ["coin", "oid"] }, annotations: { destructiveHint: false, title: "Cancel order" } },
      { name: "hl_close_position", description: `Close a perp position (or part of it with size) with a reduce-only market order.${fee}`, inputSchema: { type: "object", properties: { coin: COIN, size: { type: ["number", "string"], description: "Close only this much (default: all)" }, max_slippage_pct: SLIPPAGE }, required: ["coin"] }, annotations: { destructiveHint: true, title: "Close position" } },
      { name: "hl_update_leverage", description: "Set leverage for a perp (cross or isolated).", inputSchema: { type: "object", properties: { coin: COIN, leverage: { type: "integer", minimum: 1 }, is_cross: { type: "boolean", description: "Cross margin (default true) or isolated" } }, required: ["coin", "leverage"] }, annotations: { destructiveHint: true, title: "Update leverage" } },
    ];
  }

  async request(method, params = {}, extra = {}) {
    if (method === "initialize") {
      return {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tas-guard-hyperliquid", version: this.version },
        instructions: `Trades Hyperliquid ${this.network === "mainnet" ? "mainnet (real money)" : "testnet (test funds)"} for account ${this.account}. Sizes are in coin units; values are in USDC.` + (this.builder ? ` Orders include a ${feePercent(this.builderFee)} builder fee paid to TradingAgentStack.` : ""),
      };
    }
    if (method === "tools/list") return { tools: this.tools() };
    if (method === "tools/call") return this.callTool(params?.name, params?.arguments || {}, extra.prepared);
    if (method === "ping") return {};
    throw Object.assign(new Error("Method not found: " + method), { rpc: { code: -32601, message: "Method not found: " + method } });
  }

  // ---------- markets ----------
  async loadMarkets(force = false) {
    if (!force && this.markets && Date.now() - this.markets.at < MARKETS_TTL_MS) return this.markets;
    const [meta, spot] = await Promise.all([this.client.info({ type: "meta" }), this.client.info({ type: "spotMeta" })]);
    const byName = new Map(), byWire = new Map();
    (meta?.universe || []).forEach((u, i) => {
      const m = { name: u.name, coin: u.name, asset: i, szDecimals: u.szDecimals, isSpot: false, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated, delisted: !!u.isDelisted };
      byName.set(u.name, m); byWire.set(u.name, m);
    });
    const tokens = new Map((spot?.tokens || []).map((t) => [t.index, t]));
    for (const u of spot?.universe || []) {
      const [b, q] = (u.tokens || []).map((i) => tokens.get(i));
      if (!b || !q) continue;
      const display = `${b.name}/${q.name}`;
      const m = { name: byName.has(display) ? u.name : display, coin: u.name, asset: 10000 + u.index, szDecimals: b.szDecimals, isSpot: true };
      if (!byName.has(m.name)) byName.set(m.name, m);
      byWire.set(u.name, m);
    }
    this.markets = { at: Date.now(), byName, byWire };
    return this.markets;
  }

  /** Resolve what the agent typed to one market. The canonical name (BTC, HYPE/USDC) is what the allow/block lists see. */
  async market(input) {
    if (typeof input !== "string" || !input.trim()) throw new Error("coin is required (e.g. BTC, or HYPE/USDC for spot)");
    const s = input.trim();
    if (s.includes(":")) throw new Error(`'${s}': builder-deployed perp markets (dex:COIN) aren't supported by TAS Guard yet`);
    const { byName, byWire } = await this.loadMarkets();
    let m = byName.get(s) || byWire.get(s);
    if (!m) {
      const hits = [...byName.values()].filter((x) => x.name.toLowerCase() === s.toLowerCase());
      if (hits.length === 1) m = hits[0];
    }
    if (!m) throw new Error(`Unknown coin '${s}' on Hyperliquid ${this.network}. Perps use names like BTC or ETH; spot uses pairs like HYPE/USDC.`);
    if (m.delisted) throw new Error(`${m.name} is delisted on Hyperliquid`);
    return m;
  }

  async mids() { return this.client.info({ type: "allMids" }); }
  async mid(m, mids) {
    const all = mids || (await this.mids());
    const px = Number(all?.[m.coin]);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`Hyperliquid has no mid price for ${m.name} right now`);
    return px;
  }

  // ---------- pricing an order before the policy sees it ----------
  /**
   * Validate and price hl_place_order. Returns { policyArgs, order } where policyArgs carries the canonical
   * coin and the notional the caps are checked against: size x limit price for buys (fills can only be
   * cheaper), and size x max(limit price, mid) for sells, so a far-below-market sell can't understate its
   * value. Market orders use the SDK's slippage price. The same prepared order is what gets signed and sent.
   */
  async prepare(name, args) {
    if (name !== "hl_place_order") return null;
    const m = await this.market(args.coin);
    const side = String(args.side ?? "").toLowerCase();
    if (side !== "buy" && side !== "sell") throw new Error("side must be 'buy' or 'sell'");
    const isBuy = side === "buy";
    const type = String(args.type ?? "").toLowerCase();
    if (type !== "limit" && type !== "market") throw new Error("type must be 'limit' or 'market'");
    const size = fitSize(args.size, m.szDecimals);
    if (!(size > 0)) throw new Error(`size ${args.size} rounds to 0: ${m.name} trades in steps of ${10 ** -m.szDecimals}`);
    const notes = [];
    if (size !== Number(args.size)) notes.push(`size rounded down to ${size} (${m.name} allows ${m.szDecimals} decimals)`);
    let price, tif, mid, slip;
    if (type === "limit") {
      if (args.price === undefined || args.price === null || args.price === "") throw new Error("limit orders need a price");
      if (args.max_slippage_pct !== undefined) throw new Error("max_slippage_pct applies to market orders only");
      price = fitLimitPrice(args.price, { isBuy, szDecimals: m.szDecimals, isSpot: m.isSpot });
      if (price !== Number(args.price)) notes.push(`price ${isBuy ? "rounded down" : "rounded up"} to ${price} to fit Hyperliquid's tick size`);
      tif = args.tif ?? "Gtc";
      if (!["Gtc", "Ioc", "Alo"].includes(tif)) throw new Error("tif must be Gtc, Ioc or Alo");
      if (!isBuy) mid = await this.mid(m).catch(() => undefined);
    } else {
      if (args.price !== undefined && args.price !== null && args.price !== "") throw new Error("market orders don't take a price; use max_slippage_pct to bound the fill, or a limit order");
      if (args.tif !== undefined && args.tif !== "Ioc") throw new Error("market orders are always immediate-or-cancel (Ioc)");
      slip = args.max_slippage_pct === undefined ? DEFAULT_SLIPPAGE_PCT : Number(args.max_slippage_pct);
      if (!(slip > 0 && slip <= MAX_SLIPPAGE_PCT)) throw new Error(`max_slippage_pct must be more than 0 and at most ${MAX_SLIPPAGE_PCT}`);
      mid = await this.mid(m);
      price = slippagePrice(mid, isBuy, slip / 100, m.szDecimals, m.isSpot);
      tif = "Ioc";
    }
    const reduceOnly = args.reduce_only === true;
    const wire = orderWire({ asset: m.asset, isBuy, price, size, reduceOnly, tif });
    const notional = isBuy ? size * price : mid !== undefined ? size * Math.max(price, mid) : undefined;
    return {
      // No price when the notional is unknown (a sell without a mid), so the policy treats the value as
      // unknown (unknown_value, "approve" by default) instead of falling back to size x limit price.
      policyArgs: { coin: m.name, side, size, ...(notional !== undefined ? { price, notional } : {}) },
      order: { market: m, side, isBuy, type, size, price, tif, reduceOnly, mid, slip, notional, wire, notes },
      audit: { coin: m.name, asset: m.asset, side, type, size: wire.s, price: wire.p, tif, reduce_only: reduceOnly, mid, notional: notional === undefined ? undefined : round2(notional), builder_fee: this.builder ? feePercent(this.builderFee) : "off" },
    };
  }

  /** One-line description for approvals, alerts and the audit log. */
  summarize(name, args, prep) {
    const o = prep?.order;
    if (!o) return `${name}${args?.coin ? ": " + args.coin : ""}${args?.oid !== undefined ? " #" + args.oid : ""}${args?.leverage !== undefined ? ` ${args.leverage}x${args.is_cross === false ? " isolated" : ""}` : ""}`;
    const how = o.type === "limit" ? `limit ${o.price} ${o.tif}` : `market (max slippage ${o.slip}%, worst price ${o.price})`;
    const val = o.notional === undefined ? "value unknown" : `≈ ${round2(o.notional).toLocaleString("en-US")} USDC`;
    const fee = this.builder && !(o.market.isSpot && o.isBuy) ? `, + ${feePercent(this.builderFee)} builder fee` : ""; // Hyperliquid charges no builder fee on spot buys
    return `${name}: ${o.side.toUpperCase()} ${o.size} ${o.market.name} ${how}${o.reduceOnly ? " reduce-only" : ""}, ${val}${fee} [Hyperliquid ${this.network}]`;
  }

  // ---------- tools ----------
  async callTool(name, args, prepared) {
    try {
      switch (name) {
        case "hl_get_account": return text(await this.account_());
        case "hl_get_mids": return text(await this.mids_(args.coins));
        case "hl_get_open_orders": return text(await this.openOrders_());
        case "hl_place_order": return await this.placeOrder(prepared || (await this.prepare(name, args)));
        case "hl_cancel_order": return await this.cancel(args);
        case "hl_close_position": return await this.closePosition(args);
        case "hl_update_leverage": return await this.leverage(args);
        default: return fail(`Unknown tool '${name}'`);
      }
    } catch (e) {
      if (e.unknownOutcome && ["hl_place_order", "hl_close_position", "hl_cancel_order", "hl_update_leverage"].includes(name)) {
        return fail(`TAS Guard ${e.message}. The action may or may not have reached Hyperliquid: check hl_get_open_orders and hl_get_account before trying again.`);
      }
      return fail(e.message);
    }
  }

  async account_() {
    const [perps, spot] = await Promise.all([this.client.info({ type: "clearinghouseState", user: this.account }), this.client.info({ type: "spotClearinghouseState", user: this.account })]);
    return {
      network: this.network, account: this.account,
      perps: { margin_summary: perps?.marginSummary, cross_margin_summary: perps?.crossMarginSummary, withdrawable: perps?.withdrawable, positions: (perps?.assetPositions || []).map((p) => p.position) },
      spot_balances: (spot?.balances || []).filter((b) => Number(b.total) !== 0),
    };
  }

  async mids_(coins) {
    const [all, { byWire }] = await Promise.all([this.mids(), this.loadMarkets()]);
    if (Array.isArray(coins) && coins.length) {
      const out = {};
      for (const c of coins) { const m = await this.market(c); out[m.name] = all?.[m.coin] ?? null; }
      return out;
    }
    const out = {};
    for (const [wire, px] of Object.entries(all || {})) out[byWire.get(wire)?.name || wire] = px;
    return out;
  }

  async openOrders_() {
    const [orders, { byWire }] = await Promise.all([this.client.info({ type: "openOrders", user: this.account }), this.loadMarkets()]);
    return (orders || []).map((o) => ({ coin: byWire.get(o.coin)?.name || o.coin, side: o.side === "B" ? "buy" : o.side === "A" ? "sell" : o.side, size: o.sz, limit_price: o.limitPx, oid: o.oid, time: o.timestamp ? new Date(o.timestamp).toISOString() : undefined }));
  }

  async send(action) {
    if (this.walletProblem) throw new Error(this.walletProblem);
    const nonce = this.client.nonce();
    const { signature } = signL1Action(this.#key, action, { nonce, mainnet: !this.testnet });
    return this.client.exchange({ action, nonce, signature, vaultAddress: null, expiresAfter: null });
  }

  /** Turn a Hyperliquid rejection into a message that says what to do. */
  explain(msg) {
    const m = typeof msg === "string" ? msg : JSON.stringify(msg);
    if (/builder/i.test(m) && /approv|max.*fee|fee.*max/i.test(m)) {
      return `Hyperliquid rejected this because TAS Guard's ${feePercent(this.builderFee)} builder fee isn't approved for account ${this.account}. ` +
        `Approve it once with: npx tas-guard hl approve-fee${this.testnet ? " --testnet" : ""} (signs with your main wallet; run it yourself, not the agent). ` +
        `Or turn the fee off with TAS_GUARD_HL_BUILDER_FEE=0 and restart the guard. Hyperliquid said: ${m}`;
    }
    if (/builder/i.test(m)) return `Hyperliquid rejected TradingAgentStack's builder code: ${m}. You can trade without it by setting TAS_GUARD_HL_BUILDER_FEE=0 and restarting the guard.`;
    if (/does not exist/i.test(m)) return `Hyperliquid rejected this: ${m}. Check that the API wallet ${this.agent} is authorized for account ${this.account} at https://app.hyperliquid.xyz/API, and that HL_ACCOUNT is that account.`;
    return `Hyperliquid rejected this: ${m}`;
  }

  /** Read an /exchange response for a single order. Returns an MCP result. */
  orderResult(res, o, extra = {}) {
    if (res?.status !== "ok") return fail(this.explain(res?.response ?? res));
    const st = res.response?.data?.statuses?.[0];
    if (!st) return fail(`Unexpected response from Hyperliquid: ${JSON.stringify(res).slice(0, 300)}`);
    if (typeof st === "object" && st.error) return fail(this.explain(st.error));
    const out = {
      ok: true,
      status: st.resting ? "resting" : st.filled ? "filled" : typeof st === "string" ? st : Object.keys(st)[0],
      oid: st.resting?.oid ?? st.filled?.oid,
      ...(st.filled ? { filled_size: st.filled.totalSz, average_price: st.filled.avgPx } : {}),
      order: { coin: o.market.name, side: o.side, size: o.wire.s, price: o.wire.p, tif: o.tif, reduce_only: o.reduceOnly, type: o.type },
      ...(o.notional !== undefined ? { notional_usdc: round2(o.notional) } : {}),
      builder_fee: this.builder ? feePercent(this.builderFee) : "off",
      network: this.network,
      ...extra,
      ...(o.notes?.length ? { adjusted: o.notes } : {}),
    };
    return text(out);
  }

  async placeOrder(prep) {
    const o = prep.order;
    const res = await this.send(orderAction([o.wire], this.builder));
    return this.orderResult(res, o);
  }

  async cancel(args) {
    const m = await this.market(args.coin);
    const oid = Number(args.oid);
    if (!Number.isSafeInteger(oid) || oid < 0) throw new Error("oid must be the order's integer id (see hl_get_open_orders)");
    const res = await this.send(cancelAction([{ asset: m.asset, oid }]));
    if (res?.status !== "ok") return fail(this.explain(res?.response ?? res));
    const st = res.response?.data?.statuses?.[0];
    if (st && typeof st === "object" && st.error) return fail(this.explain(st.error));
    return text({ ok: true, cancelled: { coin: m.name, oid }, network: this.network });
  }

  async closePosition(args) {
    const m = await this.market(args.coin);
    if (m.isSpot) throw new Error(`${m.name} is a spot pair: there's no position to close. Sell it with hl_place_order instead.`);
    const state = await this.client.info({ type: "clearinghouseState", user: this.account });
    const pos = (state?.assetPositions || []).map((p) => p.position).find((p) => p?.coin === m.coin);
    const szi = Number(pos?.szi);
    if (!pos || !Number.isFinite(szi) || szi === 0) throw new Error(`No open ${m.name} position to close`);
    const full = fitSize(Math.abs(szi), m.szDecimals);
    let size = full;
    if (args.size !== undefined && args.size !== null && args.size !== "") {
      size = fitSize(args.size, m.szDecimals);
      if (!(size > 0)) throw new Error("size rounds to 0");
      if (size > full) throw new Error(`size ${size} is more than the open position (${full} ${m.name})`);
    }
    const slip = args.max_slippage_pct === undefined ? DEFAULT_SLIPPAGE_PCT : Number(args.max_slippage_pct);
    if (!(slip > 0 && slip <= MAX_SLIPPAGE_PCT)) throw new Error(`max_slippage_pct must be more than 0 and at most ${MAX_SLIPPAGE_PCT}`);
    const isBuy = szi < 0;
    const mid = await this.mid(m);
    const price = slippagePrice(mid, isBuy, slip / 100, m.szDecimals, false);
    const wire = orderWire({ asset: m.asset, isBuy, price, size, reduceOnly: true, tif: "Ioc" });
    const o = { market: m, side: isBuy ? "buy" : "sell", isBuy, type: "market", size, price, tif: "Ioc", reduceOnly: true, wire, notional: size * Math.max(price, mid) };
    const res = await this.send(orderAction([wire], this.builder));
    return this.orderResult(res, o, { closed: `${size} of ${full} ${m.name} (${szi > 0 ? "long" : "short"})` });
  }

  async leverage(args) {
    const m = await this.market(args.coin);
    if (m.isSpot) throw new Error("Leverage applies to perps only");
    const lev = Number(args.leverage);
    if (!Number.isInteger(lev) || lev < 1) throw new Error("leverage must be a whole number of at least 1");
    if (m.maxLeverage && lev > m.maxLeverage) throw new Error(`${m.name} allows at most ${m.maxLeverage}x`);
    const isCross = args.is_cross !== false;
    if (isCross && m.onlyIsolated) throw new Error(`${m.name} is isolated-margin only: set is_cross to false`);
    const res = await this.send(updateLeverageAction({ asset: m.asset, isCross, leverage: lev }));
    if (res?.status !== "ok") return fail(this.explain(res?.response ?? res));
    return text({ ok: true, coin: m.name, leverage: lev, margin: isCross ? "cross" : "isolated", network: this.network });
  }
}

/**
 * `tas-guard hl approve-fee`: sign approveBuilderFee once with the MAIN wallet key, so Hyperliquid accepts
 * orders carrying TradingAgentStack's builder code. The key is read from HL_MAIN_PRIVATE_KEY for this
 * command only; it's never stored or logged.
 */
export async function approveFee({ testnet = false, yes = false, env = process.env, fetch, baseUrl, builderAddress = BUILDER_ADDRESS, builderFee = BUILDER_FEE, out = (s) => console.log(s), confirm, nonce: fixedNonce }) {
  if (!builderAddress) throw new Error("This build of TAS Guard has no builder address set (src/hl-fee.js), so there is no builder fee to approve.");
  if (!isAddress(builderAddress)) throw new Error(`builder address '${builderAddress}' is not a 0x address`);
  if (!env.HL_MAIN_PRIVATE_KEY) throw new Error("Set HL_MAIN_PRIVATE_KEY to your MAIN wallet's private key for this one command (Hyperliquid requires the main wallet, not the API wallet, to approve a builder fee). It isn't stored or logged.");
  let key;
  try { key = parsePrivateKey(env.HL_MAIN_PRIVATE_KEY); } catch (e) { throw new Error(`HL_MAIN_PRIVATE_KEY: ${e.message}`); }
  const user = privateKeyToAddress(key);
  if (env.HL_ACCOUNT && isAddress(env.HL_ACCOUNT) && env.HL_ACCOUNT.toLowerCase() !== user) {
    throw new Error(`HL_MAIN_PRIVATE_KEY belongs to ${user}, but HL_ACCOUNT is ${env.HL_ACCOUNT.toLowerCase()}. Use the main wallet of the account you trade.`);
  }
  const network = testnet ? "Testnet" : "Mainnet";
  const rate = feePercent(builderFee);
  const builder = builderAddress.toLowerCase();
  out(`Approving a builder fee on Hyperliquid ${network}:
  account:      ${user}
  builder:      ${builder} (TradingAgentStack)
  max fee rate: ${rate} of each order's notional

This lets TAS Guard's orders for this account carry TradingAgentStack's ${rate} builder fee, which funds
the project and shows up in Hyperliquid's own fee breakdown. It doesn't give anyone access to your funds.
Don't want it? Skip this and set TAS_GUARD_HL_BUILDER_FEE=0 instead.`);
  if (!yes) {
    const ok = confirm ? await confirm() : await askYes();
    if (!ok) { out("Not approved. Nothing was signed."); return { approved: false }; }
  }
  const client = new HlClient({ testnet, fetch, baseUrl });
  const nonce = fixedNonce ?? client.nonce();
  const { action, signature } = signApproveBuilderFee(key, { builder, maxFeeRate: rate, nonce, mainnet: !testnet });
  const res = await client.exchange({ action, nonce, signature, vaultAddress: null, expiresAfter: null });
  if (res?.status !== "ok") throw new Error(`Hyperliquid rejected the approval: ${typeof res?.response === "string" ? res.response : JSON.stringify(res)}`);
  let max;
  try { max = Number(await client.info({ type: "maxBuilderFee", user, builder })); } catch {}
  out(`Approved. ${Number.isFinite(max) ? `Hyperliquid now allows this builder up to ${feePercent(max)} on account ${user}. ` : ""}You can unset HL_MAIN_PRIVATE_KEY now.`);
  return { approved: true, action, response: res, max };
}

async function askYes() {
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal to confirm, or add --yes.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question("Sign this approval? Type yes to continue: ")).trim()); } finally { rl.close(); }
}
