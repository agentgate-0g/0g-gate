// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";

contract AgentGateRegistryTest is Test {
    AgentGateRegistry internal reg;

    address internal owner = address(0xA11CE);
    address internal attestor = address(0xB0B);
    address internal payTarget = address(0xCAFE);

    function setUp() public {
        reg = new AgentGateRegistry();
        vm.warp(1_756_500_000); // deterministic block.timestamp (seconds)
    }

    function _nativeAccepts(uint256 amount)
        internal
        pure
        returns (AgentGateRegistry.PaymentOption[] memory a)
    {
        a = new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0),
            amount: amount,
            decimals: 18,
            symbol: "OG",
            name: "",
            version: ""
        });
    }

    function _register() internal returns (uint64 id) {
        vm.prank(owner);
        id = reg.registerService(
            "weather", "forecast API", "https://gateway.example",
            _nativeAccepts(1e15), payTarget, attestor
        );
    }

    function test_registerService_assignsOneBasedIdAndStoresRecord() public {
        uint64 id = _register();
        assertEq(id, 1);
        assertEq(reg.servicesCount(), 1);

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.name, "weather");
        assertEq(s.description, "forecast API");
        assertEq(s.gatewayBaseUrl, "https://gateway.example");
        assertEq(s.paymentTarget, payTarget);
        assertEq(s.owner, owner);
        assertEq(s.attestor, attestor);
        assertTrue(s.active);
        assertEq(s.createdAt, 1_756_500_000_000); // MS, not seconds
        assertEq(s.accepts.length, 1);
        assertEq(s.accepts[0].amount, 1e15);
        assertEq(s.accepts[0].asset, address(0));
    }

    function test_registerService_idsIncrementAndCounterTracksLatest() public {
        assertEq(_register(), 1);
        assertEq(_register(), 2);
        assertEq(reg.servicesCount(), 2);
    }

    function test_registerService_revertsOnEmptyName() public {
        vm.expectRevert(AgentGateRegistry.EmptyName.selector);
        vm.prank(owner);
        reg.registerService("", "d", "u", _nativeAccepts(1e15), payTarget, attestor);
    }

    function test_registerService_revertsOnWhitespaceOnlyName() public {
        vm.expectRevert(AgentGateRegistry.EmptyName.selector);
        vm.prank(owner);
        reg.registerService("   ", "d", "u", _nativeAccepts(1e15), payTarget, attestor);
    }

    function test_registerService_revertsOnEmptyAccepts() public {
        AgentGateRegistry.PaymentOption[] memory none =
            new AgentGateRegistry.PaymentOption[](0);
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("n", "d", "u", none, payTarget, attestor);
    }

    function test_registerService_revertsBelowMinPrice() public {
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("n", "d", "u", _nativeAccepts(1e12 - 1), payTarget, attestor);
    }

    function test_registerService_acceptsExactlyMinPrice() public {
        vm.prank(owner);
        uint64 id = reg.registerService(
            "n", "d", "u", _nativeAccepts(1e12), payTarget, attestor
        );
        assertEq(id, 1);
    }

    function test_getService_revertsForUnknownId() public {
        vm.expectRevert(AgentGateRegistry.ServiceNotFound.selector);
        reg.getService(99);
    }

    function test_registerService_emitsServiceRegistered() public {
        vm.expectEmit(true, true, false, false);
        emit AgentGateRegistry.ServiceRegistered(
            1, owner, "weather", _nativeAccepts(1e15), payTarget, attestor
        );
        _register();
    }

    function test_recordAttestation_bumpsScoreAndStoresNewestFirst() public {
        uint64 id = _register();
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(0xAA)), true);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(0xBB)), false);

        (uint64 total, uint64 success) = reg.getScore(id);
        assertEq(total, 2);
        assertEq(success, 1);

        AgentGateRegistry.Attestation[] memory list = reg.getAttestations(id);
        assertEq(list.length, 2);
        assertEq(list[0].paymentTxHash, bytes32(uint256(0xBB))); // newest first
        assertFalse(list[0].success);
        assertEq(list[1].paymentTxHash, bytes32(uint256(0xAA)));
        assertEq(list[0].timestamp, 1_756_500_000_000);
    }

    function test_recordAttestation_ownerMayAlsoAttest() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 1);
    }

    function test_recordAttestation_revertsForStranger() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        reg.recordAttestation(id, bytes32(uint256(1)), true);
    }

    function test_recordAttestation_revertsOnDuplicatePaymentHash() public {
        uint64 id = _register();
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(7)), true);
        vm.expectRevert(AgentGateRegistry.DuplicateAttestation.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(7)), true);
    }

    function test_recordAttestation_samePaymentHashAllowedOnDifferentService() public {
        uint64 a = _register();
        uint64 b = _register();
        vm.prank(attestor);
        reg.recordAttestation(a, bytes32(uint256(7)), true);
        vm.prank(attestor);
        reg.recordAttestation(b, bytes32(uint256(7)), true); // must not revert
        (uint64 totalB,) = reg.getScore(b);
        assertEq(totalB, 1);
    }

    function test_recordAttestation_revertsWhenInactive() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setActive(id, false);
        vm.expectRevert(AgentGateRegistry.ServiceInactive.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
    }

    function test_recordAttestation_revertsForUnknownService() public {
        vm.expectRevert(AgentGateRegistry.ServiceNotFound.selector);
        vm.prank(attestor);
        reg.recordAttestation(42, bytes32(uint256(1)), true);
    }

    function test_getAttestations_capsAtMaxAndKeepsNewest() public {
        uint64 id = _register();
        for (uint256 i = 1; i <= 105; i++) {
            vm.prank(attestor);
            reg.recordAttestation(id, bytes32(i), true);
        }
        AgentGateRegistry.Attestation[] memory list = reg.getAttestations(id);
        assertEq(list.length, 100);
        assertEq(list[0].paymentTxHash, bytes32(uint256(105))); // newest
        assertEq(list[99].paymentTxHash, bytes32(uint256(6)));  // oldest kept

        // Counters keep FULL history even though the list is capped.
        (uint64 total, uint64 success) = reg.getScore(id);
        assertEq(total, 105);
        assertEq(success, 105);
    }

    function test_getScore_isZeroForUnknownService() public view {
        (uint64 total, uint64 success) = reg.getScore(999);
        assertEq(total, 0);
        assertEq(success, 0);
    }

    function test_getAttestations_isEmptyForUnknownService() public view {
        assertEq(reg.getAttestations(999).length, 0);
    }

    function test_setActive_ownerOnly_attestorMayNotToggle() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setActive(id, false);

        vm.prank(owner);
        reg.setActive(id, false);
        assertFalse(reg.getService(id).active);

        vm.prank(owner);
        reg.setActive(id, true);
        assertTrue(reg.getService(id).active);
    }

    function test_setAttestor_ownerOnlyAndRotatesKey() public {
        uint64 id = _register();
        address rotated = address(0xF00D);

        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setAttestor(id, rotated);

        vm.prank(owner);
        reg.setAttestor(id, rotated);
        assertEq(reg.getService(id).attestor, rotated);

        // the rotated key can attest; the old one can no longer
        vm.prank(rotated);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(2)), true);
    }
}
