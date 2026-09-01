# contracts-evm/ — AgentGate EVM Smart Contracts (0G Galileo Testnet)

The on-chain layer of AgentGate on **0G Galileo Testnet**: three Solidity
contracts, built and tested with [Foundry](https://getfoundry.sh).

| Contract | File | Purpose |
|---|---|---|
| `AgentGateRegistry` | `src/AgentGateRegistry.sol` | Service discovery + payment-attestation reputation. 1-based service ids, caller becomes owner, services start active, one attestation per payment tx (deduped), attestations kept as a 100-entry newest-first ring buffer, all timestamps in **unix milliseconds** (`block.timestamp * 1000`). |
| `PaymentRouter` | `src/PaymentRouter.sol` | Binds an x402 invoice nonce to an on-chain payment. `pay(serviceId, nonce, payTo)` forwards the full `msg.value` to `payTo` and emits `Paid` with `serviceId`/`nonce` indexed, so the gateway's verification is a single exact-match log/receipt lookup — no external indexer. The router never custodies funds: value in, value straight out, checks-effects-interactions ordered. |
| `SpendGuard` | `src/SpendGuard.sol` | On-chain x402 spend-firewall escrow. An agent opens a `Policy` and pre-funds it; before serving a paid call the policy's `gate` calls `debit`, which enforces budget, per-call cap, rate window, minimum trust tier, and payment-ref replay — atomically, on-chain, in a normative revert order. EVM port of `contracts/spend-guard`. |

All three: `pragma solidity 0.8.28`, no constructor arguments, not upgradable
(there is no proxy — a new version means a new address).

## Network

| Parameter | Value |
|---|---|
| Name | 0G Galileo Testnet |
| Chain ID | **16602** |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Explorer | `https://chainscan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` (0.1 OG per wallet per day) |
| Native token | OG, 18 decimals |

`evm_version = "cancun"` in `foundry.toml` was verified against the live node
before this was relied on: 0G Galileo executes `MCOPY` (a Cancun-only opcode)
correctly, checked against an undefined-opcode control to confirm the probe
was meaningful.

## Deployed addresses

> **Two deployments are live.** The audited-and-fixed contract set was deployed
> 2026-09-01 and is NOT yet in use: the CLI defaults, the hosted gateway and the
> Wave 3 demo all still point at the original set below it. Cutting over is a
> coordinated change — the ABIs differ, so the contracts and the gateway must
> switch together, and a new registry starts from empty state with no service
> and no score carried across.

### Audited set — deployed 2026-09-01, awaiting cutover

| Contract | Address | Explorer |
|---|---|---|
| `AgentGateRegistry` | `0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1` | [explorer](https://chainscan-galileo.0g.ai/address/0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1) |
| `PaymentRouter` | `0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F` | [explorer](https://chainscan-galileo.0g.ai/address/0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F) |
| `SpendGuard` | `0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781` | [explorer](https://chainscan-galileo.0g.ai/address/0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781) |

Block 52458928, all three in one block. Total cost **0.015197 OG**
(3,799,198 gas at 6 gwei). Constructor wiring verified live: `Registry.ROUTER()`
returns the router and `SpendGuard.REGISTRY()` returns the registry.

Closes three rounds of audit findings. Note the operational consequence: a
service's attestor may no longer be its owner or its payout address, so seeding
this registry needs three distinct addresses per service, not one.

**Seeded and cut over 2026-09-01.** The hosted gateway now runs this contract
set. Services 3 and 4 are live and each has taken a real paid call end to end —
buyer pays 0.001 OG through the router, the gateway serves the wrapped upstream
and attests the call itself — so both read 1/1.

| Role | Address |
|---|---|
| service owner + payout | `0xb5B4A886DA386830392a86288ed91d272dE17746` |
| attestor | `0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE` (the gateway's signer) |
| buyer | `0x69EcD4f412a130C0cD78BFE1fcDb8BF08F407bd3` |

**The attestor must be the gateway's signer, and the owner must not be.** This
is forced by the audit fix that stopped a seller witnessing its own score, and
it is not obvious until a live cutover: services 1 and 2 were first registered
with the gate key as OWNER and a standalone wallet as attestor, which looked
reasonable and passed every check — then every attestation failed with
`NotAuthorized`, because the gateway signs with the gate key and the gate key
was the owner. Services 1 and 2 are deactivated and kept as the record of that.

Seeding therefore needs three addresses, wired this way round: the seller owns
and is paid, the gateway attests, and the buyer is none of them.

The keys for the seller and buyer wallets are mode-600 files in
`~/.agentgate-{payout,buyer}.key` and are not in the repo.

### Original set — still live, still what everything uses

| Contract | Address | Explorer |
|---|---|---|
| `AgentGateRegistry` | `0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1` | [explorer](https://chainscan-galileo.0g.ai/address/0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1) |
| `PaymentRouter` | `0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F` | [explorer](https://chainscan-galileo.0g.ai/address/0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F) |
| `SpendGuard` | `0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781` | [explorer](https://chainscan-galileo.0g.ai/address/0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781) |

Deployed 2026-09-01 to 0G Galileo Testnet (chain 16602) in block 52458928 —
all three in a single block. Total cost 0.0152 OG (3,799,198 gas at a 4 gwei
priority fee). Bytecode verified live with `eth_getCode`: 9,069 / 940 / 6,133
bytes, matching `forge build --sizes` exactly.

These addresses are also the CLI's built-in defaults
(`packages/shared/src/config.ts`), which is what lets the published package read
the registry with no configuration.

## Proven on-chain

The full loop — register → 402 → pay → serve → attest → score — ran against
this deployment on 2026-09-01. Not a rehearsal: real transactions, a real
third-party upstream, real OG moving between two independent wallets.

| Step | Transaction |
|---|---|
| `registerService` — service #3 "USD FX Feed" @ 0.001 OG | [`0x58525104…`](https://chainscan-galileo.0g.ai/tx/0x5852510418fcced200573652b0e6c80c96ca5a877a543d29fbdf5b131b85aad0) |
| `PaymentRouter.pay(3, nonce, payTo)` — the buyer settling its own invoice | [`0x5a811b41…`](https://chainscan-galileo.0g.ai/tx/0x5a811b419403d1e8607c45f5f1f91cb7999bb72e203b04afe9c8708ce923f0bb) |
| `recordAttestation` — written by the gateway after serving | [`0x61828080…`](https://chainscan-galileo.0g.ai/tx/0x618280801950a7a5d74a715d9d38112989914b7c31c7deee8cfb8950ab074f55) |

Resulting state: `servicesCount() == 4`, service #3 scored `(1, 1)`, its
attestation keyed to the payment above. Services #1 and #2 are the retired pair
from before the attestor topology was corrected; they are deactivated.

Two details worth noting, because they are what makes the score meaningful:

- The upstream mapping was authorized by an **owner signature** (EIP-191), not a
  shared admin token — the gateway recovered the signer and compared it to the
  on-chain `owner`.
- The payer (`0x4c616528…`) is a **different wallet** from the service owner
  (`0x71a89a7e…`). Had they matched, the gateway would have served the call and
  taken the payment but recorded **no** attestation: the anti-wash-trading guard
  refuses to let a seller inflate its own reputation.

## Prerequisites

- [Foundry](https://getfoundry.sh) (forge/cast/anvil). Built and tested
  against `1.5.1-stable`.
- Solc `0.8.28` (fetched automatically by `forge build` via `svm` on first
  use).

## Build

```bash
cd contracts-evm
forge build
```

Runtime bytecode is well inside EIP-170's 24,576-byte limit for all three
contracts (largest is `AgentGateRegistry` at 6,850 bytes), so there is no
size-related deploy risk.

## Test

```bash
cd contracts-evm
forge test          # 77 tests across 5 suites, all passing
forge test -vvv      # verbose output, useful on failure
```

The suite (`test/*.t.sol`) covers: registration validation (empty/whitespace
name, sub-floor price, empty `accepts`), 1-based id assignment, owner/attestor
authorization on every mutating entrypoint, the duplicate-payment-hash guard
(and that it is scoped per-service), the 100-entry attestation ring buffer
(wrap-around, newest-first ordering), score accounting, `PaymentRouter`'s
checks-effects-interactions ordering (a failed transfer leaves the nonce
unburned, so the invoice stays payable), and every one of `SpendGuard.debit`'s
ordered revert checks plus its rate-window pruning (all-kept, all-pruned, and
partial-prune branches).

## Deploying

This package ships `script/Deploy.s.sol`, which deploys all three contracts in
one transaction batch and prints the resulting addresses to paste into `.env`
and the table above.

The deploy ORDER is load-bearing and the script encodes it:
`PaymentRouter` -> `AgentGateRegistry(router)` -> `SpendGuard(registry)`. The
registry verifies every attestation against a router settlement, and the guard
reads the registry for trust scores and payout targets, so each contract takes
the previous one as a constructor argument. There is no cycle, and deploying
them individually in a different order will not link up.

The script has already been dry-run against a local Anvil fork of live 0G
Galileo state (see **Dry run** below) — the bytecode deploys cleanly under
0G's actual chain configuration. The real broadcast additionally needs a
**funded deployer private key**, which only the deployer can supply, so it has
intentionally not been run yet.

**To deploy for real:**

1. Fund the deployer address at <https://faucet.0g.ai> (0.1 OG per wallet per
   day). At 0G's ~4 gwei gas price, deploying all three contracts costs
   roughly **0.014 OG** — about 7× headroom inside a single day's faucet
   grant. **One faucet claim is enough for all three deploys; there is no
   need to split the deploy across two days.**
2. Run:
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

   `$DEPLOYER_KEY` is the funded deployer's private key, exported in your
   shell for this one command. Never commit it, never write it to a tracked
   file — `.env` is git-ignored for exactly this reason.
3. The command prints three lines: `REGISTRY_CONTRACT_ADDRESS=0x...`,
   `PAYMENT_ROUTER_ADDRESS=0x...`, `SPEND_GUARD_ADDRESS=0x...`. Copy them into
   the root `.env` under those exact names, and into the address table above
   with `https://chainscan-galileo.0g.ai/address/<addr>` links. Verify each
   address resolves on the explorer.

### Dry run (already done — safe to repeat any time)

Proves the deploy against 0G's real chain state without spending faucet
funds, by forking it locally with Anvil:

```bash
cd contracts-evm
anvil --fork-url https://evmrpc-testnet.0g.ai --port 8545 &
```

Anvil's startup banner lists ten funded local test accounts and prints each
one's private key — deterministic every run, drawn from Anvil's well-known
public `test test … junk` mnemonic. Every one is safe to use against a local
fork and worthless anywhere else (never fund one on a live network). Export
Account #0's printed key and run the same script against the fork:

```bash
export ANVIL_ACCOUNT_0_KEY=<paste Account #0's private key from the banner above>
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --private-key "$ANVIL_ACCOUNT_0_KEY" --broadcast
kill %1
```

Expected: three addresses printed, `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`,
no revert. The addresses this prints are local-fork artifacts that vanish
when Anvil exits; they are not real deployments and are not recorded
anywhere in this repo.

### Redeploying

None of the three contracts are upgradable, so "redeploy" means deploying
fresh instances at new addresses — there is no in-place upgrade path:

```bash
cd contracts-evm
forge script script/Deploy.s.sol:Deploy --rpc-url "$ZG_RPC_URL" \
  --private-key "$DEPLOYER_KEY" --broadcast
```

A redeploy starts every contract from empty state (`servicesCount == 0`,
`policiesCount == 0`, no attestation history) — nothing carries over from a
prior deployment. Update the root `.env` and the address table above
afterward.
