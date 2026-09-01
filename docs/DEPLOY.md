# AgentGate — Live-mode deploy runbook

> **Target: 0G Galileo Testnet** (chain ID `16602`, native OG, 18 decimals).
> **Status: deployed and exercised.** The three contracts are live on Galileo —
> `AgentGateRegistry` `0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1`, `PaymentRouter` `0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F`,
> `SpendGuard` `0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781` — and the full seller and buyer paths have been
> run against them. This runbook is the recipe that produced them, kept so the deploy is
> reproducible on a fresh key.
>
> Three things worth knowing before you start:
>
> 1. **The faucet caps you at 0.1 OG per wallet per day.** Deploying all three contracts costs
>    roughly **0.015 OG** at 0G's ~4 gwei priority fee — several times over inside one grant, so
>    there is no need to split the deploy across two days. You do need **two** funded wallets
>    though: the anti-wash-trading guard skips the attestation when the payer is the service's
>    own owner or payout address, so a demo where buyer and seller share a wallet records a
>    payment but leaves the score at 0/0. Deployer, seller and gate may share one wallet; the
>    **buyer must be a different one**.
> 2. **Contract timestamps are milliseconds, not seconds.** EVM `block.timestamp` is in
>    seconds; every contract here stores and emits `uint64(block.timestamp) * 1000` because
>    every off-chain reader is contracted on ms. If you fork or re-derive a contract, keep it.
> 3. **Nothing is upgradable.** There is no proxy — a redeploy is a *new address* starting from
>    empty state (`servicesCount == 0`, no attestation history). Plan the cutover accordingly.

## 1. Prerequisites

- **[Foundry](https://getfoundry.sh)** (`forge`, `cast`, `anvil`) — built and tested against
  `1.5.1-stable`. `contracts-evm/lib/` is gitignored, so vendor forge-std once:
  `cd contracts-evm && forge install foundry-rs/forge-std@v1.16.2 --no-git --shallow`.
- A funded **deployer** key, plus keys for three runtime roles: gate/attestor
  (`GATE_SIGNER_KEY`), buyer (`BUYER_SIGNER_KEY`), seller (`SELLER_SIGNER_KEY`). Each is a
  `0x`-prefixed 32-byte hex private key. Faucet: <https://faucet.0g.ai>.
- **No API key of any kind.** Reads go straight to the public RPC
  (`https://evmrpc-testnet.0g.ai`); there is no indexer in the stack.

Confirm the chain id before you spend anything — older sources say 16601:

```bash
cast chain-id --rpc-url https://evmrpc-testnet.0g.ai    # → 16602
```

## 2. Build & test the contracts

```bash
cd contracts-evm
forge build     # solc 0.8.28, optimizer 200 runs, evm_version = cancun
forge test      # 77 tests across the five suites, must be green
```

Runtime bytecode is well inside EIP-170's 24,576-byte limit for all three (largest is
`AgentGateRegistry` at 6,850 bytes), so there is no size-related deploy risk.

## 3. Dry run against real 0G state (free, repeatable)

This proves the deploy against 0G's *actual* chain configuration without spending faucet
funds, by forking it locally:

```bash
cd contracts-evm
anvil --fork-url https://evmrpc-testnet.0g.ai --port 8545 &
# Anvil's banner prints ten funded test accounts and their private keys — deterministic,
# drawn from the well-known public "test test … junk" mnemonic. Safe against a local fork
# and worthless anywhere else; never fund one on a live network.
export ANVIL_ACCOUNT_0_KEY=<paste Account #0's key from the banner>
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --private-key "$ANVIL_ACCOUNT_0_KEY" --broadcast
kill %1
```

Expected: three addresses printed, `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`, no revert. The
addresses are local-fork artifacts that vanish when Anvil exits — they are **not** real
deployments. (`contracts-evm/broadcast/` will contain a `16602/` directory afterwards, because
the fork inherits 0G's chain id. Do not mistake it for a real deployment: check
`cast code <addr> --rpc-url https://evmrpc-testnet.0g.ai` — a real deployment returns bytecode,
a fork artifact returns `0x`.)

## 4. Deploy for real

```bash
cd contracts-evm
export ZG_RPC_URL=https://evmrpc-testnet.0g.ai
forge script script/Deploy.s.sol:Deploy --rpc-url "$ZG_RPC_URL" \
  --private-key "$DEPLOYER_KEY" \
  --priority-gas-price 4000000000 \
  --with-gas-price 6000000000 \
  --broadcast
```

> **0G rejects Foundry's auto-estimated fee — pass the tip explicitly.** 0G's base
> fee is ~7 **wei**, so `forge script` derives a priority fee of 1 wei and the node
> refuses the transaction:
>
> ```
> error code -32000: transaction gas price below minimum:
> gas tip cap 1, minimum needed 2000000000
> ```
>
> The node enforces a **2 gwei minimum priority fee** and suggests 4 gwei via
> `eth_maxPriorityFeePerGas`; Foundry does not consult that. Pass it yourself with
> `--priority-gas-price 4000000000 --with-gas-price 6000000000`. This is a Foundry
> estimation quirk, not a contract problem: the runtime client uses viem, which
> *does* call `eth_maxPriorityFeePerGas`, so gateway and CLI writes need no flag.

`$DEPLOYER_KEY` is exported for this one command — never committed, never written to a
tracked file. The script prints three lines to paste onward:

```
REGISTRY_CONTRACT_ADDRESS=0x…
PAYMENT_ROUTER_ADDRESS=0x…
SPEND_GUARD_ADDRESS=0x…
```

Record them in **three** places:

1. the root `.env` (step 5),
2. the address tables in [`contracts-evm/README.md`](../contracts-evm/README.md) and
   [`README.md`](../README.md), with `https://chainscan-galileo.0g.ai/address/<addr>` links,
3. `DEFAULT_REGISTRY_ADDRESS` in `packages/shared/src/config.ts`, so the published CLI targets
   the deployment with zero configuration.

Verify each address resolves on <https://chainscan-galileo.0g.ai>.

## 5. Configure live mode

```bash
AGENTGATE_MODE=live
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_CHAIN_ID=16602
ZG_NETWORK=0g-galileo
ZG_EXPLORER_URL=https://chainscan-galileo.0g.ai
REGISTRY_CONTRACT_ADDRESS=<from step 4>
PAYMENT_ROUTER_ADDRESS=<from step 4>
SPEND_GUARD_ADDRESS=<from step 4>
ACTIVITY_LOOKBACK_BLOCKS=50000
GATE_SIGNER_KEY=0x…  BUYER_SIGNER_KEY=0x…  SELLER_SIGNER_KEY=0x…
AGENTGATE_ADMIN_TOKEN=<strong unique token>   # loadConfig() refuses the default in live mode
```

`loadConfig()` hard-fails on a malformed key or registry address, and on live mode with the
default admin token. A malformed key is reported **by variable name only** — the value never
reaches a log line or an error message.

## 6. `CONTRACT_NOT_DEPLOYED` call paths (all gated, checked before any IO)

`Live0gClient` (`packages/chain/src/live-0g.ts`) throws
`AgentGateError('CONTRACT_NOT_DEPLOYED', …, 503)` from every contract-dependent method while the
relevant address is unset:

| # | Method | Needs | Address |
|---|---|---|---|
| 1 | `getService(id)` | `getService` view call | `REGISTRY_CONTRACT_ADDRESS` |
| 2 | `listServices()` | `servicesCount()` + per-id reads | `REGISTRY_CONTRACT_ADDRESS` |
| 3 | `getScore(id)` | `getScore` view call | `REGISTRY_CONTRACT_ADDRESS` |
| 4 | `listAttestations(serviceId)` | `getAttestations` view call | `REGISTRY_CONTRACT_ADDRESS` |
| 5 | `listRecentActivity()` | `eth_getLogs` over 3 event topics | both |
| 6 | `registerService(...)` | `registerService` write | `REGISTRY_CONTRACT_ADDRESS` |
| 7 | `recordAttestation(...)` | `recordAttestation` write | `REGISTRY_CONTRACT_ADDRESS` |
| 8 | `setActive(...)` | `setActive` write | `REGISTRY_CONTRACT_ADDRESS` |
| 9 | `transfer(...)` | `PaymentRouter.pay` | `PAYMENT_ROUTER_ADDRESS` |
| 10 | `verifyTransfer(...)` | tx receipt + `Paid` log match | `PAYMENT_ROUTER_ADDRESS` |

Only `getBalance` (`eth_getBalance`) works with no contract address at all.

## 7. Post-deploy verification checklist

Walk this top to bottom after the first deploy. Reads first — they cost nothing and catch a
wrong address immediately.

- [ ] **Bytecode is live:** `cast code <each address> --rpc-url $ZG_RPC_URL` returns bytecode,
      not `0x`. (This is the check that separates a real deploy from an Anvil-fork artifact.)
- [ ] **Read path:** `AGENTGATE_MODE=live REGISTRY_CONTRACT_ADDRESS=0x… npx tsx scripts/smoke-live-read.ts`
      — decodes `getService(1)` / `getScore(1)` / `listServices()` against the real deployment.
      This is the gate that catches a stale ABI or a wrong address, which the anvil-backed
      suite cannot: it deploys the contract it then tests.
- [ ] **Catalog:** `npx tsx packages/cli/src/bin.ts list` and the dashboard `/catalog` both
      render the registry.
- [ ] **Timestamps are ms:** a registered service's `createdAt` is a 13-digit unix ms value,
      not a 10-digit seconds one. A seconds value here means the `* 1000` was lost somewhere.
- [ ] **Write path:** `agentgate wrap` a real public upstream, then `agentgate buy <id>`. The
      buy must produce a `Paid` log with `serviceId` and `nonce` indexed, a 200 with the
      upstream body, and an on-chain `recordAttestation` moving the score to `(1,1)`.
- [ ] **Replay is rejected twice over:** re-sending the same `X-PAYMENT` proof gets
      `402 invoice_used` from the gateway, and re-calling `PaymentRouter.pay` with the same
      `(serviceId, nonce)` reverts on-chain.
- [ ] **Explorer trail:** register / pay / attest all show `Success` on
      <https://chainscan-galileo.0g.ai>. Record the three tx hashes in
      `contracts-evm/README.md` as the demo trail.

## 8. Rollout order

1. Deploy contracts (§4) → set the three addresses (§5).
2. Run the §7 checklist, read paths first.
3. Start middleware + dashboard in live mode.
4. `agentgate wrap` the oracle (or any public API) — live mode needs no admin token, the
   seller key signs the ownership challenge.
5. Run the buyer agent with a small budget (`--budget 1`).
