// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract AgentGateRegistryTest is Test {
    AgentGateRegistry internal reg;
    PaymentRouter internal router;
    address internal buyer = address(0xB0BB1);

    address internal owner = address(0xA11CE);
    address internal attestor = address(0xB0B);
    address internal payTarget = address(0xCAFE);

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        vm.deal(buyer, 100 ether);
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
        _settle(id, 0xAA);
        _settle(id, 0xBB);
        vm.prank(attestor);
        reg.recordAttestation(id, 0xAA, buyer, bytes32(uint256(0xAA)), true);
        vm.prank(attestor);
        reg.recordAttestation(id, 0xBB, buyer, bytes32(uint256(0xBB)), false);

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

    /// AUDIT #1 — the subject of a score must not be a witness for it.
    function test_recordAttestation_ownerMayNotAttest() public {
        uint64 id = _register();
        _settle(id, 1);
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(owner);
        reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);
    }


    function test_recordAttestation_revertsForStranger() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);
    }

    function test_recordAttestation_revertsOnDuplicatePaymentHash() public {
        uint64 id = _register();
        _settle(id, 7);
        vm.prank(attestor);
        reg.recordAttestation(id, 7, buyer, bytes32(uint256(7)), true);
        vm.expectRevert(AgentGateRegistry.DuplicateAttestation.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 7, buyer, bytes32(uint256(7)), true);
    }

    function test_recordAttestation_samePaymentHashAllowedOnDifferentService() public {
        uint64 a = _register();
        uint64 b = _register();
        _settle(a, 7);
        _settle(b, 7);
        vm.prank(attestor);
        reg.recordAttestation(a, 7, buyer, bytes32(uint256(7)), true);
        vm.prank(attestor);
        reg.recordAttestation(b, 7, buyer, bytes32(uint256(7)), true); // must not revert
        (uint64 totalB,) = reg.getScore(b);
        assertEq(totalB, 1);
    }

    /// AUDIT #2 — `active` gates discovery, not the reputation ledger. Before
    /// the fix an owner front-ran a failure attestation with setActive(false)
    /// and the failure vanished without a trace.
    function test_recordAttestation_succeedsWhileInactive() public {
        uint64 id = _register();
        _settle(id, 9);
        vm.prank(owner);
        reg.setActive(id, false);

        vm.prank(attestor);
        reg.recordAttestation(id, 9, buyer, bytes32(uint256(9)), false);

        (uint64 total, uint64 succ) = reg.getScore(id);
        assertEq(total, 1);
        assertEq(succ, 0);
    }


    function test_recordAttestation_revertsForUnknownService() public {
        vm.expectRevert(AgentGateRegistry.ServiceNotFound.selector);
        vm.prank(attestor);
        reg.recordAttestation(42, 1, buyer, bytes32(uint256(1)), true);
    }

    function test_getAttestations_capsAtMaxAndKeepsNewest() public {
        uint64 id = _register();
        for (uint256 i = 1; i <= 105; i++) {
            _settle(id, i);
            vm.prank(attestor);
            reg.recordAttestation(id, i, buyer, bytes32(uint256(i)), true);
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
        _settle(id, 1);
        _settle(id, 2);
        address rotated = address(0xF00D);

        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setAttestor(id, rotated);

        vm.prank(owner);
        reg.setAttestor(id, rotated);
        assertEq(reg.getService(id).attestor, rotated);

        // the rotated key can attest; the old one can no longer
        vm.prank(rotated);
        reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 2, buyer, bytes32(uint256(2)), true);
    }

    // ─── AUDIT #1 — attestations must be backed by a real router settlement ───

    /// Pay `serviceId` for real, from `buyer`, so an attestation can reference it.
    function _settle(uint64 serviceId, uint256 nonce) internal {
        vm.prank(buyer);
        router.pay{value: 1e15}(serviceId, nonce, payTarget);
    }

    /// Before the fix, `paymentTxHash` was an unconstrained bytes32 — an owner
    /// looped fabricated values to mint a flawless score for gas alone.
    function test_recordAttestation_revertsWithoutAMatchingSettlement() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NoSuchPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 12345, buyer, bytes32(uint256(12345)), true);
    }

    function test_recordAttestation_acceptsARealSettlement() public {
        uint64 id = _register();
        _settle(id, 12345);
        vm.prank(attestor);
        reg.recordAttestation(id, 12345, buyer, bytes32(uint256(12345)), true);
        (uint64 total, uint64 succ) = reg.getScore(id);
        assertEq(total, 1);
        assertEq(succ, 1);
    }

    /// On-chain anti-wash-trading: a seller paying its own service must not score.
    function test_recordAttestation_revertsWhenOwnerPaidItself() public {
        uint64 id = _register();
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        router.pay{value: 1e15}(id, 55, payTarget);

        vm.expectRevert(AgentGateRegistry.SelfPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 55, owner, bytes32(uint256(55)), true);
    }

    function test_recordAttestation_revertsWhenPayoutAddressPaidItself() public {
        uint64 id = _register();
        vm.deal(payTarget, 10 ether);
        vm.prank(payTarget);
        router.pay{value: 1e15}(id, 56, payTarget);

        vm.expectRevert(AgentGateRegistry.SelfPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 56, payTarget, bytes32(uint256(56)), true);
    }

    // ─── AUDIT #7 — the price floor must scale with the option's decimals ────

    function test_registerService_acceptsASanelyPricedSixDecimalAsset() public {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0xdAC17F958D2ee523a2206206994597C13D831ec7),
            amount: 10_000, // 0.01 USDC at 6 decimals
            decimals: 6,
            symbol: "USDC",
            name: "USD Coin",
            version: "2"
        });
        vm.prank(owner);
        uint64 id = reg.registerService("fx", "d", "https://g.example", a, payTarget, attestor);
        assertEq(reg.getService(id).accepts[0].amount, 10_000);
    }

    function test_registerService_stillRejectsDustOnAnEightDecimalAsset() public {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0xdAC17F958D2ee523a2206206994597C13D831ec7),
            amount: 99, // floor for 8 decimals is 100 atomic units
            decimals: 8,
            symbol: "WBTC",
            name: "Wrapped BTC",
            version: "1"
        });
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("fx", "d", "https://g.example", a, payTarget, attestor);
    }
}
