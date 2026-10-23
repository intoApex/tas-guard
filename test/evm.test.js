// Onchain mode, unit level: RLP and transaction decoding, calldata, typed data, and the policy decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rlpDecode, hexToBytes, bytesToHex, decodeRawTx, decodeCall, decodeTypedData, revertReason, normalizeTxObject, isUnlimited } from "../src/evm.js";
import { decideOnchain, resolveOnchainPolicy, describe, formatUnits } from "../src/onchain-policy.js";
import { encodeRevert } from "../src/demo-evm.js";
import { rawTx, calldata, MAX, USDC, permit2Single, erc2612 } from "./evm-helpers.js";

const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const FRIEND = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x4444444444444444444444444444444444444444";
const WETH = "0x4200000000000000000000000000000000000006";

// Real EIP-155 example transaction from the EIP: nonce 9, 20 gwei, 21000 gas, 1 ETH to 0x3535..., chain 1.
const EIP155 = "0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83";
// EIP-1559 on Base: nonce 7, 1/2 gwei, 65000 gas, USDC.transfer(0x2222..., 25 USDC). Hand-checked field by field.
const TX1559 = "0x02f8b182210507843b9aca00847735940082fde894833589fcd6edb6e08f4c7c32d4f71b54bda0291380b844a9059cbb000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000017d7840c001a01b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ba02c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c";
// EIP-2930 on mainnet: nonce 0, 20 gwei, 1 ETH to 0x3535..., one access-list entry.
const TX2930 = "0x01f8a701808504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080f838f7943535353535353535353535353535353535353535e1a0000000000000000000000000000000000000000000000000000000000000000180a01b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ba02c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c";

test("RLP: canonical vectors decode, malformed input is rejected", () => {
  const s = (x) => Buffer.from(x).toString();
  assert.equal(s(rlpDecode(hexToBytes("0x83646f67"))), "dog");
  assert.deepEqual(rlpDecode(hexToBytes("0xc88363617483646f67")).map(s), ["cat", "dog"]);
  assert.equal(rlpDecode(hexToBytes("0x80")).length, 0);
  assert.deepEqual(rlpDecode(hexToBytes("0xc0")), []);
  assert.equal(bytesToHex(rlpDecode(hexToBytes("0x0f"))), "0x0f");
  const long = "Lorem ipsum dolor sit amet, consectetur adipisicing elit";
  assert.equal(s(rlpDecode(hexToBytes("0xb838" + Buffer.from(long).toString("hex")))), long);
  assert.deepEqual(rlpDecode(hexToBytes("0xc7c0c1c0c3c0c1c0")).length, 3, "set theoretical representation of three");
  assert.throws(() => rlpDecode(hexToBytes("0x8100")), /non-canonical/);
  assert.throws(() => rlpDecode(hexToBytes("0x83646f")), /truncated/);
  assert.throws(() => rlpDecode(hexToBytes("0x83646f6700")), /trailing/);
  assert.throws(() => rlpDecode(hexToBytes("0xb80100")), /non-canonical long/);
  assert.throws(() => hexToBytes("0x123"), /hex/);
});

test("legacy transaction: the EIP-155 example vector", () => {
  const t = decodeRawTx(EIP155);
  assert.equal(t.type, 0);
  assert.equal(t.chainId, 1n);
  assert.equal(t.nonce, 9n);
  assert.equal(t.gasPrice, 20_000_000_000n);
  assert.equal(t.gas, 21000n);
  assert.equal(t.to, "0x3535353535353535353535353535353535353535");
  assert.equal(t.value, 10n ** 18n);
  assert.equal(t.data, "0x");
  assert.equal(decodeRawTx(rawTx({ type: 0, chainId: null, to: FRIEND, value: 1n })).chainId, null, "pre-EIP-155 has no chain id");
});

test("EIP-1559 and EIP-2930 transactions decode; unsupported types and bad fields are rejected", () => {
  const t = decodeRawTx(TX1559);
  assert.deepEqual([t.type, t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas, t.to, t.value], [2, 8453n, 7n, 1_000_000_000n, 2_000_000_000n, 65000n, USDC, 0n]);
  assert.equal(t.data, calldata.transfer(STRANGER, 25_000_000));
  const a = decodeRawTx(TX2930);
  assert.deepEqual([a.type, a.chainId, a.nonce, a.gasPrice, a.gas, a.value, a.yParity], [1, 1n, 0n, 20_000_000_000n, 21000n, 10n ** 18n, 0n]);
  assert.equal(decodeRawTx(rawTx({ type: 2, to: null, data: "0x6000" })).to, null, "contract creation");
  assert.throws(() => decodeRawTx("0x04" + TX1559.slice(4)), /EIP-7702/);
  assert.throws(() => decodeRawTx("0x03c0"), /blob/);
  assert.throws(() => decodeRawTx(TX1559.slice(0, -2)), /RLP/);
  assert.throws(() => decodeRawTx(rawTx({ nonce: Buffer.from([0, 7]), to: FRIEND })), /leading zero/, "integers must be minimal, like nodes require");
  assert.throws(() => decodeRawTx(rawTx({ to: "0x1234" })), /20 bytes/);
});

test("calldata: native, ERC-20 transfer / transferFrom / approve / increaseAllowance, NFT and Permit2 approvals, generic calls", () => {
  assert.deepEqual(decodeCall({ to: FRIEND, value: 5n, data: "0x" }), { kind: "native_transfer", recipient: FRIEND, value: 5n });
  const tr = decodeCall({ to: USDC, data: calldata.transfer(STRANGER, 25_000_000) });
  assert.deepEqual([tr.kind, tr.asset, tr.recipient, tr.amount], ["erc20_transfer", USDC, STRANGER, 25_000_000n]);
  const tf = decodeCall({ to: USDC, data: calldata.transferFrom(WALLET, STRANGER, 7) });
  assert.deepEqual([tf.kind, tf.owner, tf.recipient, tf.amount], ["erc20_transfer", WALLET, STRANGER, 7n]);
  const ap = decodeCall({ to: USDC, data: calldata.approve(ROUTER, MAX) });
  assert.deepEqual([ap.kind, ap.spender, ap.items[0].asset, ap.items[0].amount], ["approval", ROUTER, USDC, MAX]);
  assert.equal(decodeCall({ to: USDC, data: calldata.increaseAllowance(ROUTER, 1) }).via, "increaseAllowance");
  const nft = decodeCall({ to: WETH, data: calldata.setApprovalForAll(ROUTER, true) });
  assert.deepEqual([nft.kind, nft.operator, nft.approved], ["approval_for_all", ROUTER, true]);
  const p2 = decodeCall({ to: "0x000000000022d473030f116ddee9f6b43ac78ba3", data: calldata.permit2Approve(USDC, ROUTER, (1n << 160n) - 1n, 1893456000) });
  assert.deepEqual([p2.kind, p2.spender, p2.items[0].asset, p2.items[0].bits], ["approval", ROUTER, USDC, 160]);
  assert.ok(isUnlimited(p2.items[0].amount, 160));
  assert.deepEqual(decodeCall({ to: ROUTER, data: "0x3593564c" + "00".repeat(64) }), { kind: "contract_call", selector: "0x3593564c", value: 0n });
  assert.equal(decodeCall({ to: USDC, data: "0xa9059cbb" + "00".repeat(32) }).kind, "contract_call", "truncated args aren't trusted as a transfer");
  assert.equal(decodeCall({ to: null, data: "0x6000" }).kind, "deploy");
  assert.equal(normalizeTxObject({ from: WALLET, to: USDC, value: "0x10", input: "0xABCD" }).data, "0xabcd");
  assert.throws(() => normalizeTxObject({ from: WALLET, to: USDC, data: "0x01", input: "0x02" }), /different/);
});

test("typed data: ERC-2612, DAI, Permit2 single/batch/transfer are permits; anything else is plain typed data", () => {
  const p = decodeTypedData(erc2612({ value: 5_000_000, spender: ROUTER, owner: WALLET }));
  assert.deepEqual([p.kind, p.via, p.spender, p.items[0].asset, p.items[0].amount, p.deadline, p.chainId], ["approval", "ERC-2612 permit", ROUTER, USDC, 5_000_000n, 1893456000n, 8453n]);
  const s = decodeTypedData(JSON.stringify(permit2Single({ amount: (1n << 160n) - 1n, spender: ROUTER })));
  assert.equal(s.via, "Permit2 PermitSingle");
  assert.ok(isUnlimited(s.items[0].amount, s.items[0].bits));
  const batch = permit2Single({ amount: 1, spender: ROUTER });
  batch.primaryType = "PermitBatch"; batch.message.details = [batch.message.details, { token: WETH, amount: "2", expiration: "0", nonce: "0" }];
  assert.deepEqual(decodeTypedData(batch).items.map((i) => i.asset), [USDC, WETH]);
  const tf = { primaryType: "PermitTransferFrom", domain: { name: "Permit2", chainId: 8453, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, message: { permitted: { token: USDC, amount: "1000000" }, spender: ROUTER, nonce: "1", deadline: "1893456000" } };
  assert.deepEqual([decodeTypedData(tf).kind, decodeTypedData(tf).items[0].amount], ["approval", 1_000_000n]);
  const dai = { primaryType: "Permit", domain: { name: "Dai Stablecoin", chainId: 1, verifyingContract: "0x6b175474e89094c44da98b954eedeac495271d0f" }, message: { holder: WALLET, spender: ROUTER, nonce: 0, expiry: 0, allowed: true } };
  assert.equal(decodeTypedData(dai).items[0].amount, MAX);
  const other = decodeTypedData({ primaryType: "Mail", domain: { name: "Ether Mail", chainId: 1 }, message: {} });
  assert.deepEqual([other.kind, other.primaryType], ["typed_data", "Mail"]);
});

test("revert reasons: Error(string), Panic, plain messages", () => {
  assert.equal(revertReason({ code: 3, message: "execution reverted", data: encodeRevert("ERC20: transfer amount exceeds balance") }), "ERC20: transfer amount exceeds balance");
  assert.equal(revertReason({ message: "execution reverted", data: "0x4e487b71" + "11".padStart(64, "0") }), "panic 0x11");
  assert.equal(revertReason({ message: "insufficient funds for transfer" }), "insufficient funds for transfer");
  assert.match(revertReason({ message: "execution reverted", data: "0x12345678" }), /custom error 0x12345678/);
});

// ---------- decisions ----------
const policy = resolveOnchainPolicy({
  chains_allow: [8453], native_usd: { 8453: 3000 },
  tokens: { [USDC]: { symbol: "USDC", decimals: 6, usd_price: "stable" }, [WETH]: { symbol: "WETH", decimals: 18, usd_price: 3000 } },
  max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 25, max_tx_per_minute: 5, max_tx_per_day: 10,
  recipients_allow: [FRIEND], contracts_allow: [ROUTER],
});
const wallets = new Set([WALLET]);
const usage0 = { spent: 0, orders: 0, recent: [] };
const sendOp = (tx, extra = {}) => ({ method: "eth_sendTransaction", send: true, from: WALLET, chainId: null, ...tx, ...decodeCall(tx), to: tx.to, ...extra });
const decide = (op, o = {}) => decideOnchain({ op, policy, usage: usage0, wallets, upstreamChainId: 8453, ...o });
const eth = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

test("USD caps: per-transaction limit, approval threshold, daily total (hard limits beat approval)", () => {
  assert.equal(decide(sendOp({ to: FRIEND, value: eth(0.005), data: "0x" })).action, "allow", "$15 to a known address");
  const mid = decide(sendOp({ to: FRIEND, value: eth(0.01), data: "0x" }));
  assert.deepEqual([mid.action, mid.spend], ["approve", 30]);
  assert.match(decide(sendOp({ to: FRIEND, value: eth(0.05), data: "0x" })).reason, /over the per-transaction limit/);
  const usdc = (n) => sendOp({ to: USDC, data: calldata.transfer(FRIEND, n * 1e6) });
  assert.equal(decide(usdc(20)).action, "allow");
  assert.equal(decide(usdc(101)).action, "block");
  const d = decide(usdc(20), { usage: { spent: 290, orders: 3, recent: [] } });
  assert.deepEqual([d.action, /daily limit/.test(d.reason)], ["block", true]);
  assert.match(decide(usdc(1), { usage: { spent: 0, orders: 10, recent: [] } }).reason, /Daily transaction limit/);
  const now = Date.now();
  assert.match(decide(usdc(1), { usage: { spent: 0, orders: 1, recent: Array(5).fill(now) }, now }).reason, /Rate limit/);
});

test("unknown token or missing native price -> unknown_value (approve by default, block if configured)", () => {
  const odd = sendOp({ to: "0x9999999999999999999999999999999999999999", data: calldata.transfer(FRIEND, 1) });
  const d = decide(odd);
  assert.deepEqual([d.action, /not in onchain.tokens/.test(d.reason)], ["approve", true]);
  assert.equal(decideOnchain({ op: odd, policy: resolveOnchainPolicy({ ...policy, unknown_value: "block" }), usage: usage0, wallets, upstreamChainId: 8453 }).action, "block");
  const p = resolveOnchainPolicy({ recipients_allow: [FRIEND] });
  assert.equal(decideOnchain({ op: sendOp({ to: FRIEND, value: 1n, data: "0x" }), policy: p, usage: usage0, wallets, upstreamChainId: 1 }).action, "approve", "no native_usd");
});

test("approvals: unlimited blocked, limited needs a human, over-limit allowance blocked, revokes allowed", () => {
  const ap = (amt, sp = ROUTER) => sendOp({ to: USDC, data: calldata.approve(sp, amt) });
  assert.match(decide(ap(MAX)).reason, /Unlimited allowance/);
  assert.equal(decide(ap(MAX)).action, "block");
  assert.equal(decide(ap(1n << 255n)).action, "block", ">= 2^255 counts as unlimited");
  assert.equal(decide(ap(10_000_000)).action, "approve", "any approval asks by default");
  assert.equal(decide(ap(500_000_000)).action, "block", "an allowance worth $500 is over max_tx_usd");
  assert.equal(decide(ap(0)).action, "allow", "approve(spender, 0) revokes");
  assert.equal(decide(sendOp({ to: WETH, data: calldata.setApprovalForAll(ROUTER, true) })).action, "block");
  assert.equal(decide(sendOp({ to: WETH, data: calldata.setApprovalForAll(ROUTER, false) })).action, "allow");
  const loose = resolveOnchainPolicy({ ...policy, token_approval: "allow" });
  assert.equal(decideOnchain({ op: ap(10_000_000), policy: loose, usage: usage0, wallets, upstreamChainId: 8453 }).action, "allow", "known spender, priced, token_approval allow");
  assert.equal(decideOnchain({ op: ap(10_000_000, STRANGER), policy: loose, usage: usage0, wallets, upstreamChainId: 8453 }).action, "approve", "unknown spender");
  const p2 = sendOp({ to: "0x000000000022d473030f116ddee9f6b43ac78ba3", data: calldata.permit2Approve(USDC, ROUTER, (1n << 160n) - 1n, 0) });
  assert.equal(decide(p2).action, "block", "Permit2 max uint160");
});

test("permit signatures are treated like approvals", () => {
  const sig = (td) => ({ method: "eth_signTypedData_v4", send: false, from: WALLET, ...decodeTypedData(td) });
  assert.equal(decide(sig(permit2Single({ amount: (1n << 160n) - 1n, spender: ROUTER }))).action, "block");
  const ok = decide(sig(erc2612({ value: 5_000_000, spender: ROUTER, owner: WALLET })));
  assert.deepEqual([ok.action, ok.usd], ["approve", 5]);
  assert.equal(decide(sig(erc2612({ value: MAX, spender: ROUTER, owner: WALLET }))).action, "block");
  assert.equal(decide(sig(permit2Single({ amount: 1, spender: ROUTER, chainId: 1 }))).action, "block", "permit for a chain not on chains_allow");
  assert.equal(decide(sig({ primaryType: "Mail", domain: { chainId: 8453 }, message: {} })).action, "approve");
  assert.match(describe({ ...sig(erc2612({ value: 5_000_000, spender: ROUTER, owner: WALLET })), upstreamChainId: 8453 }, policy), /Base \(8453\): ERC-2612 permit lets 0x4444.* spend 5 USDC, deadline 2030/);
});

test("recipient and contract allowlists", () => {
  assert.equal(decide(sendOp({ to: STRANGER, value: eth(0.001), data: "0x" })).action, "approve", "new recipient");
  assert.equal(decide(sendOp({ to: WALLET, value: eth(0.001), data: "0x" })).action, "allow", "own wallet counts as known");
  const strict = resolveOnchainPolicy({ ...policy, new_recipient: "block", unknown_contract: "block" });
  assert.equal(decideOnchain({ op: sendOp({ to: USDC, data: calldata.transfer(STRANGER, 1e6) }), policy: strict, usage: usage0, wallets, upstreamChainId: 8453 }).action, "block");
  assert.equal(decide(sendOp({ to: ROUTER, data: "0x3593564c" })).action, "allow", "known contract, no value");
  assert.equal(decide(sendOp({ to: STRANGER, data: "0x3593564c" })).action, "approve", "unknown contract");
  assert.equal(decideOnchain({ op: sendOp({ to: STRANGER, data: "0x3593564c" }), policy: strict, usage: usage0, wallets, upstreamChainId: 8453 }).action, "block");
  assert.equal(decide(sendOp({ to: null, data: "0x6000" })).action, "approve", "deploys ask");
});

test("chains, wallets, kill switch, signing classes and unsupported methods", () => {
  const raw = (o) => { const t = decodeRawTx(rawTx({ to: FRIEND, value: eth(0.001), ...o })); return sendOp(t, { method: "eth_sendRawTransaction", raw: true, chainId: t.chainId }); };
  assert.equal(decide(raw({ chainId: 8453 })).action, "allow");
  assert.match(decide(raw({ chainId: 1 })).reason, /chain 1, but the upstream RPC is chain 8453/);
  assert.match(decide(raw({ type: 0, chainId: null })).reason, /pre-EIP-155/);
  assert.match(decide(raw({ chainId: 1 }), { upstreamChainId: 1 }).reason, /not on chains_allow/);
  assert.match(decide(sendOp({ to: FRIEND, value: 1n, data: "0x" }, { from: STRANGER })).reason, /not one of the configured wallets/);
  assert.match(decide(sendOp({ to: FRIEND, value: 1n, data: "0x" }), { killed: true }).reason, /Kill switch/);
  assert.equal(decide({ method: "personal_sign", kind: "personal_sign", from: WALLET }, { killed: true }).action, "block");
  assert.equal(decide({ method: "personal_sign", kind: "personal_sign", from: WALLET }).action, "approve");
  assert.equal(decide({ method: "eth_sign", kind: "eth_sign", from: WALLET }).action, "block");
  assert.equal(decide({ method: "eth_signTransaction", kind: "unsupported" }).action, "block");
  assert.equal(decide({ method: "x", send: true, kind: "undecodable", error: "Couldn't decode" }).action, "block");
});

test("onchain policy validation and formatting", () => {
  assert.throws(() => resolveOnchainPolicy({ new_recipient: "maybe" }), /allow, approve or block/);
  assert.throws(() => resolveOnchainPolicy({ recipients_allow: ["vitalik.eth"] }), /not a 0x address/);
  assert.throws(() => resolveOnchainPolicy({ tokens: { [USDC]: { decimals: 6, usd_price: "cheap" } } }), /usd_price/);
  assert.throws(() => resolveOnchainPolicy({ max_tx_usd: "100" }), /non-negative number/);
  assert.throws(() => resolveOnchainPolicy({ max_tx_usdd: 5 }), /not a known setting/, "typos fail loudly instead of silently using defaults");
  assert.deepEqual(resolveOnchainPolicy({ chains_allow: ["0x2105", 1] }).chains_allow, [8453, 1]);
  assert.equal(formatUnits(25_000_000n, 6), "25");
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(5n * 10n ** 15n, 18), "0.005");
});
