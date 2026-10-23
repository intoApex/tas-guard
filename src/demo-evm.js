// A tiny in-process mock EVM JSON-RPC node, for `tas-guard rpc-demo` and the tests.
// No chain, no keys, no real money: it answers reads with fixed values, "mines" every transaction
// instantly, returns fake hashes and signatures, and reverts calls to one demo contract.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const DEMO_REVERT_CONTRACT = "0x0000000000000000000000000000000000000bad";
const hex = (n) => "0x" + BigInt(n).toString(16);

/** ABI-encoded Error(string), like a Solidity `require(false, reason)`. */
export function encodeRevert(reason) {
  const b = Buffer.from(reason, "utf8");
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  return "0x08c379a0" + word(32) + word(b.length) + b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0");
}

/**
 * @param {object} [o]
 * @param {number} [o.chainId]
 * @param {Record<string, number>} [o.nonces]   starting nonce per address
 * @param {string} [o.rawSender]                whose nonce a raw transaction advances (the mock can't recover senders either)
 * @param {(tx:object)=>string|null} [o.revert] return a revert reason to make eth_call / eth_estimateGas fail
 */
export async function startMockEvm({ chainId = 8453, nonces = {}, rawSender, revert } = {}) {
  const s = { chainId, calls: [], nonces: Object.fromEntries(Object.entries(nonces).map(([a, n]) => [a.toLowerCase(), n])) };
  const reverts = revert || ((tx) => (String(tx.to || "").toLowerCase() === DEMO_REVERT_CONTRACT ? "Vault: deposits are paused" : /^0xdeadbeef/i.test(tx.data || tx.input || "") ? "demo: always reverts" : null));
  const fakeHash = (x) => "0x" + createHash("sha256").update(JSON.stringify(x)).digest("hex");
  const bump = (a) => { if (a) s.nonces[a.toLowerCase()] = (s.nonces[a.toLowerCase()] || 0) + 1; };

  function answer(m) {
    const p = m.params || [];
    s.calls.push({ method: m.method, params: p });
    const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
    const err = (code, message, data) => ({ jsonrpc: "2.0", id: m.id, error: { code, message, ...(data ? { data } : {}) } });
    switch (m.method) {
      case "eth_chainId": return ok(hex(s.chainId));
      case "net_version": return ok(String(s.chainId));
      case "eth_blockNumber": return ok("0x1234567");
      case "eth_gasPrice": return ok("0x3b9aca00");
      case "eth_maxPriorityFeePerGas": return ok("0x5f5e100");
      case "eth_getBalance": return ok("0x56bc75e2d63100000"); // 100 ETH
      case "eth_getCode": return ok("0x");
      case "eth_getTransactionCount": return ok(hex(s.nonces[String(p[0]).toLowerCase()] || 0));
      case "eth_call":
      case "eth_estimateGas": {
        const why = reverts(p[0] || {});
        if (why) return err(3, `execution reverted: ${why}`, encodeRevert(why));
        return ok(m.method === "eth_call" ? "0x" : "0x5208");
      }
      case "eth_sendRawTransaction":
      case "eth_sendRawTransactionSync": bump(rawSender); return ok(fakeHash(p));
      case "eth_sendTransaction": bump(p[0]?.from); return ok(fakeHash(p));
      case "eth_signTypedData_v4":
      case "eth_signTypedData":
      case "personal_sign":
      case "eth_sign": return ok("0x" + "ab".repeat(65));
      default: return err(-32601, `the method ${m.method} does not exist/is not available`);
    }
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const out = Array.isArray(msg) ? msg.map(answer) : answer(msg);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    s,
    sends: () => s.calls.filter((c) => /^eth_send|sign/.test(c.method)),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
