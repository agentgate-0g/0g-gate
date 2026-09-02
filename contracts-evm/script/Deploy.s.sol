// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// Deploys the full AgentGate contract set and prints the addresses to paste
/// into .env / contracts-evm/README.md.
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ZG_RPC_URL --private-key $DEPLOYER_KEY --broadcast
///
/// 0G MAINNET (chain 16661), with verification. `mainnet` is a named
/// rpc_endpoint and a named etherscan profile in foundry.toml, so both the
/// chain and the verifier are read from a reviewed file rather than from
/// whatever the shell happens to hold, and `runOnChain(uint256)` names the
/// chain the deploy is MEANT for:
///   ZG_EXPLORER_API_KEY=<key> forge script script/Deploy.s.sol:Deploy \
///     --sig "runOnChain(uint256)" 16661 \
///     --rpc-url mainnet --private-key $DEPLOYER_KEY \
///     --priority-gas-price 4000000000 --with-gas-price 6000000000 \
///     --broadcast --verify --verifier etherscan
///
/// If verification is skipped or fails, each contract can be verified on its
/// own afterwards against the same profile — three addresses that nobody can
/// read the source of is not a shippable state for a contract holding money:
///   forge verify-contract --chain 16661 <addr> src/PaymentRouter.sol:PaymentRouter
///   forge verify-contract --chain 16661 <addr> src/AgentGateRegistry.sol:AgentGateRegistry \
///     --constructor-args $(cast abi-encode "constructor(address)" <router>)
///   forge verify-contract --chain 16661 <addr> src/SpendGuard.sol:SpendGuard \
///     --constructor-args $(cast abi-encode "constructor(address)" <registry>)
contract Deploy is Script {
    /// Deploy wherever the RPC points — the original behaviour, unchanged, and
    /// what `forge script` calls when no `--sig` is given.
    ///
    /// Returns the three deployed contracts so the deploy can be exercised as
    /// a unit rather than only by broadcasting it at a live chain — see
    /// test/DeployScript.t.sol. `forge script` ignores the return values.
    function run()
        external
        returns (PaymentRouter router, AgentGateRegistry registry, SpendGuard guard)
    {
        return _deploy(0);
    }

    /// The same deploy, refusing to run unless the connected chain really is
    /// `expectedChainId`. Worth naming for any deploy that costs real money:
    /// the `galileo` rpc_endpoint in foundry.toml is "${ZG_RPC_URL}", so
    /// `--rpc-url galileo` deploys wherever that variable happens to point —
    /// an operator with mainnet exported in their shell deploys to mainnet
    /// while every word on screen says testnet, and these contracts are
    /// immutable and permanent once they land. Naming the chain you MEANT
    /// turns that into a revert before the first transaction is signed.
    ///
    /// It is a parameter rather than an environment variable so that it is
    /// visible in the command that ran, recorded in the broadcast artifact,
    /// and testable without a process-wide side effect.
    ///   forge script script/Deploy.s.sol:Deploy --sig "runOnChain(uint256)" 16661 ...
    function runOnChain(uint256 expectedChainId)
        external
        returns (PaymentRouter router, AgentGateRegistry registry, SpendGuard guard)
    {
        return _deploy(expectedChainId);
    }

    /// @param expectedChainId the chain this deploy is for, or 0 for "any".
    function _deploy(uint256 expectedChainId)
        internal
        returns (PaymentRouter router, AgentGateRegistry registry, SpendGuard guard)
    {
        if (expectedChainId != 0) {
            require(block.chainid == expectedChainId, "Deploy: wrong chain for this deploy");
        }

        // Order is load-bearing: the registry verifies attestations against
        // the router's settlements, and the guard reads the registry's scores
        // and payout targets. Router -> Registry -> Guard, no cycle.
        vm.startBroadcast();
        router = new PaymentRouter();
        registry = new AgentGateRegistry(router);
        guard = new SpendGuard(registry);
        vm.stopBroadcast();

        // Post-deploy wiring check. Both links are immutable constructor
        // arguments, so a wrong one cannot be repaired — it can only be
        // redeployed, and only if somebody notices. Unchecked, a mis-wired set
        // does not look broken: three addresses appear, the script prints
        // SUCCESSFUL, they go into .env, and the failure surfaces later as
        // NoSuchPayment on every attestation (a registry pointed at the wrong
        // router sees none of its settlements) or as a guard that prices every
        // debit off a registry nobody is registered in. Assert it here, where
        // the deploy transcript is still on screen and nothing has been
        // written down.
        require(
            address(registry.ROUTER()) == address(router),
            "Deploy: registry.ROUTER() is not the router just deployed"
        );
        require(
            address(guard.REGISTRY()) == address(registry),
            "Deploy: guard.REGISTRY() is not the registry just deployed"
        );
        // The guard reaches the router only THROUGH the registry — `debit`
        // settles via REGISTRY.ROUTER() — so this is the link that actually
        // moves the money, and it is the composition of the two above rather
        // than a third constructor argument. Checked separately because it is
        // the one a reader of the two lines above still has to infer.
        require(
            address(guard.REGISTRY().ROUTER()) == address(router),
            "Deploy: guard does not settle through the router just deployed"
        );

        console.log("CHAIN_ID=%s", block.chainid);
        console.log("REGISTRY_CONTRACT_ADDRESS=%s", address(registry));
        console.log("PAYMENT_ROUTER_ADDRESS=%s", address(router));
        console.log("SPEND_GUARD_ADDRESS=%s", address(guard));
    }
}
