# TAS Guard

**A trading-aware safety proxy for AI agents.** Put it between your AI client (Claude, ChatGPT, Cursor, your own agent) and any broker or exchange MCP server. It enforces per-order and daily limits, symbol allowlists, human approvals, a kill switch and a tamper-evident audit log, before an order ever reaches your broker.

![An agent's over-limit order is blocked, a market order is held, approved on the phone, then sent to the broker](docs/demo.gif)

```
AI client  ──►  TAS Guard  ──►  Alpaca / CCXT / any trading MCP server  ──►  your account
                   │
                   ├─ blocks: over-limit orders, off-list symbols, withdrawals, leverage changes
                   ├─ asks you: large orders, live money, "close everything"
                   └─ logs: every decision, hash-chained
```

Zero dependencies. About 4,600 lines of plain JavaScript you can read in a few sittings.

**New in 0.5: [Hyperliquid mode](#hyperliquid-mode).** `tas-guard hl` trades Hyperliquid directly, with no other MCP server: your agent gets `hl_` tools, and every order goes through the same caps, allow list, approvals, kill switch and audit log. It signs with a Hyperliquid API wallet, which can trade but can't withdraw. It adds a 0.02% builder fee that funds TradingAgentStack ([details and opt-out](#builder-fee)).

**Also new in 0.4: [Solana mode](#solana-mode).** `tas-guard sol-rpc` simulates every transaction your Solana agent sends and blocks drainer patterns (hidden delegations, account takeovers), runaway priority fees and anything over your caps, including per-program caps such as "pump.fun: $20 per trade, $100 a day". Try it: `npx tas-guard sol-demo`.

**Also: [onchain (EVM) mode](#onchain-evm-mode)** for agents that hold their own EVM wallet: `tas-guard rpc` is a local JSON-RPC endpoint your agent uses as its RPC URL.

## Try it in 10 seconds (no broker account)

`tas-guard demo` runs the guard in front of a built-in paper broker with simulated prices. Add it to your AI app as an MCP server:

```json
{ "mcpServers": { "tas-guard-demo": { "command": "npx", "args": ["-y", "tas-guard", "demo"] } } }
```

(On Windows use `"command": "cmd", "args": ["/c", "npx", "-y", "tas-guard", "demo"]`.) Then ask your agent to buy 1 SPY at $580 (allowed), 2 SPY at $580 (held for your approval), 10 SPY (blocked: over the $2,000 per-order limit) or 1 TSLA (blocked: not on the allow list). Approve held orders with `npx tas-guard approve <id>`.

## Why not a generic MCP gateway?

Generic gateways decide per *tool*: "createOrder is critical, require approval." They can't tell a $50 order from a $50,000 one, so you end up approving everything or nothing.

TAS Guard reads the order itself. It knows that Alpaca's `place_option_order` has a 100x contract multiplier, that ccxt's `cost` is a quote-currency value while `amount` is base units, and that ccxt answers the first live order with a preview. That's what makes "allow small orders, ask for big ones, never exceed $2,000 a day" possible.

| Broker connector | What it does on its own | With TAS Guard |
|---|---|---|
| Alpaca MCP (TAS safety score 68) | AI can place orders directly; toolsets can limit it | Per-order and daily caps, symbol allowlist, approval above a threshold |
| CCXT MCP | Has its own caps and confirm step | One policy and one audit log across every exchange you use |
| Any other trading MCP | Varies | Heuristic profile; anything unrecognized is blocked |

Safety scores and order-gating facts: [tradingagentstack.com](https://tradingagentstack.com/broker-mcp-safety-controls/).

## Quick start (Alpaca, paper trading)

1. Write `~/tas-guard/alpaca.json` (or run `npx tas-guard init alpaca-mcp-server`):

```json
{
  "name": "alpaca",
  "profile": "alpaca-mcp-server",
  "upstream": {
    "command": "uvx",
    "args": ["alpaca-mcp-server"],
    "env": {
      "ALPACA_API_KEY": "${ALPACA_API_KEY}",
      "ALPACA_SECRET_KEY": "${ALPACA_SECRET_KEY}",
      "ALPACA_PAPER_TRADE": "true"
    }
  },
  "policy": {
    "max_order_value": 500,
    "max_daily_value": 2000,
    "approve_over": 250,
    "symbols_allow": ["SPY", "QQQ", "AAPL", "MSFT"]
  }
}
```

`${VAR}` is read from the environment, so keys don't have to live in the file.

2. Point your MCP client at the guard instead of at Alpaca. For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "npx",
      "args": ["-y", "tas-guard", "run", "--config", "/Users/you/tas-guard/alpaca.json"],
      "env": { "ALPACA_API_KEY": "...", "ALPACA_SECRET_KEY": "..." }
    }
  }
}
```

For Claude Code: `claude mcp add alpaca -- npx -y tas-guard run --config ~/tas-guard/alpaca.json`

3. Ask the agent to call `tas_guard_status` to see the limits it's working under.

No config file? `npx tas-guard run --profile alpaca-mcp-server -- uvx alpaca-mcp-server` uses the default policy.

## What it decides

Every tool is put in a class, from a verified **connector profile** or, for servers without one, from name heuristics and MCP annotations.

| Class | Examples | Default |
|---|---|---|
| `read` | quotes, positions, balances | allow |
| `benign_write` | watchlists | allow |
| `cancel`, `close` | cancel one order, close one position | allow (also during kill switch) |
| `order` | place an order | **check limits** |
| `modify`, `cancel_all`, `close_all`, `other_write` | replace order, cancel everything (stop-losses too), exercise options | ask a human |
| `leverage`, `funds_out`, `account`, `raw_write`, `unknown` | set leverage, withdraw, transfer, account settings, "call any endpoint", anything unrecognized | **block** (and hide from the agent) |

For `order` calls, in this order:

1. Kill switch on → block.
2. Symbol on `symbols_block`, or not on `symbols_allow` (if set) → block. Globs work: `"BTC/*"`.
3. Side not in `sides_allow` (if set) → block.
4. More than `max_orders_per_minute` or `max_orders_per_day` → block.
5. Value over `max_order_value`, or today's total would pass `max_daily_value` → block. These are hard limits; approval can't override them.
6. Value over `approve_over`, value unknown (market order by quantity, multi-leg), or live money with `live_requires_approval` → ask a human.
7. Otherwise → allow.

Only orders the broker actually accepted count toward daily totals. Rejected orders and ccxt previews don't. Orders execute one at a time and limits are re-checked just before sending, so parallel calls can't slip past the daily cap.

## Policy reference

```json
{
  "max_order_value": 500,          // hard, per order, in the profile's quote currency
  "max_daily_value": 2000,         // hard, sum of executed orders today (local time)
  "max_orders_per_day": 20,
  "max_orders_per_minute": 3,
  "approve_over": 250,             // soft: above this, a human approves
  "symbols_allow": [],             // empty = any symbol
  "symbols_block": [],
  "sides_allow": [],               // e.g. ["buy"] for no selling
  "unknown_value": "approve",      // allow | approve | block when the value can't be computed
  "live_requires_approval": true,  // every live-money order needs a human
  "classes": { "close_all": "allow", "unknown": "approve" },  // override any class
  "hide_blocked_tools": true,
  "approval_ttl_minutes": 15
}
```

## Approvals

When an action needs approval, the guard asks **you**, never the agent.

- **In the client:** if your MCP client supports elicitation, a prompt appears in the app ("Approve this action?"). Only a human can answer it.
- **From a terminal:** otherwise the call is held with an id. Run `npx tas-guard approve <id>` (or `deny <id>`), and the agent repeats the call. Each approval works once, for that exact call, within 15 minutes.

Tested with Claude Desktop (Windows, October 2026) against an Alpaca paper account: Claude Desktop doesn't show the in-app prompt, so approvals there go through `npx tas-guard approve <id>`. Claude relays the request id and waits for you.

```
npx tas-guard pending
npx tas-guard approve 3f9a1c
```

## Phone approvals and kill switch (Telegram)

Get held actions on your phone with **Approve** and **Deny** buttons, alerts when an order is blocked, and a kill switch you can hit from anywhere. It uses your own Telegram bot, so nothing goes through our servers.

```
npx tas-guard telegram-setup --config ~/tas-guard/alpaca.json
```

It walks you through creating a bot with @BotFather, waits for you to press Start in your bot, then saves the bot token and your chat id into the guard config. Restart your AI app afterwards.

What you get:

- **Approve / Deny buttons.** The agent's call waits up to 45 seconds (`wait_seconds`) for your tap and then goes through in the same call. If you're slower, the agent is told to retry after you approve.
- **Alerts** when an order-type call is blocked (`notify_blocked`, on by default) and, optionally, when an order is sent to the broker (`notify_executed`).
- **Phone commands:** `/status` (limits and today's usage), `/pending` (re-sends anything waiting), `/kill`, `/resume`.
- **Only you:** taps and commands from any other Telegram account are ignored.
- **Phone-only approvals:** set `"cli": false` so `tas-guard approve` refuses requests from this guard. That closes the gap where an agent with shell access could run the approve command itself.

```json
"approvals": {
  "cli": false,
  "telegram": {
    "bot_token": "${TAS_TELEGRAM_BOT_TOKEN}",
    "chat_id": "123456789",
    "wait_seconds": 45,
    "notify_blocked": true,
    "notify_executed": false
  }
}
```

Several guards can share one bot. Whichever one is listening handles the tap, and the others pick up the decision from the shared state.

## Kill switch

```
npx tas-guard kill "market looks wrong"   # every guard blocks new orders immediately
npx tas-guard resume
```

Reads, cancels and closing positions keep working while it's on, so you (or the agent) can still flatten.

## Audit log

Every decision is appended to `~/.tas-guard/audit.jsonl`: tool, class, arguments (secrets redacted), decision, reason, order value, and whether it executed. Each line includes the hash of the previous line.

```
npx tas-guard log --tail 20
npx tas-guard verify-log      # detects edited or deleted lines
```

## Connector profiles

A profile says what each tool of a server can do with money and where its order fields live. The schema is [`schema/connector-profile.v1.json`](schema/connector-profile.v1.json). Built-in profiles are verified against each server's source code or official docs, with the commit or page recorded:

- `alpaca-mcp-server`: alpacahq/alpaca-mcp-server @ 2a973a0
- `ccxt-mcp-server`: ccxt/ccxt `mcp/` @ 310bf4b
- `robinhood-trading-mcp`: Robinhood's hosted Trading MCP, from the 94-tool table in Robinhood's ["Trading with your agent"](https://robinhood.com/us/en/support/articles/trading-with-your-agent/) article (2026-10-21). The server is closed source and Robinhood publishes no argument names, so order values can't be read: every order needs approval, and a `symbols_allow` list blocks orders.

Using a server without a profile? `"profile": "auto"` classifies tools by name and MCP annotations, and blocks anything it doesn't recognize. Profiles for more brokers are welcome as PRs.

## Onchain (EVM) mode

For agents that sign and send their own transactions (AgentKit, viem, ethers, web3.py, your own bot), `tas-guard rpc` runs a local JSON-RPC endpoint. Point the agent's RPC URL at it instead of at your provider:

```
AI agent ──► http://127.0.0.1:8547 (TAS Guard) ──► your RPC provider (Alchemy, Infura, a node...)
                   │
                   ├─ reads (balances, calls, logs, gas...): passed through untouched
                   ├─ sends and signatures: decoded, checked, then forwarded, held for you, or refused
                   └─ logs: every decision, in the same hash-chained audit log
```

Try it with no chain, no keys and no money: `npx tas-guard rpc-demo` starts the guard in front of a built-in mock Base node and prints `curl` commands that get allowed, held, and blocked.

### What it checks

Only the methods that can move money are touched; everything else goes straight to your provider.

| Method | What the guard reads |
|---|---|
| `eth_sendRawTransaction` | Decodes the signed transaction (legacy, EIP-2930, EIP-1559): chain id, `to`, value, calldata. Its nonce must match one of your `wallets`. |
| `eth_sendTransaction` | The transaction object; `from` must be one of your `wallets`. |
| `eth_signTypedData_v4` (and v1/v3) | ERC-2612 and DAI permits and Uniswap Permit2 (`PermitSingle`, `PermitBatch`, `PermitTransferFrom`) are treated as token approvals: spender, token, amount, deadline. Other typed data asks you. |
| `personal_sign` / `eth_sign` | `personal_sign` asks you; `eth_sign` (signs a raw hash, which can be a transaction) is blocked. |
| Any other `eth_send*`, `eth_sign*`, `personal_*`, `wallet_*` | Blocked: the guard can't decode them (`eth_signTransaction`, `eth_sendUserOperation`, `wallet_sendCalls`, `personal_sendTransaction`...). |

Calldata is read by 4-byte selector: native transfers, ERC-20 `transfer`, `transferFrom`, `approve`, `increaseAllowance`, ERC-721/1155 `setApprovalForAll` and Permit2 `approve`. Anything else is a generic contract call.

For each send or signature, in this order:

1. Kill switch on → block (reads still work).
2. Sender not one of your `wallets` → block.
3. Chain not on `chains_allow`, signed for a different chain than the upstream, or no replay protection (pre-EIP-155) → block.
4. More than `max_tx_per_minute` or `max_tx_per_day` → block.
5. Unlimited allowance (≥ 2^255, max uint, Permit2 max uint160) → block. `setApprovalForAll(…, true)` → block. Revokes (`approve(x, 0)`, `setApprovalForAll(x, false)`) are allowed.
6. USD value over `max_tx_usd`, or today's total would pass `max_daily_usd` → block. An allowance worth more than `max_tx_usd` is blocked too. These are hard limits; approval can't override them.
7. Pre-flight revert check: `eth_call` and `eth_estimateGas` from your wallet at `latest`. If either fails → block, with the revert reason (`Vault: deposits are paused`, `ERC20: transfer amount exceeds balance`...).
8. Ask a human if: value over `approve_over_usd`, value can't be priced (`unknown_value`), recipient not on `recipients_allow` (`new_recipient`), contract or spender not on `contracts_allow` (`unknown_contract`), or it's an approval or permit (`token_approval`).
9. Otherwise → forward.

USD values come from your config, not a price feed: `native_usd` per chain and a `tokens` list (`"usd_price": "stable"` for stablecoins). Only sends that the upstream accepted count toward daily totals. Sends run one at a time and limits are re-checked just before forwarding.

### Config (Base, USDC)

```json
{
  "name": "base-agent",
  "upstream_rpc": "https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
  "listen": "127.0.0.1:8547",
  "wallets": ["0xYourAgentWalletAddress"],
  "onchain": {
    "chains_allow": [8453],
    "native_usd": { "8453": 3000 },
    "tokens": {
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { "symbol": "USDC", "decimals": 6, "usd_price": "stable" }
    },
    "max_tx_usd": 100,
    "max_daily_usd": 500,
    "approve_over_usd": 25,
    "max_tx_per_minute": 3,
    "max_tx_per_day": 20,
    "recipients_allow": [],
    "contracts_allow": [],
    "unlimited_approval": "block"
  },
  "approvals": {
    "telegram": { "bot_token": "${TAS_TELEGRAM_BOT_TOKEN}", "chat_id": "123456789" }
  }
}
```

```
ALCHEMY_API_KEY=... npx tas-guard rpc --config ~/tas-guard/base.json
```

`${VAR}` is read from the environment. The upstream URL (and any key in it) is never logged, audited or returned to the agent; only its host is shown. The full schema, with every setting and its default, is [`schema/onchain-guard.v1.json`](schema/onchain-guard.v1.json). Unknown settings are rejected, so a typo can't silently fall back to a default.

| Setting | Default | |
|---|---|---|
| `chains_allow` | `[]` (any) | Chain ids; others are blocked |
| `max_tx_usd`, `max_daily_usd` | 100, 500 | Hard limits |
| `max_tx_per_minute`, `max_tx_per_day` | 3, 20 | Hard limits |
| `approve_over_usd` | 50 | Ask above this |
| `unknown_value` | `approve` | Value can't be priced |
| `recipients_allow` / `new_recipient` | `[]` / `approve` | Your own wallets always count as known |
| `contracts_allow` / `unknown_contract` | `[]` / `approve` | Contract calls and approval spenders |
| `token_approval` | `approve` | Any approve, permit or Permit2 |
| `unlimited_approval`, `approval_for_all` | `block`, `block` | |
| `typed_data`, `personal_sign`, `eth_sign` | `approve`, `approve`, `block` | |
| `unsupported_methods` | `block` | |
| `preflight` | `true` | |
| `approval_ttl_minutes` | 15 | |

### Point your agent at it

- **viem / AgentKit (`ViemWalletProvider`):** `http("http://127.0.0.1:8547", { timeout: 900_000 })`. viem's default 10-second timeout is shorter than a human approval.
- **ethers v6:** `new JsonRpcProvider("http://127.0.0.1:8547")`. Its requests time out after 5 minutes; if you approve later, the agent resending the same signed transaction picks up the approval.
- **web3.py:** `Web3(Web3.HTTPProvider("http://127.0.0.1:8547", request_kwargs={"timeout": 900}))`.

The agent can call `tas_guardStatus` on the RPC to see its limits and today's usage.

### Approvals, kill switch and audit log

They work exactly as in MCP mode and share the same state. A held request stays open until you approve it with `npx tas-guard approve <id>` or on your phone (the Telegram message shows the chain, contract, token, amount, USD value and reason), then it's forwarded and the agent gets the transaction hash. Denied or unanswered within `approval_ttl_minutes` → the agent gets a JSON-RPC error. If the agent's client gives up first, sending the same signed transaction again after you approve goes through once.

`npx tas-guard kill` (or `/kill` on your phone) blocks every send and signature on every guard; reads keep working. `npx tas-guard log` and `verify-log` cover onchain decisions too.

### Limitations (onchain)

- **Wallets must be configured.** The guard has no secp256k1 public-key recovery, so it can't prove who signed a raw transaction. It matches the transaction's nonce against your `wallets` and blocks anything that doesn't fit. A transaction signed by another key whose nonce happens to match would be treated as yours, though every policy check on its contents still applies.
- **The pre-flight is a revert check, not a full simulation.** `eth_call` + `eth_estimateGas` at `latest` catch reverts and missing funds. They don't show balance changes, and the chain can change between the check and inclusion.
- **Generic contract calls are priced by their native value only.** Tokens moved inside a call (a swap through a router you already approved, say) don't count toward USD limits. That's why unknown contracts and every approval ask you by default; keep `contracts_allow` short.
- **Prices are static.** `native_usd` and `usd_price` come from your config; tokens not listed are unpriced (`unknown_value`).
- **It only protects agents that use this RPC URL.** Wallets that broadcast through their own API (Coinbase CDP server wallets, ERC-4337 bundlers, a second RPC) bypass it. User operations, EIP-7702 and blob transactions are blocked, not decoded.
- **EVM only here.** For Solana, see [Solana mode](#solana-mode).
- **Same caveat as MCP mode:** an agent with shell access could run `tas-guard approve` itself unless you use phone approvals with `"cli": false`.

## Solana mode

For Solana agents that sign their own transactions (Solana Agent Kit, `@solana/web3.js` or `@solana/kit` bots, Jupiter and pump.fun scripts), `tas-guard sol-rpc` runs a local Solana JSON-RPC endpoint. Point the agent's RPC URL at it instead of your provider:

```
AI agent ──► http://127.0.0.1:8890 (TAS Guard) ──► your Solana RPC (Helius, Triton, QuickNode...)
                   │
                   ├─ reads and WebSocket subscriptions: passed through untouched
                   ├─ sendTransaction: decoded, simulated, checked, then forwarded, held for you, or refused
                   └─ logs: every decision, in the same hash-chained audit log
```

Watch it work with no keys, no network and no money:

```
npx tas-guard sol-demo
```

An agent sends seven signed transactions through the guard to a built-in mock chain: a pump.fun buy under its cap goes through; a bigger one is blocked by the per-program cap; a send to a new address is held and approved; a fake "airdrop claim" that quietly makes a drainer a delegate of your USDC is blocked; so are an unlimited approval, a send over the per-transaction limit and a 0.14 SOL priority fee.

**What it can't protect:** custodial Telegram trading bots (Trojan, BullX, Axiom and the like) keep your keys on their servers and never send through your RPC, so no local guard can see their trades. For those, check the bot's links before you use it: [tradingagentstack.com/check](https://tradingagentstack.com/check/).

### What it checks

Only `sendTransaction` is checked; other `send*` methods (`sendBundle`...) are blocked because they can't be checked. Every transaction format is decoded: legacy, v0 with address lookup tables (the tables are read from the chain), and **v1** (SIMD-0385, live on mainnet since September 2026). The decoder was cross-checked against `@solana/web3.js` in both directions and against 314 real devnet transactions of all three versions, matching the node's own view of every one.

Then the guard **simulates the transaction** (`simulateTransaction` with the writable accounts' before and after state). That's how it measures what actually leaves your wallets, including SOL and tokens moved inside other programs, not just what the top-level instructions say.

For each transaction, in this order:

1. Kill switch on → block (reads still work).
2. Not signed by one of your `wallets` → block.
3. Cluster not on `clusters_allow` (read from the RPC's genesis hash) → block.
4. Any account on `addresses_block` anywhere in the transaction → block.
5. More than `max_tx_per_minute` or `max_tx_per_day` → block.
6. Network + priority fee over `max_fee_sol` → block (catches runaway priority fees; v1's absolute priority fee is read too).
7. Your wallet assigned to another program (`System Assign`), or one of your token accounts handed to a new owner (`SetAuthority`), whether by an instruction or inside another program as the simulation shows → block (`owner_change`).
8. Unlimited token delegation (`Approve` for the u64 maximum), by instruction or as the simulation shows → block. Any other delegation asks you (`token_delegation`), and one worth more than `max_tx_usd` is blocked.
9. The simulation fails → block, with the program's error.
10. USD value leaving your wallets over `max_tx_usd`, today's total over `max_daily_usd`, or over a `program_caps` limit for a program the transaction calls → block. These are hard limits; approval can't override them.
11. Ask a human if: value over `approve_over_usd`; something that leaves can't be priced (`unknown_value`); a direct SOL or token transfer goes to an address not on `recipients_allow` (`new_recipient`; Jito tip accounts count as known); or it calls a program not on `programs_allow` (`unknown_program`).
12. Otherwise → forward.

The value counts SOL (including wrapped SOL and the rent in your token accounts, so creating and closing accounts nets out), the network fee, and every token whose balance falls in an account you own. Tokens are priced from your config: `sol_usd`, plus a `tokens` list (`"usd_price": "stable"` or a number). USDC and USDT are built in at $1. A memecoin you're selling has no price unless you list it, so with the default `unknown_value: "approve"` sells of unlisted tokens ask you. Buys are valued by the SOL that leaves.

Program presets for `programs_allow` and `program_caps`: `jupiter`, `pumpfun`, `pumpswap`, `raydium` (AMM v4, CPMM, CLMM), `orca` (Whirlpool), `meteora` (DLMM, dynamic AMM). Program IDs are from each project's own docs, checked October 2026. Core programs (System, Token, Token-2022, Associated Token, Compute Budget, Memo) are always allowed, because the guard decodes them itself.

### Config (mainnet, Jupiter and pump.fun)

`npx tas-guard init solana` prints this starter config:

```json
{
  "name": "solana",
  "upstream_rpc": "https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}",
  "listen": "127.0.0.1:8890",
  "wallets": ["YourAgentWalletAddress"],
  "solana": {
    "clusters_allow": ["mainnet"],
    "sol_usd": 150,
    "max_tx_usd": 50,
    "max_daily_usd": 200,
    "approve_over_usd": 25,
    "max_fee_sol": 0.005,
    "programs_allow": ["jupiter", "pumpfun", "pumpswap"],
    "program_caps": { "pumpfun": { "max_tx_usd": 20, "max_daily_usd": 100 } },
    "recipients_allow": []
  },
  "approvals": {
    "telegram": { "bot_token": "${TAS_TELEGRAM_BOT_TOKEN}", "chat_id": "123456789" }
  }
}
```

```
HELIUS_API_KEY=... npx tas-guard sol-rpc --config ~/tas-guard/solana.json
```

The full schema is [`schema/solana-guard.v1.json`](schema/solana-guard.v1.json); unknown settings are rejected.

| Setting | Default | |
|---|---|---|
| `clusters_allow` | `[]` (any) | `mainnet`, `devnet`, `testnet`, `localnet` |
| `sol_usd` | none | USD price of SOL; without it SOL is unpriced |
| `tokens` | `{}` | `{ "<mint>": { "symbol": "BONK", "usd_price": 0.00002 } }` |
| `max_tx_usd`, `max_daily_usd` | 100, 500 | Hard limits |
| `max_tx_per_minute`, `max_tx_per_day` | 3, 20 | Hard limits |
| `max_fee_sol` | 0.01 | Hard limit on network + priority fee |
| `program_caps` | `{}` | Per program (or preset): `max_tx_usd`, `max_daily_usd` |
| `addresses_block` | `[]` | Hard block if any of these appear |
| `approve_over_usd` | 50 | Ask above this |
| `unknown_value` | `approve` | Something leaving can't be priced |
| `programs_allow` / `unknown_program` | `[]` / `approve` | Program ids or presets |
| `recipients_allow` / `new_recipient` | `[]` / `approve` | Your wallets always count as known |
| `jito_tips` | `true` | Jito tip accounts count as known recipients |
| `token_delegation`, `unlimited_delegation` | `approve`, `block` | |
| `owner_change`, `close_authority_change` | `block`, `approve` | |
| `unsupported_methods` | `block` | |
| `simulate` | `true` | Off: only decoded SOL and token transfers are valued, and other programs make the value unknown |
| `approval_ttl_minutes` | 15 | |

### Point your agent at it

- **`@solana/web3.js`:** `new Connection("http://127.0.0.1:8890", "confirmed")`. web3.js looks for the WebSocket on port + 1 when the URL has a port, so the guard also listens on 8891; subscriptions (used by `confirmTransaction`) pass through to your provider's WebSocket.
- **`@solana/kit`:** `createSolanaRpc("http://127.0.0.1:8890")` and `createSolanaRpcSubscriptions("ws://127.0.0.1:8890")`.
- **Solana Agent Kit:** pass the guard's URL as the RPC URL.
- If your provider's WebSocket URL isn't the RPC URL with `wss://`, set `upstream_ws`.

The agent can call `tas_guardStatus` on the RPC to see its limits, today's usage and its per-program totals.

### Approvals and expiring blockhashes

Solana transactions expire about a minute after they're built, which is often shorter than a human approval. If the blockhash expires while you're deciding, the agent gets: "approved, but the transaction's blockhash expired; rebuild the same transaction with a fresh blockhash and send it again". The re-signed copy goes through without asking again, because approvals match the transaction minus its signatures and blockhash. A rebuilt swap with a new quote is a different transaction and asks again.

Kill switch, phone approvals and the audit log work exactly as in the other modes and share the same state.

### Limitations (Solana)

- **The simulation is a snapshot.** It shows what the transaction would do against the chain's state a moment before it's sent. Swaps can still fill worse within your slippage setting, and state can change before inclusion.
- **Prices are static.** `sol_usd` and token prices come from your config.
- **It only protects agents that send through this RPC URL.** A second RPC, a Jito bundle endpoint, a wallet-as-a-service API or a custodial bot bypass it.
- **Durable-nonce transactions** are checked when they're sent through the guard, but a copy sent elsewhere later isn't.
- **Same caveat as the other modes:** an agent with shell access could run `tas-guard approve` itself unless you use phone approvals with `"cli": false`.

## Hyperliquid mode

`tas-guard hl` is an MCP server that trades Hyperliquid itself, through Hyperliquid's public API. There's no upstream MCP server to install: the guard prices, checks, signs and sends each order.

```
AI client ──► tas-guard hl ──► api.hyperliquid.xyz  (POST /info, POST /exchange)
                 │
                 ├─ values every order itself: size × limit price, or mid ± slippage for market orders
                 ├─ blocks, asks you, or signs locally with your API wallet (it can trade, it can't withdraw)
                 └─ logs: every decision, in the same hash-chained audit log
```

### Setup

1. **Create an API wallet.** On [app.hyperliquid.xyz/API](https://app.hyperliquid.xyz/API), generate an API wallet, authorize it for your account and copy its private key. An API wallet can place and cancel orders for your account, but it **can't withdraw or transfer funds**, so a leaked key can't drain the account. That's why TAS Guard asks for one and refuses your main wallet's key. Give TAS Guard its own API wallet rather than sharing one with another bot: Hyperliquid tracks nonces per signing wallet.
2. **Set two environment variables** where your MCP client starts the guard:
   - `HL_ACCOUNT`: your account's main address (the one you deposit to and see in the app).
   - `HL_API_PRIVATE_KEY`: the API wallet's private key.
3. **Approve the builder fee once** (or [turn it off](#builder-fee)). Hyperliquid requires the main wallet, not the API wallet, to approve a builder fee, so this one command reads your main wallet's key from `HL_MAIN_PRIVATE_KEY`. It prints what it's approving and asks you to confirm. The key is used for this one signature, never stored or logged. Run it yourself, never through the agent:

```
HL_MAIN_PRIVATE_KEY=0x... npx tas-guard hl approve-fee            # add --testnet for testnet
```

4. **Add it to your AI app.** Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hyperliquid": {
      "command": "npx",
      "args": ["-y", "tas-guard", "hl", "--config", "/Users/you/tas-guard/hyperliquid.json"],
      "env": {
        "HL_ACCOUNT": "0xYourMainAddress",
        "HL_API_PRIVATE_KEY": "0xYourApiWalletPrivateKey"
      }
    }
  }
}
```

(On Windows use `"command": "cmd", "args": ["/c", "npx", "-y", "tas-guard", "hl", "--config", "C:\\Users\\you\\tas-guard\\hyperliquid.json"]`.) Add `"--testnet"` to the args to trade [testnet](https://app.hyperliquid-testnet.xyz) with test funds; testnet needs its own API wallet. Claude Code: `claude mcp add hyperliquid -e HL_ACCOUNT=0x... -e HL_API_PRIVATE_KEY=0x... -- npx -y tas-guard hl --config ~/tas-guard/hyperliquid.json`.

Then ask the agent to call `tas_guard_status` (limits, today's usage, network, account, fee) or `hl_get_account`.

### Policy

The config file is optional. `npx tas-guard init hyperliquid` prints this one:

```json
{
  "name": "hyperliquid",
  "testnet": false,
  "policy": {
    "max_order_value": 200,
    "max_daily_value": 1000,
    "approve_over": 100,
    "max_orders_per_minute": 3,
    "max_orders_per_day": 20,
    "symbols_allow": ["BTC", "ETH", "SOL"],
    "live_requires_approval": false
  },
  "approvals": {}
}
```

Values are in USDC. The policy works exactly as in [the policy reference](#policy-reference). Without a config file you get the defaults: $500 per order, $2,000 a day, and on mainnet **every order needs your approval** (`live_requires_approval`). This example turns that off, so orders up to `approve_over` ($100) go through on their own and bigger ones ask you. Add `"approvals": { "telegram": ... }` (or run `npx tas-guard telegram-setup --config ~/tas-guard/hyperliquid.json`) to approve on your phone. Other settings: `account` (instead of `HL_ACCOUNT`) and `state_dir`. Keys are never read from this file; unknown settings are rejected.

| Tool | Class | Default |
|---|---|---|
| `hl_get_account`, `hl_get_mids`, `hl_get_open_orders` | `read` | allow |
| `hl_place_order` (limit or market, `reduce_only`, `tif`: Gtc, Ioc, Alo) | `order` | check limits |
| `hl_cancel_order` | `cancel` | allow (also during the kill switch) |
| `hl_close_position` (reduce-only market order) | `close` | allow (also during the kill switch) |
| `hl_update_leverage` | `leverage` | **block** (hidden from the agent). `"classes": { "leverage": "approve" }` makes it ask you |

### How orders are valued

The guard prices each order before the policy sees it, and the order it checked is the order it signs:

- **Buy limit:** size × limit price. Fills can only be cheaper.
- **Sell limit:** size × the higher of the limit price and the mid. A sell priced far below the market fills near the mid, so a "sell 1 BTC at $1" can't slip under your caps. If there's no mid to compare with, the value counts as unknown (`unknown_value`, which asks you by default).
- **Market:** an immediate-or-cancel order at the mid ± `max_slippage_pct` (default 1%, at most 10%), rounded the way Hyperliquid's Python SDK does it. Value: size × that worst price.
- **Tick rules:** prices are rounded to 5 significant figures and at most 6 − szDecimals decimals (8 − szDecimals for spot), buys down and sells up, so the order is never worse than asked. Sizes are rounded down to szDecimals. The result says when anything was adjusted.
- **Symbols:** allow and block lists see the market's canonical name: `BTC`, `ETH`, `HYPE/USDC`. Lowercase names and spot aliases like `@107` are resolved first, so they can't get around a list.
- **Daily totals** count an order's checked value once Hyperliquid accepts it (resting or filled). Rejected orders don't count.

### Builder fee

**Hyperliquid mode adds a 0.02% builder fee to each order, paid to TradingAgentStack to fund the project; it's shown in Hyperliquid's own fee breakdown. Set `TAS_GUARD_HL_BUILDER_FEE=0` to turn it off.**

- **How much:** 0.02% of the filled notional (20 cents on a $1,000 fill), on top of Hyperliquid's own trading fees. Hyperliquid charges builder fees on both sides of perp trades and on spot sells, not on spot buys.
- **How:** each order carries Hyperliquid's builder code (`"builder": {"b": <TradingAgentStack's address>, "f": 20}`, where `f` is in tenths of a basis point). Hyperliquid only accepts it after you approve the builder once (`tas-guard hl approve-fee`), and it never charges more than the rate you approved. The approval gives nobody access to your funds, and Hyperliquid lets you revoke it at any time.
- **Off:** with `TAS_GUARD_HL_BUILDER_FEE=0` (in the `env` block of your MCP config) orders are sent without a builder code: no fee and no approval needed. Everything else works the same. `tas_guard_status` shows whether the fee is on.
- **Where it lives:** the address and the rate are two constants in [`src/hl-fee.js`](src/hl-fee.js). The guard logs the fee setting at startup.

If Hyperliquid rejects an order because the fee isn't approved, the agent is told to have you run `tas-guard hl approve-fee` or set `TAS_GUARD_HL_BUILDER_FEE=0`.

### Signing

Orders are signed locally the way Hyperliquid's official Python SDK signs them: the action is msgpack-encoded with the SDK's key order, hashed with keccak-256 together with the nonce, and signed as EIP-712 typed data with secp256k1 (RFC 6979 deterministic nonces, low s). All of it is plain JavaScript with no dependencies ([`src/eth-crypto.js`](src/eth-crypto.js), [`src/hl-sign.js`](src/hl-sign.js)). The tests check every byte against vectors the SDK itself produced (hyperliquid-python-sdk 0.24.0): msgpack bytes, the action hash, the EIP-712 digest, `r`, `s`, `v` and the whole posted payload, for orders with and without a builder code, a market order, a spot order, a cancel, a leverage change and the fee approval, on mainnet and testnet. The generator is [`test/fixtures/gen-hl-vectors.py`](test/fixtures/gen-hl-vectors.py). Every signature is also checked to recover to the API wallet's address before anything is sent.

### Safety notes and limitations (Hyperliquid)

- **Keys:** `HL_API_PRIVATE_KEY` stays on your machine; only signatures are sent, and only to Hyperliquid's API. Keys are never logged, audited or returned to the agent. The guard logs the API wallet's address, not its key.
- **Wrong key, wrong account:** your main wallet's key is refused outright. At startup the guard also asks Hyperliquid whose wallet the key is; if it's a regular account or an API wallet of a different account, every order, cancel and leverage change is refused until you fix the settings. It also warns if the builder fee isn't approved yet.
- **The kill switch** (`npx tas-guard kill`, or `/kill` on your phone) blocks new orders and leverage changes immediately; cancels and closing positions keep working. Approvals, phone controls and the audit log work exactly as in the other modes.
- **Unknown outcomes:** if the connection drops while an order is being sent, the agent is told the order may or may not have been placed and to check open orders and the account before retrying. Such orders don't count toward daily totals.
- **Not supported yet:** trigger (TP/SL) orders, order modification, vaults and subaccounts, and builder-deployed perp markets (`dex:COIN`).
- **Only what goes through the guard is guarded.** The API wallet can still trade from anywhere its key is. Keep it only in the guard's config.
- **Signing uses BigInt math, which isn't constant-time.** That matters to an attacker who can time many signatures on your machine; if they can do that, they likely have other ways in.
- **Same caveat as the other modes:** an agent with shell access could run `tas-guard approve` (or `approve-fee`) itself unless you use phone approvals with `"cli": false` and keep the main wallet key out of its reach.

## Windows and Claude Desktop notes

Tested on Windows with the Microsoft Store version of Claude Desktop, October 2026.

- **Put API keys in your guard file** (`upstream.env` in `alpaca.json`), not in Claude Desktop's config. Claude Desktop keeps its own copy of each server's settings, so keys you change in its config file may not reach the server. Keys in the guard file always win. The guard's log shows which key the upstream received (last 4 characters only), e.g. `credential ALPACA_API_KEY: ...PBYR (from guard config)`.
- **Use `cmd /c` to start npx** in `claude_desktop_config.json`: `"command": "cmd", "args": ["/c", "npx", "-y", "tas-guard", "run", "--config", "C:\\Users\\you\\tas-guard\\alpaca.json"]`.
- **Edit Claude Desktop's config only while the app is fully quit** (system tray, Quit). It rewrites the file while running. The Store version keeps it under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`.
- **Faster startup:** run `uv tool install alpaca-mcp-server` once and set `"command": "alpaca-mcp-server", "args": []` in the guard file. `uvx` otherwise re-resolves the server on every launch, which adds 10 to 20 seconds.
- **Approvals:** Claude Desktop doesn't show the in-app approval prompt. Use phone approvals (`telegram-setup`), or approve held actions with `npx tas-guard approve <id>`.

## Limitations (read these)

- **An agent with shell access could run `tas-guard approve` itself**, unless you use phone approvals with `"cli": false`. Even then, an agent that can edit files in `~/.tas-guard` could tamper with state, so run trading agents without shell access to your home folder where you can.
- **Values use the order's own price.** A market order by quantity has no price, so it needs approval by default. Live price lookup is on the roadmap.
- **No P&L-based stop yet.** Daily limits cap how much the agent can trade, not how much it can lose.
- **Quote currency is per symbol** for ccxt (BTC/USDT is in USDT, ETH/BTC is in BTC). Use `symbols_allow` to keep limits meaningful.
- **It's a seatbelt, not a guarantee.** The broker's own controls still matter. Not financial advice.

## Development

```
npm test        # 106 tests: unit, end to end through a mock broker over real MCP stdio, the phone flow against a mock Telegram API,
                # onchain mode (transaction decoding, policy, and the RPC proxy against a mock EVM node), Solana mode
                # (decoder, policy, and the RPC + WebSocket proxy against a mock Solana chain that executes transactions), and
                # Hyperliquid mode (signing checked byte for byte against the official Python SDK, and the MCP flow against a
                # mock Hyperliquid API that verifies every signature). All offline.
```

MIT licensed. Built by [TradingAgentStack](https://tradingagentstack.com), the independent directory of what AI trading tools can do with your money.
