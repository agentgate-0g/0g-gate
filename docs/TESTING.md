# AgentGate — Testing Guide

How to test AgentGate at every level: automated tests (offline), the scripted demo, the
local mock stack in a browser, and the **live 0G Galileo Testnet** deployment. Each level is
independent — you can stop after level 1 (no keys/network needed) or go all the way to a
real paid call on-chain.

> **Level 4 status:** the contracts are **deployed to 0G Galileo** and level 4 runs against
> them — see the [README "Deployed addresses"](../README.md#deployed-addresses) table for the
> addresses and [contracts-evm/README.md](../contracts-evm/README.md#deploying) for the deploy
> command. It needs a funded key; levels 1–3 run today, offline, with no keys.

## Prerequisites

- **Node ≥ 22** (`node -v`). Then `npm install` at the repo root.
- **[Foundry](https://getfoundry.sh)** (`forge`, `cast`, `anvil`) — required for a full
  `npm test`, not just for the contracts. `packages/chain`'s live-client suites spawn a real
  `anvil` and deploy the contracts to it, so without the toolchain those 35 tests **fail**
  rather than skip. Install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
  `contracts-evm/lib/` is gitignored, so vendor forge-std once:
  `cd contracts-evm && forge install foundry-rs/forge-std@v1.16.2 --no-git --shallow`.
- For **live** tests (level 4): a 0G Galileo account funded at <https://faucet.0g.ai>
  (0.1 OG per wallet per day). No API key is needed for anything — every read is a
  public-RPC view call. See "Live setup" below.

---

## Level 1 — Automated tests (offline, no keys, ~20s)

```bash
npm install
npm run typecheck     # tsc --noEmit across all 9 packages + dashboard — must be clean
npm test              # vitest: 423 tests across 31 files — all green
```

What `npm test` covers (highlights): the x402 codec (encode/decode + every malformed-input
rejection), the 402 paywall state machine (single-use nonce, SSRF guard, header-whitelist
proxy, admin auth, Retry-After/X-PAYMENT-RESPONSE), the `fetchPaid` client (parse → pay →
retry, price cap, network-mismatch), both chain clients — including `Live0gClient` against a
real `anvil` with the real contracts — money/bigint math, the buyer agent, and the full
**e2e loop** (`e2e/loop.test.ts`: register → 402 → underpay → pay → serve → replay-reject →
attest → score, with TTL + inactive paths).

**Smart contracts** (Solidity, Foundry — no node needed):

```bash
cd contracts-evm && forge test        # 42 tests across the three suites
```

Covered: registration validation (empty/whitespace name, sub-floor price, empty `accepts`),
1-based id assignment, owner/attestor authorization on every mutating entrypoint, the
duplicate-payment-hash guard (and that it is scoped per-service), the 100-entry attestation
ring buffer (wrap-around, newest-first ordering), score accounting, `PaymentRouter`'s
checks-effects-interactions ordering (a failed transfer leaves the nonce unburned, so the
invoice stays payable), and every one of `SpendGuard.debit`'s ordered revert checks.

---

## Level 2 — Scripted full-loop demo (offline, no keys/network, ~0.1s)

```bash
npm run demo
```

Boots an in-memory mock chain + oracle + gateway in-process, wraps the oracle at 0.5 OG,
runs the LLM buyer agent (deterministic `MockLlm` — no API key), and walks the whole loop.
**Expected:** exits 0 and prints a **payment tx hash**, an **attestation tx hash**, and
**final score `1/1`**. This is the fastest end-to-end proof the product logic works.

> The demo boots its own throwaway chain and exits, so its data does **not** appear in the
> dashboard. Use level 3 (or 4) to view data live.

---

## Level 3 — Local mock stack in a browser

```bash
npm run dev:seed        # boots devnet :4030 + oracle :4010 + middleware :4021,
                        # seeds one wrapped service + a real (mock) paid call, then stays up
npm run dev:dashboard   # second terminal → open the URL it prints (http://localhost:3000)
```

Then exercise it:

- **Dashboard** `http://localhost:3000` — catalog shows the seeded service with a trust score;
  `/services/1` has the metadata + a copyable curl snippet; `/activity` shows the events.
- **402 challenge** (the paywall):
  ```bash
  curl -i http://localhost:4021/svc/1     # → HTTP 402 + x402 PaymentRequiredResponse JSON
  ```
- **Manual pay loop** with the CLI/agent (the printed export lines set the mock accounts):
  ```bash
  npm run agent -- --task "Get today's USD/IDR rate and gold price"
  ```

In mock mode the SSRF guard is off (localhost upstreams allowed) and no real keys are used.

---

## Level 4 — Live 0G Galileo Testnet

### 4a. Deploy the contracts (one time)

Fund a deployer address at <https://faucet.0g.ai>, then:

```bash
cd contracts-evm
export ZG_RPC_URL=https://evmrpc-testnet.0g.ai
forge script script/Deploy.s.sol:Deploy --rpc-url "$ZG_RPC_URL" \
  --private-key "$DEPLOYER_KEY" --broadcast
```

All three contracts cost roughly **0.014 OG** in total — inside a single day's faucet grant.
The script prints `REGISTRY_CONTRACT_ADDRESS=`, `PAYMENT_ROUTER_ADDRESS=` and
`SPEND_GUARD_ADDRESS=`. Verify each on <https://chainscan-galileo.0g.ai>.

Prefer to rehearse first? `contracts-evm/README.md` documents an Anvil-fork dry run that
proves the deploy against real 0G chain state without spending faucet funds.

### 4b. Live setup

Create the root `.env` from `.env.example` and fill the live values:

```bash
cp .env.example .env
# then set in .env:
#   AGENTGATE_MODE=live
#   REGISTRY_CONTRACT_ADDRESS=0x…      # from 4a
#   PAYMENT_ROUTER_ADDRESS=0x…         # from 4a
#   AGENTGATE_ADMIN_TOKEN=<a strong non-default token>   # live mode refuses the default
#   GATE_SIGNER_KEY / BUYER_SIGNER_KEY / SELLER_SIGNER_KEY=0x<64 hex>
```

> 🔒 **Keep private keys OUT of the repo.** `.env` and `Priv_key_*/` are gitignored — never
> commit key material. Note that an env var is *not* a strong secret store: it leaks through
> `docker inspect`, `/proc/<pid>/environ`, platform dashboards and crash dumps. See
> [DEPLOY-GATEWAY.md](./DEPLOY-GATEWAY.md) for the operator hardening steps.

The **dashboard** loads env from its own directory, so for a live dashboard create
`dashboard/.env.local` (gitignored) with the **read-only** subset (no signer keys needed —
the dashboard only reads): `AGENTGATE_MODE`, `ZG_RPC_URL`, `ZG_CHAIN_ID`, `ZG_NETWORK`,
`ZG_EXPLORER_URL`, `REGISTRY_CONTRACT_ADDRESS`, `PAYMENT_ROUTER_ADDRESS`,
`AGENTGATE_ADMIN_TOKEN`.

### 4c. Live dashboard

```bash
npm run dev:dashboard    # reads dashboard/.env.local → live mode
```

Open `http://localhost:3000/catalog` — it now reads the **deployed contract**.
`/api/services` returns `"network": "0g-galileo"`.

### 4d. Live x402 gateway

```bash
npm run dev:live    # boots the middleware in live mode against the deployed contracts
```

It prints the next steps. Register a service and map it to a **public** upstream (live-mode
SSRF blocks localhost):

```bash
export SELLER_SIGNER_KEY=0x…
npx tsx packages/cli/src/bin.ts wrap https://open.er-api.com/v6/latest/USD \
  --name "USD FX" --price 0.001 --gateway http://localhost:4021

curl -i http://localhost:4021/svc/1     # → HTTP 402 read from the LIVE registry
```

`wrap` maps the upstream by signing an ownership challenge with the seller key — no admin
token needed in live mode.

### 4e. Full paid loop on testnet (spends OG)

```bash
export BUYER_SIGNER_KEY=0x…
npx tsx packages/cli/src/bin.ts buy 1 --max 1
```

Under the hood: read the 402 (`accepts[0].payTo`, `maxAmountRequired`, `extra.nonce`,
`extra.router`) → call `PaymentRouter.pay{value: maxAmountRequired}(serviceId, nonce, payTo)`
→ retry with `X-PAYMENT: <base64 of {x402Version:1, scheme:"exact-settled", network:"0g-galileo",
payload:{transaction:<txHash>, nonce:<nonce>}}>` → **200 + upstream data**, and the
gateway records an on-chain `recordAttestation` (score → `(1,1)`).

The product's own `Live0gClient` does all of this — see `packages/chain/src/live-0g.ts`
(`registerService`, `transfer`, `verifyTransfer`, `recordAttestation`).

There is also a read-path smoke test against the real deployment:

```bash
AGENTGATE_MODE=live REGISTRY_CONTRACT_ADDRESS=0x… npx tsx scripts/smoke-live-read.ts
```

---

## Expected results — quick checklist

| Check | Pass condition |
|---|---|
| `npm run typecheck` | clean, exit 0 |
| `npm test` | 423 passed (31 files) |
| `cd contracts-evm && forge test` | 42 passed |
| `npm run demo` | exit 0; payment + attestation tx hashes + score `1/1` |
| `npm run dev:seed` + dashboard | catalog populated; `/svc/1` → 402; `/activity` has events |
| Live dashboard `/api/services` | `"network":"0g-galileo"`, service `(1,1)` |
| `npm run dev:live` + `curl /svc/1` | HTTP 402 x402 `PaymentRequiredResponse` |
| Explorer | register / pay / attest tx all `Success` |

---

## Troubleshooting (real gotchas)

- **`npm test` fails in `live-0g-reads`/`live-0g-writes` `beforeAll`:** Foundry is missing or
  `contracts-evm/lib/forge-std` is not vendored. These suites spawn `anvil` and `forge create`
  — they fail rather than skip by design, because a suite that cannot run looks identical to
  one with nothing to say. See Prerequisites.
- **Dashboard catalog empty / "chain unreachable":** the dashboard is in mock mode. Next.js
  loads env from `dashboard/`, not the repo root — create `dashboard/.env.local` (4b) and
  restart `npm run dev:dashboard`.
- **`curl :4021/...` connection refused:** the gateway isn't running. Start it: `npm run dev`
  (mock) or `npm run dev:live` (live).
- **Live `/svc/:id` → 503 instead of 402:** the service isn't mapped on the gateway, or the
  mapped upstream is private/localhost (live-mode SSRF rejects it) — map a public URL (4d).
- **`CONTRACT_NOT_DEPLOYED` (503) on any read/write:** `REGISTRY_CONTRACT_ADDRESS` (or
  `PAYMENT_ROUTER_ADDRESS` for a payment) is unset in the env that process sees. Set it (4b).
- **`CONFIG_INVALID: … must be a 0x-prefixed 32-byte hex private key`:** a signer key is
  malformed. The message names the variable and never the value — check the env var it names,
  and note that a stray quote or trailing newline counts.
- **Faucet says you already claimed:** the cap is 0.1 OG per wallet per day. Deploying all
  three contracts fits inside one grant (~0.014 OG), so there is no need to split it across
  two days — but a fresh demo wallet needs its own claim.
