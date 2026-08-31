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
        vm.startBroadcast();
        AgentGateRegistry registry = new AgentGateRegistry();
        PaymentRouter router = new PaymentRouter();
        SpendGuard guard = new SpendGuard();
        vm.stopBroadcast();

        console.log("REGISTRY_CONTRACT_ADDRESS=%s", address(registry));
        console.log("PAYMENT_ROUTER_ADDRESS=%s", address(router));
        console.log("SPEND_GUARD_ADDRESS=%s", address(guard));
    }
}
