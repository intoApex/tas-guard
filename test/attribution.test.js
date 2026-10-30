// Base Builder Code (ERC-8021) attribution: encoding, the attribute() rules, and onchain mode end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataSuffix, hasAttribution, attribute, builderCode, attributionOptedOut } from "../src/base-attribution.js";
import { RpcGuard } from "../src/rpc.js";
import { resolveOnchainPolicy } from "../src/onchain-policy.js";
import { State } from "../src/state.js";
import { startMockEvm } from "../src/demo-evm.js";
import { calldata, USDC } from "./evm-helpers.js";

const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FRIEND = "0x1111111111111111111111111111111111111111";
const CODE = "bc_b7k3p9da";
// Reference values from ox's Attribution.toDataSuffix (ox/erc8021), the encoder Base's docs use.
const OX_ONE = "0x62635f62376b33703964610b0080218021802180218021802180218021";
const OX_TWO = "0x612c6263040080218021802180218021802180218021";

test("dataSuffix matches the ERC-8021 reference encoder", () => {
  assert.equal(dataSuffix(CODE), OX_ONE);
  assert.equal(dataSuffix(["a", "bc"]), OX_TWO);
  assert.ok(hasAttribution("0xa9059cbb" + OX_ONE.slice(2)));
  assert.ok(!hasAttribution("0xa9059cbb"));
  for (const bad of ["", "has space", "a,b", "x".repeat(33), "café"]) assert.throws(() => dataSuffix(bad), /invalid Builder Code/);
});

test("attribute: Base only, unsigned calldata only, never twice, gas raised by the suffix's calldata gas", () => {
  const tx = { from: WALLET, to: USDC, data: calldata.transfer(FRIEND, 1e6) };
  const a = attribute(tx, 8453, CODE);
  assert.equal(a.applied, true);
  assert.equal(a.tx.data, tx.data + OX_ONE.slice(2));
  assert.equal(tx.data.length < a.tx.data.length && tx !== a.tx, true, "returns a new object, the input is untouched");
  assert.equal(attribute(tx, 84532, CODE).applied, true, "Base Sepolia too");
  assert.deepEqual([attribute(tx, 1, CODE).applied, attribute(tx, 1, CODE).why], [false, "not Base"]);
  assert.deepEqual([attribute(tx, 8453, null).applied, attribute(tx, 8453, null).why], [false, "no Builder Code"]);
  const tagged = { ...tx, data: tx.data + dataSuffix("bc_otherapp").slice(2) };
  assert.equal(attribute(tagged, 8453, CODE).why, "already has a Builder Code", "another app's code is left alone");
  // 'input' instead of 'data' keeps the same key
  const viaInput = attribute({ from: WALLET, to: FRIEND, input: "0x" }, 8453, CODE);
  assert.equal(viaInput.tx.input, OX_ONE);
  assert.equal(viaInput.tx.data, undefined);
  // no calldata at all (a plain ETH transfer)
  assert.equal(attribute({ from: WALLET, to: FRIEND, value: "0x1" }, 8453, CODE).tx.data, OX_ONE);
  // gas: 27 non-zero bytes x 16 + 2 zero bytes x 4 for OX_ONE (29 bytes: 11 code + length + schema 0x00 + 16 marker)
  const bytes = Buffer.from(OX_ONE.slice(2), "hex");
  const want = [...bytes].reduce((g, b) => g + (b === 0 ? 4 : 16), 0);
  assert.equal(BigInt(attribute({ ...tx, gas: "0x5208" }, 8453, CODE).tx.gas), 0x5208n + BigInt(want));
});

test("builderCode: opt-out, the user's own code, invalid values rejected", () => {
  assert.equal(builderCode({}, CODE), CODE);
  assert.equal(builderCode({}, null), null);
  for (const v of ["0", "false", "OFF", " no "]) { assert.equal(attributionOptedOut({ TAS_GUARD_BASE_BUILDER_CODE: v }), true); assert.equal(builderCode({ TAS_GUARD_BASE_BUILDER_CODE: v }, CODE), null); }
  assert.equal(builderCode({ TAS_GUARD_BASE_BUILDER_CODE: "bc_mine1234" }, CODE), "bc_mine1234");
  assert.throws(() => builderCode({ TAS_GUARD_BASE_BUILDER_CODE: "not a code" }, CODE), /isn't a Builder Code/);
});

async function guardOn(chainId, code) {
  const chain = await startMockEvm({ chainId, nonces: { [WALLET]: 3 }, rawSender: WALLET });
  const logs = [];
  const guard = new RpcGuard({
    upstream: chain.url, wallets: [WALLET], builderCode: code, log: (s) => logs.push(s),
    policy: resolveOnchainPolicy({ chains_allow: [chainId], native_usd: { [chainId]: 3000 }, tokens: { [USDC]: { symbol: "USDC", decimals: 6, usd_price: "stable" } }, max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 50, recipients_allow: [FRIEND] }),
    state: new State(mkdtempSync(join(tmpdir(), "tg-attr-")), "evm"),
  });
  const url = await guard.listen("127.0.0.1", 0);
  const call = async (method, params) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
  const lastSend = () => chain.s.calls.filter((c) => c.method === "eth_sendTransaction").at(-1);
  return { chain, guard, call, logs, lastSend, stop: async () => { await guard.close(); await chain.close(); } };
}

test("onchain mode on Base: eth_sendTransaction is forwarded with the Builder Code; status and log say so", async () => {
  const g = await guardOn(8453, CODE);
  try {
    const data = calldata.transfer(FRIEND, 20e6);
    assert.ok((await g.call("eth_sendTransaction", [{ from: WALLET, to: USDC, data }])).result);
    assert.equal(g.lastSend().params[0].data, data + OX_ONE.slice(2));
    assert.equal((await g.call("tas_guardStatus", [])).result.base_builder_code, CODE);
    assert.ok(g.logs.some((l) => /Base Builder Code bc_b7k3p9da is added.*TAS_GUARD_BASE_BUILDER_CODE=0/.test(l)));
    // the limits still apply to the transaction's real value
    assert.match((await g.call("eth_sendTransaction", [{ from: WALLET, to: USDC, data: calldata.transfer(FRIEND, 150e6) }])).error.message, /per-transaction limit/);
  } finally { await g.stop(); }
});

test("onchain mode: nothing is added off Base or without a code", async () => {
  for (const [chainId, code] of [[1, CODE], [8453, null]]) {
    const g = await guardOn(chainId, code);
    try {
      const data = calldata.transfer(FRIEND, 10e6);
      assert.ok((await g.call("eth_sendTransaction", [{ from: WALLET, to: USDC, data }])).result);
      assert.equal(g.lastSend().params[0].data, data, `chain ${chainId}, code ${code}`);
      assert.equal((await g.call("tas_guardStatus", [])).result.base_builder_code, null);
    } finally { await g.stop(); }
  }
});
