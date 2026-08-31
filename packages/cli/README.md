# agentgate-0g

Wrap any HTTP API into a **paid HTTP 402 service on 0G** — micropayments in native OG, with on-chain discovery and reputation. One command turns your endpoint into a machine-payable service that AI agents can discover, pay, and rate autonomously.

Wire format is the **x402 V1 envelope** (`accepts[]`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`). Settlement is **not** x402's `exact` scheme and does not claim to be: the scheme is `exact-settled`, meaning the buyer settles on-chain first and presents the tx hash, rather than signing an authorization for a facilitator to submit. 0G has no x402 facilitator, so there is no third party in the money path.

Services carry an on-chain **`accepts[]` price list**, so a service can advertise more than one payment asset. The shipped rail is **native OG only**: every payment settles by calling `PaymentRouter.pay(serviceId, nonce, payTo)` on 0G Galileo, which binds the x402 invoice nonce to the payment on-chain.

## Read the live catalog — zero setup

The read commands run against 0G Galileo Testnet with **no configuration, no keys, and no API key** — every read is a public-RPC view call:

```bash
npx agentgate-0g list        # on-chain service catalog with scores + trust tiers
npx agentgate-0g status 1    # one service: record, price, trust, attestations
```

## Wrap your API (writes)

`wrap` registers your service **on 0G Galileo Testnet** and drops a 402 paywall in front of it — one line, the only thing besides the args is your funded wallet key:

```bash
export SELLER_SIGNER_KEY=0x…   # 32-byte hex private key, funded at https://faucet.0g.ai
npx agentgate-0g wrap https://api.example.com/gold --price 2.5 --name "Gold Spot Feed"
```

It signs the on-chain registration with that key, then maps your upstream on the gateway by **signing an ownership challenge (EIP-191) with the same key** — no shared admin token. `--gateway` defaults to the hosted gateway; pass it to target a local or self-hosted one. (A key is irreducible: registering on-chain is a signed, gas-paying transaction.)

## Buy a call (writes)

`buy` runs the whole 402 exchange for you: fetch the `402` invoice, pay it by calling **`PaymentRouter.pay(serviceId, nonce, payTo)`** with the invoice's price as `msg.value`, retry with the `X-PAYMENT` proof, and print the result — response body on **stdout** (pipeable), payment receipt on **stderr**:

```bash
export BUYER_SIGNER_KEY=0x…
npx agentgate-0g buy 1 --max 5
```

`--max` is a budget cap: any invoice priced above it is refused (`PRICE_EXCEEDED`) before a single wei moves. Unknown or paused services fail fast before any payment.

## Use from any MCP agent

`mcp` serves AgentGate as a Model Context Protocol **stdio server**, so any MCP-capable agent (Claude Desktop, a custom client, an MCP-aware framework) gets AgentGate as native tools — discover, inspect, and pay services:

```bash
npx agentgate-0g mcp
```

Tools: `agentgate_list_services`, `agentgate_get_service`, `agentgate_get_invoice` (read-only, no key) and `agentgate_buy` (pays a 402 invoice in native OG from the buyer key, capped by `maxOg`). Wire it into Claude Desktop's `claude_desktop_config.json`:

```json
{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "agentgate-0g", "mcp"] } } }
```

## Use it as a library

The same functions the CLI runs are exported, so an agent can skip the subprocess. Reads need no key:

```ts
import { createChainClient, loadConfig, listServices, formatOg } from 'agentgate-0g';

const chain = createChainClient(loadConfig({ AGENTGATE_MODE: 'live' }, { requireStrongAdminToken: false }));

for (const { service, score, tier } of await listServices({ chain })) {
  console.log(`#${service.id} ${service.name} — ${formatOg(service.priceWei)} · ${tier} · ${score.successCalls}/${score.totalCalls}`);
}
```

`createChainClient` builds the `ChainClient` that every function takes as `chain`. The public types (`ChainClient`, `ServiceRecord`, `ServiceScore`, `AttestationRecord`, `AnySigner`, `TrustTier`, `Wei`, `AgentGateConfig`) are exported too, along with `AgentGateError` / `isAgentGateError` for handling failures by `code` rather than by matching message text.

Writes take the same shape, with a signer: `wrapService`, `mapService`, `buyService`, `setServiceActive`.

## Flags & environment

Every config value can be given as a flag **or** an env var; precedence is **flag > env var > built-in default**.

| Flag | Env var | Needed for |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all (CLI defaults to `live`) |
| `--rpc-url <url>` | `ZG_RPC_URL` | all (defaults to `https://evmrpc-testnet.0g.ai`) |
| `--registry <address>` | `REGISTRY_CONTRACT_ADDRESS` | all (defaults to the deployed registry) |
| `--gateway <url>` | — | wrap, map (default to the hosted gateway in live) · buy (defaults to the service's on-chain endpoint) |
| `--key <0xhex>` | `SELLER_SIGNER_KEY` (wrap/map/pause/resume) · `BUYER_SIGNER_KEY` (buy/mcp) | live writes — your wallet key |
| `--max <og>` | — | buy: refuse invoices priced above this many OG |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | mock / self-hosted-admin mapping only |

> **`--key` IS a secret.** Unlike a file path, it carries your private key itself: a `--key` argument lands in your shell history and is visible to any process that can read `ps`. **Prefer the env var** (`SELLER_SIGNER_KEY` / `BUYER_SIGNER_KEY`) and pass `--key` only for one-off runs in a shell you control. `--admin-token` is a secret too — same rule. Live `wrap` uses owner-signature auth, so no admin token is needed at all.
>
> The CLI never echoes a key: a malformed key is reported as `SELLER_SIGNER_KEY must be a 0x-prefixed 32-byte hex private key`, with no value attached.

On an invalid value the CLI fails fast with a clear one-line message (e.g. `error: SIGNER_MISSING: live mode needs a seller key — pass --key <0x…> or set SELLER_SIGNER_KEY`) — never a stack trace.

## Commands

- `list` — list on-chain services (zero-config)
- `status <id>` — service detail + reputation + attestation history (zero-config)
- `wrap <url> --price <OG> --name <name>` — register + put a 402 paywall in front of an API
- `map <id> <url>` — point the gateway at a service that is **already registered**. This is the recovery path when `wrap`'s on-chain registration lands but the gateway mapping does not: re-running `wrap` would register a *second* service and cost gas again, and the registration cannot be undone
- `buy <id>` — pay a service's 402 invoice and print the response (`--max` caps the price)
- `mcp` — serve AgentGate as an MCP stdio server (agent tools: list / inspect / buy)
- `pause <id>` / `resume <id>` — toggle a service you own
- `demo-accounts` — mint faucet-funded buyer/seller accounts on the mock devnet (mock mode only)

## Notes

- Node ≥ 22 required.
- Network: 0G Galileo Testnet (chain id `16602`) · explorer <https://chainscan-galileo.0g.ai> · faucet <https://faucet.0g.ai>
- Source: https://github.com/agentgate-0g/0g-gate
