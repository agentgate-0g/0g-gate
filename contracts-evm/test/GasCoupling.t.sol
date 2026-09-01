// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// Does debit's cost depend on the TARGET SERVICE's accepts[] length?
/// debit reads the payout target through getService(), which returns the whole
/// Service struct — every string and every payment option — so a service with
/// a fat price list could make its own debits unaffordable.
contract GasCouplingTest is Test {
    AgentGateRegistry reg;
    PaymentRouter router;
    SpendGuard guard;
    address owner = address(0xA11CE);
    address gate = address(0x6A7E);
    address payTo = address(0xCAFE);
    address buyer = address(0xB1D);

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        guard = new SpendGuard(reg);
        vm.warp(1_756_500_000);
        vm.deal(owner, 1000 ether);
        vm.deal(buyer, 1000 ether);
    }

    function _register(uint256 options) internal returns (uint64 id) {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](options);
        for (uint256 i = 0; i < options; i++) {
            a[i] = AgentGateRegistry.PaymentOption({
                asset: address(0), amount: 1e15, decimals: 18,
                symbol: "OGOGOGOGOGOGOGOGOGOGOGOGOGOGOGOG",
                name: "a-long-eip712-domain-name-field-here",
                version: "1"
            });
        }
        vm.prank(owner);
        id = reg.registerService("svc", "d", "https://g.example", a, payTo, address(this));
        for (uint256 i = 1; i <= 25; i++) {
            vm.prank(buyer);
            router.pay{value: 1e15}(id, i, payTo);
            reg.recordAttestation(id, i, buyer, bytes32(uint256(i)), true);
        }
    }

    function _debitGas(uint64 svc) internal returns (uint256) {
        vm.prank(owner);
        uint64 pid = guard.openPolicy(gate, 10 ether, 1 ether, 60_000, 100, 2, false);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(pid);
        vm.prank(gate);
        uint256 before = gasleft();
        guard.debit(pid, svc, 1e15, payTo, uint256(svc));
        return before - gasleft();
    }

    function test_debitGasDoesNotScaleWithTargetServicePriceListLength() public {
        uint64 lean = _register(1);
        uint64 fat = _register(200);
        uint256 gLean = _debitGas(lean);
        uint256 gFat = _debitGas(fat);
        emit log_named_uint("debit gas, 1 payment option  ", gLean);
        emit log_named_uint("debit gas, 200 payment options", gFat);
        emit log_named_uint("overhead per extra option    ", (gFat - gLean) / 199);
        // A payout-target lookup must not cost more because the seller listed
        // more prices. Allow 25% slack for unrelated state differences.
        assertLt(gFat, (gLean * 125) / 100, "debit cost scales with accepts[] length");
    }
}
