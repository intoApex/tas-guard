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

Zero dependencies. About 800 lines of plain JavaScript you can read in one sitting.

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

A profile says what each tool of a server can do with money and where its order fields live. The schema is [`schema/connector-profile.v1.json`](schema/connector-profile.v1.json). Built-in profiles are verified against each server's source code, with the commit recorded:

- `alpaca-mcp-server`: alpacahq/alpaca-mcp-server @ 2a973a0
- `ccxt-mcp-server`: ccxt/ccxt `mcp/` @ 310bf4b

Using a server without a profile? `"profile": "auto"` classifies tools by name and MCP annotations, and blocks anything it doesn't recognize. Profiles for more brokers are welcome as PRs.

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
npm test        # 34 tests: unit, end to end through a mock broker over real MCP stdio, and the phone flow against a mock Telegram API
```

MIT licensed. Built by [TradingAgentStack](https://tradingagentstack.com), the independent directory of what AI trading tools can do with your money.
