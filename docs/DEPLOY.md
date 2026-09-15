# AgentGate — Live-mode deploy runbook

> **Targets: 0G Galileo Testnet** (chain ID `16602`) and **0G Mainnet** (chain ID `16661`), native OG, 18 decimals.
> **Status: deployed on both.** Galileo (2026-09-03, block 52865624): `AgentGateRegistry`
> `0xDB3C29a09FdDe79828208603B743E769E9f6dBEe`, `PaymentRouter` `0xCC3bbd10eBA7aa24F4F722E00e714e1413182c34`,
> `SpendGuard` `0xfEA4236162d7126d90D59Dc15bBb8A93b3786938` — the full seller and buyer paths have been run against
> them. Mainnet (2026-09-15, blocks 44406357–44406358): `AgentGateRegistry`
> `0x48144BF9d966789bf4Db4e84349d4F4878a4b7Da`, `PaymentRouter` `0x5102EB216b65CF950D3e88c8ddD51008de0845eF`,
> `SpendGuard` `0xDfD0f8eE32Cb01015cD131d463E83e6974A9D761`, source verified on chainscan.0g.ai.
> This runbook is the recipe that produced them, kept so the deploy is reproducible on a fresh key.
>
> Three things worth knowing before you start:
>
> 1. **On Galileo the faucet caps you at 0.1 OG per wallet per day; on mainnet it is real OG.**
>    Deploying all three contracts costs **0.0196 OG** (4,900,008 gas at 0G's ~4 gwei priority
>    fee, measured on both networks) — five times over inside one faucet grant, so there is no
>    need to split a testnet deploy across two days. Budget for **three** funded wallets
>    though, one per role, because the contract will not let you collapse them:
>    `registerService` reverts `InvalidAttestor` when the attestor equals `msg.sender` (the
>    seller doing the registering) or equals `paymentTarget`, and `setAttestor` refuses the same
>    pairings on rotation. So "seller and gate share one wallet" is not a shortcut you get away
>    with on a demo — it is refused on-chain.
>
>    Keep them apart for the same reason the contract does, and note what that means for
>    custody: `GATE_SIGNER_KEY` is the attestor, and it lives in the environment of an
>    **internet-facing** gateway process, so it is the key most likely to be stolen — fund it
>    thin, it only ever pays attestation gas. `SELLER_SIGNER_KEY` owns the service and its
>    `paymentTarget` **receives every payment**, so it is the revenue key: keep it in operator
>    custody (offline or a hardware signer), and never copy it onto the gateway host. The
>    deployer is not an on-chain role at all — that key can be any of them, or a fourth.
>
>    The buyer must be a distinct address too: the anti-wash-trading guard skips the attestation
>    when the payer is the service's own owner, payout address or attestor, so a demo where
>    buyer and seller share a wallet records a payment but leaves the score at 0/0.
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
forge test      # 143 tests across nine suites, must be green
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

### Deploying to mainnet — name the chain, and verify

For a deploy that costs real money, use `runOnChain(uint256)` and the **named**
`mainnet` rpc_endpoint from `foundry.toml`, not `$ZG_RPC_URL`:

```bash
cd contracts-evm
forge script script/Deploy.s.sol:Deploy \
  --sig "runOnChain(uint256)" 16661 \
  --rpc-url mainnet --private-key "$DEPLOYER_KEY" \
  --priority-gas-price 4000000000 --with-gas-price 6000000000 \
  --broadcast
```

Two things that are easy to skip and expensive to skip:

- **`--sig "runOnChain(uint256)" 16661`** makes the script revert unless the
  connected chain really is mainnet. The `galileo` rpc_endpoint is literally
  `"${ZG_RPC_URL}"`, so `--rpc-url galileo` deploys wherever that variable
  happens to point — an operator with mainnet exported deploys to mainnet while
  every word on screen says testnet. These contracts are immutable and permanent.
- **Verification** is not optional for a contract that holds money. Three
  addresses whose source nobody can read is not a shippable state. It is a
  separate step, because Foundry's built-in `etherscan` verifier (what
  `--verify` on the script uses) rejects chain 16661 as unsupported; the
  **custom** verifier against the explorer's `/open/api` base is what verified
  the 2026-09-15 mainnet set and the Galileo set. Note the base is `/open/api`,
  **not** `/api` — `/api` serves the explorer's single-page app, so a deploy
  "verified" against it was never verified at all.

Verify each contract right after the broadcast (the explorer takes any
non-empty API key; `--watch` polls until the explorer answers):

```bash
V="--verifier custom --verifier-url https://chainscan.0g.ai/open/api --verifier-api-key placeholder --chain-id 16661 --watch"
forge verify-contract $V <router>   src/PaymentRouter.sol:PaymentRouter
forge verify-contract $V <registry> src/AgentGateRegistry.sol:AgentGateRegistry \
  --constructor-args $(cast abi-encode "constructor(address)" <router>)
forge verify-contract $V <guard>    src/SpendGuard.sol:SpendGuard \
  --constructor-args $(cast abi-encode "constructor(address)" <registry>)
```

For Galileo, swap the URL for `https://chainscan-galileo.0g.ai/open/api` and the
chain id for `16602`.

Then confirm on the explorer that all three show verified source before
announcing the addresses anywhere.

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
   the deployment with zero configuration — via `npx tsx scripts/set-deployment.ts`, which
   verifies the three on the chain first and records, next to them, the block they were created
   in (`deployBlock`). Every `eth_getLogs` history read starts there, so a wrong block silently
   hides the deployment's earliest events; the script bisects `eth_getCode` for it rather than
   trusting a pasted number.

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
CONTRACTS_DEPLOY_BLOCK=                       # only if these addresses are NOT the profile's: the block they were deployed in (the receipt's blockNumber in contracts-evm/broadcast/…/run-latest.json)
GATE_SIGNER_KEY=0x…  BUYER_SIGNER_KEY=0x…  SELLER_SIGNER_KEY=0x…
AGENTGATE_ADMIN_TOKEN=<strong unique token>   # loadConfig() refuses the default in live mode
INVOICE_STORE_PATH=<abs path>/data/gateway-invoices.json   # live mode refuses to boot without it
```

One `.env` holding all three keys is the **developer** configuration: this box drives every
role of the demo loop itself. A real deployment splits them by custody — only `GATE_SIGNER_KEY`
belongs on the gateway host (see [DEPLOY-GATEWAY.md](DEPLOY-GATEWAY.md#notes--security)), the
seller/payout key signs from the operator's own machine, and the buyer key belongs to whoever
is buying.

`loadConfig()` hard-fails on a malformed key or registry address, and on live mode with the
default admin token. A malformed key is reported **by variable name only** — the value never
reaches a log line or an error message. `createApp()` adds one more live-mode refusal:
`INVOICE_STORE_PATH` must be set, because an in-memory invoice store loses every in-flight
payment on restart and `PaymentRouter` has no refund path.

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
