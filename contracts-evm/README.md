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

| Contract | Address | Explorer |
|---|---|---|
| `AgentGateRegistry` | `0x2f5b7AaD7bffcEc5B6cda95Af4439494C1D576dA` | [explorer](https://chainscan-galileo.0g.ai/address/0x2f5b7AaD7bffcEc5B6cda95Af4439494C1D576dA) |
| `PaymentRouter` | `0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB` | [explorer](https://chainscan-galileo.0g.ai/address/0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB) |
| `SpendGuard` | `0x08b4049802999245888E72D0C31Fb4cA55C30E1B` | [explorer](https://chainscan-galileo.0g.ai/address/0x08b4049802999245888E72D0C31Fb4cA55C30E1B) |

Deployed 2026-08-31 to 0G Galileo Testnet (chain 16602) in block 52351975.
Total cost 0.0116 OG (2,899,438 gas at a 4 gwei priority fee). Bytecode verified
live with `cast code`: 6,850 / 935 / 4,369 bytes, matching `forge build --sizes`
exactly.

These addresses are also the CLI's built-in defaults
(`packages/shared/src/config.ts`), which is what lets the published package read
the registry with no configuration.

## Proven on-chain

The full loop — register → 402 → pay → serve → attest → score — ran against
this deployment on 2026-08-31. Not a rehearsal: real transactions, a real
third-party upstream, real OG moving between two independent wallets.

| Step | Transaction |
|---|---|
| `registerService` — service #1 "USD FX Feed" @ 0.001 OG | [`0x4e15b95f…`](https://chainscan-galileo.0g.ai/tx/0x4e15b95f5b2c91dc1bf9e112ed78c6418f4f954265c43b9d9f7053d415b2f249) |
| `PaymentRouter.pay(1, nonce, payTo)` — the buyer settling its own invoice | [`0xebee2bc6…`](https://chainscan-galileo.0g.ai/tx/0xebee2bc6d95f505445a49caf8051209256abcbbf4e24c1f00194a7e8eef2a815) |
| `recordAttestation` — written by the gateway after serving | [`0xd0a24968…`](https://chainscan-galileo.0g.ai/tx/0xd0a24968f092826fd90e298dc36acb64d193d3b11c6e11dec951b7c49aa063be) |

Resulting state: `servicesCount() == 1`, score `(1, 1)`, one attestation whose
`paymentTxHash` is the payment above.

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
forge test          # 42 tests across 3 suites, all passing
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

This package ships `script/Deploy.s.sol`, which deploys
all three contracts (no constructor arguments) in one transaction batch and
prints the resulting addresses to paste into `.env` and the table above.

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
