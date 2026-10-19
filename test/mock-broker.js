// A fake broker MCP server for tests. Exposes Alpaca- and ccxt-named tools and logs every call it receives.
import { appendFileSync } from "node:fs";

const LOG = process.env.MOCK_LOG;
const tools = [
  { name: "get_account_info", description: "Account info", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "place_stock_order", description: "Place a stock order", inputSchema: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string" }, qty: { type: "string" }, notional: { type: "string" }, limit_price: { type: "string" } } } },
  { name: "place_option_order", description: "Place an option order", inputSchema: { type: "object", properties: {} } },
  { name: "cancel_order_by_id", description: "Cancel", inputSchema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "close_all_positions", description: "Close all", inputSchema: { type: "object", properties: {} } },
  { name: "update_account_config", description: "Account config", inputSchema: { type: "object", properties: {} } },
  { name: "create_order", description: "ccxt create order", inputSchema: { type: "object", properties: {} } },
  { name: "mystery_tool", description: "Not in any profile", inputSchema: { type: "object", properties: {} } },
];

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

function handle(m) {
  if (m.id === undefined) return; // notifications
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-broker", version: "1" }, instructions: "Mock broker." } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/call") {
    const { name, arguments: args = {} } = m.params;
    if (LOG) appendFileSync(LOG, JSON.stringify({ name, args }) + "\n");
    if (name === "create_order" && !args.confirm) return send({ jsonrpc: "2.0", id: m.id, result: text({ ok: true, preview: true, confirmToken: "tok-1" }) });
    if (name === "place_stock_order" && args.symbol === "REJECT") return send({ jsonrpc: "2.0", id: m.id, result: { ...text({ error: "insufficient buying power" }), isError: true } });
    return send({ jsonrpc: "2.0", id: m.id, result: text({ ok: true, tool: name, args }) });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
}
