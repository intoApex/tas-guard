#!/usr/bin/env node
// Demo paper broker for `tas-guard demo`: a tiny MCP server with Alpaca-style tool names, an in-memory
// $100,000 paper account and simulated prices. No network, no real money, nothing persists.
// It exists so you can try TAS Guard in seconds, and so directories can start the guard and list its tools.

const PRICES = { SPY: 580, QQQ: 495, AAPL: 230, MSFT: 420, NVDA: 135, TSLA: 250 };
const state = { cash: 100000, positions: {}, orders: [], seq: 0 };
const str = { type: "string" };
const tools = [
  { name: "get_account_info", description: "Demo paper account: cash, equity and buying power.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_stock_latest_quote", description: "Simulated latest quote for a symbol (demo prices).", inputSchema: { type: "object", properties: { symbol: str }, required: ["symbol"] }, annotations: { readOnlyHint: true } },
  { name: "get_all_positions", description: "Open positions in the demo account.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_orders", description: "Orders in the demo account.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "place_stock_order", description: "Place a demo stock order. Market orders fill at the simulated price; limit orders rest until cancelled.",
    inputSchema: { type: "object", properties: { symbol: str, side: { type: "string", enum: ["buy", "sell"] }, qty: str, notional: str, type: { type: "string", enum: ["market", "limit"] }, limit_price: str }, required: ["symbol", "side"] },
    annotations: { destructiveHint: true } },
  { name: "cancel_order_by_id", description: "Cancel one demo order.", inputSchema: { type: "object", properties: { order_id: str }, required: ["order_id"] }, annotations: { destructiveHint: true } },
  { name: "cancel_all_orders", description: "Cancel every open demo order.", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "close_all_positions", description: "Sell every demo position at the simulated price.", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "update_account_config", description: "Change account settings (blocked by TAS Guard by default).", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
];

const price = (s) => PRICES[String(s || "").toUpperCase()] ?? 100;
const equity = () => state.cash + Object.entries(state.positions).reduce((a, [s, q]) => a + q * price(s), 0);
const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify({ demo: true, ...o }, null, 1) }] });
const err = (m) => ({ content: [{ type: "text", text: JSON.stringify({ demo: true, error: m }) }], isError: true });

function call(name, a = {}) {
  switch (name) {
    case "get_account_info": return ok({ account: "DEMO-PAPER", status: "ACTIVE", cash: +state.cash.toFixed(2), equity: +equity().toFixed(2), buying_power: +state.cash.toFixed(2) });
    case "get_stock_latest_quote": { const p = price(a.symbol); return ok({ symbol: String(a.symbol).toUpperCase(), bid: +(p * 0.9995).toFixed(2), ask: +(p * 1.0005).toFixed(2), note: "simulated" }); }
    case "get_all_positions": return ok({ positions: Object.entries(state.positions).filter(([, q]) => q).map(([symbol, qty]) => ({ symbol, qty, market_value: +(qty * price(symbol)).toFixed(2) })) });
    case "get_orders": return ok({ orders: state.orders });
    case "place_stock_order": {
      const sym = String(a.symbol || "").toUpperCase(); if (!sym) return err("symbol is required");
      const side = a.side === "sell" ? "sell" : "buy", p = price(sym);
      const qty = a.qty !== undefined ? Number(a.qty) : a.notional !== undefined ? Number(a.notional) / p : NaN;
      if (!(qty > 0)) return err("give qty or notional");
      const o = { id: `demo-${++state.seq}`, symbol: sym, side, qty: +qty.toFixed(6), type: a.type === "limit" || a.limit_price ? "limit" : "market", limit_price: a.limit_price ? Number(a.limit_price) : undefined, status: "accepted" };
      if (o.type === "market") {
        const cost = qty * p * (side === "buy" ? 1 : -1);
        if (side === "buy" && cost > state.cash) return err("insufficient demo buying power");
        state.cash -= cost; state.positions[sym] = (state.positions[sym] || 0) + (side === "buy" ? qty : -qty); o.status = "filled"; o.filled_avg_price = p;
      }
      state.orders.push(o); return ok({ order: o });
    }
    case "cancel_order_by_id": { const o = state.orders.find((x) => x.id === a.order_id && x.status === "accepted"); if (!o) return err("no open order with that id"); o.status = "canceled"; return ok({ order: o }); }
    case "cancel_all_orders": { const open = state.orders.filter((x) => x.status === "accepted"); open.forEach((o) => (o.status = "canceled")); return ok({ canceled: open.length }); }
    case "close_all_positions": { let n = 0; for (const [s, q] of Object.entries(state.positions)) if (q) { state.cash += q * price(s); state.positions[s] = 0; n++; } return ok({ closed: n }); }
    case "update_account_config": return ok({ updated: true });
    default: return err("unknown tool " + name);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") send({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tas-guard-demo-broker", version: "1" }, instructions: "Demo paper broker for TAS Guard. Simulated prices, no real money." });
    else if (m.method === "tools/list") send({ tools });
    else if (m.method === "tools/call") send(call(m.params?.name, m.params?.arguments || {}));
    else if (m.method === "ping") send({});
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
