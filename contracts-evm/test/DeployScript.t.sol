// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// The deploy script is the only thing that ever builds the production set,
/// and until now it was the only thing in this package with no test at all —
/// its output was three addresses nobody checked composed. Every link between
/// the three is an immutable constructor argument: a wrong one cannot be
/// repaired, only redeployed, and on a chain where these are permanent that is
/// the difference between noticing in a test and noticing in production.
contract DeployScriptTest is Test {
    Deploy internal script;

    address internal seller = address(0x5E11E7);
    address internal payout = address(0xBEEF01);
    address internal witness = address(0x717E55);
    address internal buyer = address(0xB0BB1);

    function setUp() public {
        script = new Deploy();
        vm.warp(1_756_500_000);
        vm.deal(buyer, 10 ether);
    }

    function test_run_wiresTheThreeContractsToEachOther() public {
        (PaymentRouter router, AgentGateRegistry registry, SpendGuard guard) = script.run();

        assertEq(address(registry.ROUTER()), address(router), "registry -> router");
        assertEq(address(guard.REGISTRY()), address(registry), "guard -> registry");
        assertEq(
            address(guard.REGISTRY().ROUTER()), address(router), "guard -> router, via registry"
        );
    }

    /// Naming the chain must stop a deploy that reached a different one. The
    /// hazard is not hypothetical: `galileo` in foundry.toml is "${ZG_RPC_URL}",
    /// so `--rpc-url galileo` deploys wherever that variable points, and these
    /// contracts are immutable once they land. Tests run on chain 31337, so
    /// naming 16661 must refuse — and it must refuse BEFORE deploying anything,
    /// which is why the check sits above the broadcast rather than beside the
    /// wiring assertions under it.
    function test_run_refusesAChainThatIsNotTheOneNamed() public {
        vm.expectRevert(bytes("Deploy: wrong chain for this deploy"));
        script.runOnChain(16661);
    }

    function test_run_deploysWhenTheNamedChainIsTheConnectedOne() public {
        (PaymentRouter router, AgentGateRegistry registry,) = script.runOnChain(block.chainid);
        assertEq(address(registry.ROUTER()), address(router));
    }

    /// The wiring assertions say the addresses point at each other; this says
    /// the set the script produced actually transacts. A registry pointed at
    /// some OTHER router answers NoSuchPayment for every settlement, which is
    /// the failure mode the assertions exist to catch before it reaches a
    /// seller who served a call and was told it never happened.
    function test_run_producesASetThatSettlesAndScoresEndToEnd() public {
        (PaymentRouter router, AgentGateRegistry registry, ) = script.run();

        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: 1e15, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        vm.prank(seller);
        uint64 id = registry.registerService("svc", "d", "https://g.example", a, payout, witness);

        vm.prank(buyer);
        router.pay{value: 1e15}(id, 1, payout);
        vm.prank(witness);
        registry.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);

        (uint64 total, uint64 success) = registry.getScore(id);
        assertEq(total, 1, "the deployed registry did not see the deployed router's settlement");
        assertEq(success, 1);
    }
}
