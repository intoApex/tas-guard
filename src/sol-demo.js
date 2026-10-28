// `tas-guard sol-demo`: a scripted walkthrough of the Solana guard. An "agent" sends real, signed
// Solana transactions through the guard to a built-in mock chain, and you see what the guard does
// with each one. No keys of yours, no network, no money.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SolRpcGuard } from "./sol-rpc.js";
import { resolveSolanaPolicy } from "./solana-policy.js";
import { State } from "./state.js";
import { MockSolana, DEX, SHADY } from "./demo-sol.js";
import { keypair, addr, buildTransaction, ix, U64_MAX } from "./solana.js";

export const SOL_DEMO_POLICY = {
  clusters_allow: ["devnet"], sol_usd: 150,
  max_tx_usd: 100, max_daily_usd: 300, approve_over_usd: 50, max_tx_per_minute: 20,
  programs_allow: ["pumpfun", "jupiter"], program_caps: { pumpfun: { max_tx_usd: 30, max_daily_usd: 100 } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSolDemo({ out = (s) => process.stdout.write(s + "\n"), pause = 600 } = {}) {
  const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const MEME = addr("demo-memecoin");
  const agent = keypair("tas-guard-demo-agent");
  const W = agent.publicKey;
  const a = { usdc: addr("demo-w-usdc"), meme: addr("demo-w-meme"), pool: addr("demo-pool"), poolMeme: addr("demo-pool-meme"), drainer: addr("demo-drainer"), newAddr: addr("demo-new-address") };
  const chain = new MockSolana({ cluster: "devnet" });
  await chain.listen();
  chain.fund(W, 3_000_000_000n);
  chain.createMint(USDC, 6); chain.createMint(MEME, 6);
  chain.tokenAccount(a.usdc, { mint: USDC, owner: W, amount: 500_000000n });
  chain.fund(a.pool, 1_000_000_000n);
  chain.tokenAccount(a.poolMeme, { mint: MEME, owner: a.pool, amount: 10n ** 13n });

  const state = new State(mkdtempSync(join(tmpdir(), "tas-guard-sol-demo-")), "sol-demo");
  const guard = new SolRpcGuard({ upstream: chain.url, wallets: [W], policy: resolveSolanaPolicy(SOL_DEMO_POLICY), state, log: () => {} });
  const url = await guard.listen("127.0.0.1", 0, { wsPort: false });
  const buy = (lamports, tokens) => {
    const d = Buffer.alloc(17); d.writeBigUInt64LE(lamports, 1); d.writeBigUInt64LE(tokens, 9);
    return { programId: DEX, keys: [{ pubkey: W, isSigner: true, isWritable: true }, { pubkey: a.meme, isWritable: true }, { pubkey: a.pool, isWritable: true }, { pubkey: a.poolMeme, isWritable: true }], data: d };
  };
  const send = async (ixs) => {
    const raw = buildTransaction({ payer: W, signers: [agent], instructions: ixs, blockhash: chain.blockhash });
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [raw.toString("base64"), { encoding: "base64" }] }) });
    return r.json();
  };
  const clean = (m) => m.replace(/^TAS Guard blocked this: /, "").replace(/ Do not retry.*$/, "");

  out(`TAS Guard: Solana demo (mock devnet, no real money)
Rules: SOL = $150 · max $100 per transaction · max $300 per day · approval over $50
       pump.fun allowed, capped at $30 per transaction · unknown programs and new recipients need approval
Agent wallet: ${W}
`);
  const steps = [
    ["Buy a memecoin on pump.fun for 0.1 SOL ($15)", () => [ix.createAta(W, a.meme, W, MEME), buy(100_000_000n, 2_000_000_000n)]],
    ["Buy more for 0.5 SOL ($75)", () => [buy(500_000_000n, 9_000_000_000n)]],
    ["Send 0.2 SOL ($30) to an address it hasn't used before", () => [ix.transfer(W, a.newAddr, 200_000_000n)], { approve: true }],
    ['"Claim an airdrop" (looks harmless; quietly gives a drainer your USDC)', () => [{ programId: SHADY, keys: [{ pubkey: a.usdc, isWritable: true }, { pubkey: a.drainer }], data: Buffer.from([1]) }]],
    ["Approve unlimited USDC spending for a contract", () => [ix.approve(a.usdc, a.drainer, W, U64_MAX)]],
    ["Send 150 USDC ($150)", () => [ix.tokenTransfer(a.usdc, addr("demo-friend-usdc"), W, 150_000000n)]],
    ["Pay a 0.14 SOL priority fee", () => [ix.cuLimit(1_400_000), ix.cuPrice(100_000_000n), ix.memo("gm")]],
  ];
  chain.tokenAccount(addr("demo-friend-usdc"), { mint: USDC, owner: addr("demo-friend") });
  let n = 0;
  for (const [label, build, opt = {}] of steps) {
    n++;
    out(`${n}. Agent: ${label}`);
    const p = send(build());
    if (opt.approve) {
      for (let i = 0; i < 100; i++) { const it = state.pending().items.find((x) => x.status === "pending"); if (it) { out(`   ⏸  Held for you: ${it.reason}`); await sleep(pause * 2); out("   👆 You tap Approve on your phone"); state.decideApproval(it.id, true, "telegram"); break; } await sleep(20); }
    }
    const r = await p;
    out(r.result ? `   ✅ Sent` : `   🚫 Blocked: ${clean(r.error.message)}`);
    out("");
    await sleep(pause);
  }
  const u = state.usage();
  out(`Today: ${u.orders} sent, $${u.spent.toFixed(2)} of $300 used. Audit log: ${state.verifyAudit().lines} entries, hash chain ${state.verifyAudit().ok ? "intact" : "BROKEN"}.`);
  out(`USDC still in the wallet: ${Number(chain.tokenBalance(a.usdc)) / 1e6}. The drainer got nothing.`);
  await guard.close(); await chain.close();
}
