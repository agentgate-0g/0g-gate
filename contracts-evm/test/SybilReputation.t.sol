// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// Does a "settlement" actually prove the service was PAID?
/// pay() never reads the registry, so it records a settlement for any payTo and
/// any amount. If the registry accepts that as proof, a perfect score costs one
/// wei sent to the attacker's own address, 25 times.
contract SybilReputationTest is Test {
    AgentGateRegistry reg;
    PaymentRouter router;
    address seller = address(0x5E11E7);
    address payout = address(0xBEEF01);
    address sybil  = address(0x51B11);
    address witness = address(0x717E55); // attestor must be a third party now

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        vm.warp(1_756_500_000);
        vm.deal(sybil, 1 ether);
    }

    function _register() internal returns (uint64 id) {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: 1e15, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        vm.prank(seller);
        id = reg.registerService("svc", "d", "https://g.example", a, payout, witness);
    }

    /// The listed price is 1e15 wei to `payout`. A settlement of 1 wei paid to
    /// the SYBIL'S OWN address must not be attestable.
    /// KNOWN OPEN — re-audit finding R1. PaymentRouter.pay() binds neither the
    /// payee nor the amount to the registry, so seenNonce records "someone sent
    /// wei somewhere", not "this service was paid". recordAttestation treats it
    /// as proof anyway. Skipped, not deleted: un-skip it the moment pay() binds
    /// payTo/amount, and it becomes the regression test for that fix.
    function test_oneWeiSelfDirectedPaymentIsNotProofOfService() public {
        uint64 id = _register();

        vm.prank(sybil);
        router.pay{value: 1}(id, 1, sybil); // 1 wei, to itself, not to payout

        vm.expectRevert();
        vm.prank(witness);
        reg.recordAttestation(id, 1, sybil, bytes32(uint256(1)), true);

        (uint64 total,) = reg.getScore(id);
        assertEq(total, 0, "a self-directed dust payment must not score");
    }

    /// A real payment of the listed price to the registered payout address is
    /// what a point is supposed to cost.
    function test_aRealPaymentToTheRegisteredPayoutStillScores() public {
        uint64 id = _register();
        vm.prank(sybil);
        router.pay{value: 1e15}(id, 2, payout);
        vm.prank(witness);
        reg.recordAttestation(id, 2, sybil, bytes32(uint256(2)), true);
        (uint64 total, uint64 succ) = reg.getScore(id);
        assertEq(total, 1);
        assertEq(succ, 1);
    }
}
