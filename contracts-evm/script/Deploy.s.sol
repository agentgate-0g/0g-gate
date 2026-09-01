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
contract Deploy is Script {
    function run() external {
        // Order is load-bearing: the registry verifies attestations against
        // the router's settlements, and the guard reads the registry's scores
        // and payout targets. Router -> Registry -> Guard, no cycle.
        vm.startBroadcast();
        PaymentRouter router = new PaymentRouter();
        AgentGateRegistry registry = new AgentGateRegistry(router);
        SpendGuard guard = new SpendGuard(registry);
        vm.stopBroadcast();

        console.log("REGISTRY_CONTRACT_ADDRESS=%s", address(registry));
        console.log("PAYMENT_ROUTER_ADDRESS=%s", address(router));
        console.log("SPEND_GUARD_ADDRESS=%s", address(guard));
    }
}
