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
        // Rotation is DELAYED so it cannot be used to censor an in-flight
        // attestation — the incumbent stays authoritative until it matures.
        assertEq(reg.effectiveAttestor(id), attestor);
        vm.warp(block.timestamp + (reg.ATTESTOR_ROTATION_DELAY_MS() / 1000) + 1);
        assertEq(reg.effectiveAttestor(id), rotated);

        // once matured the rotated key can attest; the old one can no longer
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

    /// The native option rides along because a price list must now contain one
    /// (PaymentRouter is native-only); the ERC-20 entry is what is under test.
    function _nativePlusToken(uint256 amount, uint8 decimals, string memory symbol)
        internal
        pure
        returns (AgentGateRegistry.PaymentOption[] memory a)
    {
        a = new AgentGateRegistry.PaymentOption[](2);
        a[0] = _nativeAccepts(1e15)[0];
        a[1] = AgentGateRegistry.PaymentOption({
            asset: address(0xdAC17F958D2ee523a2206206994597C13D831ec7),
            amount: amount,
            decimals: decimals,
            symbol: symbol,
            name: "USD Coin",
            version: "2"
        });
    }

    function test_registerService_acceptsASanelyPricedSixDecimalAsset() public {
        // 0.01 USDC at 6 decimals
        AgentGateRegistry.PaymentOption[] memory a = _nativePlusToken(10_000, 6, "USDC");
        vm.prank(owner);
        uint64 id = reg.registerService("fx", "d", "https://g.example", a, payTarget, attestor);
        assertEq(reg.getService(id).accepts[1].amount, 10_000);
    }

    function test_registerService_stillRejectsDustOnAnEightDecimalAsset() public {
        // floor for 8 decimals is 100 atomic units
        AgentGateRegistry.PaymentOption[] memory a = _nativePlusToken(99, 8, "WBTC");
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("fx", "d", "https://g.example", a, payTarget, attestor);
    }

    // ─── AUDIT R2 — the subject must not be able to name itself as witness ───

    function test_registerService_rejectsSelfAsAttestor() public {
        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(1e15), payTarget, owner);
    }

    function test_registerService_rejectsPayoutAddressAsAttestor() public {
        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(1e15), payTarget, payTarget);
    }

    function test_setAttestor_rejectsRotatingToTheOwner() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.setAttestor(id, owner);
    }

    // ─── AUDIT R4 — the attestor must not score its own payment ─────────────

    function test_recordAttestation_revertsWhenTheAttestorPaidItself() public {
        uint64 id = _register();
        vm.deal(attestor, 10 ether);
        vm.prank(attestor);
        router.pay{value: 1e15}(id, 77, payTarget);

        vm.expectRevert(AgentGateRegistry.SelfPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 77, attestor, bytes32(uint256(77)), true);
    }

    // ─── AUDIT R7 — a native option must declare the native scale ───────────

    function test_registerService_rejectsNativeOptionWithWrongDecimals() public {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: 1, decimals: 0, // would collapse the floor to 1 wei
            symbol: "OG", name: "", version: ""
        });
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", a, payTarget, attestor);
    }

    // ─── zero addresses that permanently break a service ────────────────────

    function test_registerService_rejectsZeroPaymentTarget() public {
        vm.expectRevert(AgentGateRegistry.InvalidPaymentTarget.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(1e15), address(0), attestor);
    }

    function test_registerService_rejectsZeroAttestor() public {
        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(1e15), payTarget, address(0));
    }

    // ─── AUDIT R3 — rotation must not revoke the incumbent instantly ────────

    /// The censorship closed on setActive was still open via setAttestor: the
    /// owner front-runs a pending failure attestation with a rotation, the
    /// attestor's tx reverts NotAuthorized, and the failure vanishes. A grace
    /// window alone does not fix it — the owner just rotates twice. Rotation
    /// itself is therefore delayed: the incumbent stays authoritative until it
    /// matures, so an in-flight attestation can never be revoked out from under
    /// it.
    function test_setAttestor_doesNotRevokeTheIncumbentImmediately() public {
        uint64 id = _register();
        _settle(id, 31);

        vm.prank(owner);
        reg.setAttestor(id, address(0xF00D)); // owner tries to censor

        // The incumbent can still record the failure in the same block.
        vm.prank(attestor);
        reg.recordAttestation(id, 31, buyer, bytes32(uint256(31)), false);
        (uint64 total, uint64 succ) = reg.getScore(id);
        assertEq(total, 1);
        assertEq(succ, 0);
    }

    /// Rotating twice must not expire the incumbent early either.
    function test_setAttestor_repeatedRotationCannotRevokeEarly() public {
        uint64 id = _register();
        _settle(id, 32);
        vm.startPrank(owner);
        reg.setAttestor(id, address(0xF00D));
        reg.setAttestor(id, address(0xBEEF));
        vm.stopPrank();

        vm.prank(attestor);
        reg.recordAttestation(id, 32, buyer, bytes32(uint256(32)), false);
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 1);
    }

    /// After the delay the new attestor takes over and the old one is done.
    function test_setAttestor_rotationTakesEffectAfterTheDelay() public {
        uint64 id = _register();
        address rotated = address(0xF00D);
        vm.prank(owner);
        reg.setAttestor(id, rotated);

        vm.warp(block.timestamp + (reg.ATTESTOR_ROTATION_DELAY_MS() / 1000) + 1);
        _settle(id, 33);

        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 33, buyer, bytes32(uint256(33)), true);

        vm.prank(rotated);
        reg.recordAttestation(id, 33, buyer, bytes32(uint256(33)), true);
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 1);
    }

    // ─── PaymentRouter is native-only, so a price list must be payable ──────

    /// An accepts[] with no native option used to register happily and fail
    /// much later, inside recordAttestation, where _nativePrice reverts — after
    /// a buyer had already been quoted a price this rail cannot settle.
    function test_registerService_requiresANativeOption() public {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0xdAC17F958D2ee523a2206206994597C13D831ec7),
            amount: 10_000,
            decimals: 6,
            symbol: "USDC",
            name: "USD Coin",
            version: "2"
        });
        vm.expectRevert(AgentGateRegistry.NoNativeOption.selector);
        vm.prank(owner);
        reg.registerService("fx", "d", "https://g.example", a, payTarget, attestor);
    }

    /// A price list of `n` native options, all at `1e15`.
    function _manyNativeAccepts(uint256 n)
        internal
        pure
        returns (AgentGateRegistry.PaymentOption[] memory a)
    {
        a = new AgentGateRegistry.PaymentOption[](n);
        for (uint256 i = 0; i < n; i++) {
            a[i] = AgentGateRegistry.PaymentOption({
                asset: address(0), amount: 1e15, decimals: 18,
                symbol: "OG", name: "", version: ""
            });
        }
    }

    /// The seller alone decides how long accepts[] is and the gateway pays for
    /// every attestation, which walks it — so it is capped. 16 is
    /// MAX_PAYMENT_OPTIONS, far above any real price list.
    function test_registerService_rejectsMoreThanSixteenPaymentOptions() public {
        vm.expectRevert(AgentGateRegistry.TooManyOptions.selector);
        vm.prank(owner);
        reg.registerService(
            "s", "d", "u", _manyNativeAccepts(17), payTarget, attestor
        );
    }

    function test_registerService_acceptsExactlySixteenPaymentOptions() public {
        vm.prank(owner);
        uint64 id = reg.registerService(
            "s", "d", "u", _manyNativeAccepts(16), payTarget, attestor
        );
        assertEq(reg.getService(id).accepts.length, 16);
    }

    // ─── setActive must be a kill switch on the settlement path, not just a
    //     discovery flag: SpendGuard.debit reads settlementTermsOf ───────────

    function test_settlementTermsOf_returnsTheListedTermsWhileActive() public {
        uint64 id = _register();
        (address target, uint256 price) = reg.settlementTermsOf(id);
        assertEq(target, payTarget);
        assertEq(price, 1e15);
    }

    /// Before the fix `active` was ignored here, so a paused service was still
    /// payable through a SpendGuard escrow policy — the kill switch stopped
    /// discovery and nothing else.
    function test_settlementTermsOf_revertsForAPausedService() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setActive(id, false);

        vm.expectRevert(AgentGateRegistry.ServiceInactive.selector);
        reg.settlementTermsOf(id);

        vm.prank(owner);
        reg.setActive(id, true);
        (address target,) = reg.settlementTermsOf(id);
        assertEq(target, payTarget);
    }

    // ─── the registry was a one-way door: everything but `active` and the
    //     attestor was write-once, so a compromised payout key could never be
    //     rotated and a reprice cost the whole score ───────────────────────

    /// Warp past a money-terms change.
    function _warpPastTermsDelay() internal {
        vm.warp(block.timestamp + (reg.TERMS_CHANGE_DELAY_MS() / 1000) + 1);
    }

    /// Settle `amount` for (serviceId, nonce) to an explicit payee.
    function _settleTo(uint64 serviceId, uint256 nonce, address payee, uint256 amount)
        internal
    {
        vm.prank(buyer);
        router.pay{value: amount}(serviceId, nonce, payee);
    }

    function test_setPaymentTarget_ownerOnly() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setPaymentTarget(id, address(0xF00D));
    }

    function test_setPaymentTarget_rejectsZero() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.InvalidPaymentTarget.selector);
        vm.prank(owner);
        reg.setPaymentTarget(id, address(0));
    }

    /// The witness must not become the payee — the same pairing registerService
    /// and setAttestor refuse, reached through the third door.
    function test_setPaymentTarget_rejectsTheAttestor() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.InvalidPaymentTarget.selector);
        vm.prank(owner);
        reg.setPaymentTarget(id, attestor);
    }

    function test_setPaymentTarget_rejectsAnAttestorRotationAlreadyQueued() public {
        uint64 id = _register();
        address rotated = address(0xF00D);
        vm.prank(owner);
        reg.setAttestor(id, rotated);
        vm.expectRevert(AgentGateRegistry.InvalidPaymentTarget.selector);
        vm.prank(owner);
        reg.setPaymentTarget(id, rotated);
    }

    /// An INSTANT setter would move the terms out from under a buyer who is
    /// already mid-payment: the gateway quoted the old payee and SpendGuard
    /// demands payTo == the live one, so the payment it quoted would be
    /// refused. The live terms therefore do not move until the delay elapses.
    function test_setPaymentTarget_doesNotMoveTheLiveTermsImmediately() public {
        uint64 id = _register();
        address rotated = address(0xF00D);
        vm.prank(owner);
        reg.setPaymentTarget(id, rotated);

        (address target,) = reg.settlementTermsOf(id);
        assertEq(target, payTarget);
        assertEq(reg.paymentTargetOf(id), payTarget);
        assertEq(reg.getService(id).paymentTarget, payTarget);

        _warpPastTermsDelay();
        (target,) = reg.settlementTermsOf(id);
        assertEq(target, rotated);
        assertEq(reg.paymentTargetOf(id), rotated);

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.paymentTarget, rotated);
        assertEq(s.pendingPaymentTarget, address(0));
        assertEq(s.paymentTargetEffectiveAt, 0);
        assertEq(s.previousPaymentTarget, payTarget);
    }

    /// Rotating twice must not retire the incumbent early, exactly as for the
    /// attestor: the second call folds the first in, it does not stack.
    function test_setPaymentTarget_repeatedRotationCannotSkipTheDelay() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xF00D));
        _warpPastTermsDelay();

        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xBEEF));
        (address target,) = reg.settlementTermsOf(id);
        assertEq(target, address(0xF00D)); // the matured one, not the new one

        _warpPastTermsDelay();
        (target,) = reg.settlementTermsOf(id);
        assertEq(target, address(0xBEEF));
    }

    /// A payment already made to the old payee must still score. Without the
    /// displaced-target lookup the router query misses, recordAttestation
    /// reverts NoSuchPayment, and the seller silently loses the point for a
    /// call it really served.
    function test_recordAttestation_stillScoresAPaymentToTheDisplacedTarget() public {
        uint64 id = _register();
        _settle(id, 41); // buyer paid the ORIGINAL payout address

        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xF00D));
        _warpPastTermsDelay();
        (address target,) = reg.settlementTermsOf(id);
        assertEq(target, address(0xF00D)); // the rotation really is live

        vm.prank(attestor);
        reg.recordAttestation(id, 41, buyer, bytes32(uint256(41)), true);
        (uint64 total, uint64 succ) = reg.getScore(id);
        assertEq(total, 1);
        assertEq(succ, 1);
    }

    /// The grace reaches back exactly one rotation, not to every payee the
    /// service has ever had.
    function test_recordAttestation_rejectsAPaymentToATargetTwoRotationsBack() public {
        uint64 id = _register();
        _settle(id, 43); // paid the original payout address

        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xF00D));
        _warpPastTermsDelay();
        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xBEEF));
        _warpPastTermsDelay();

        vm.expectRevert(AgentGateRegistry.NoSuchPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 43, buyer, bytes32(uint256(43)), true);
    }

    function test_setAccepts_ownerOnly() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setAccepts(id, _nativeAccepts(5e15));
    }

    function test_setAccepts_requiresANativeOption() public {
        uint64 id = _register();
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = _nativePlusToken(10_000, 6, "USDC")[1];
        vm.expectRevert(AgentGateRegistry.NoNativeOption.selector);
        vm.prank(owner);
        reg.setAccepts(id, a);
    }

    function test_setAccepts_rejectsMoreThanSixteenPaymentOptions() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.TooManyOptions.selector);
        vm.prank(owner);
        reg.setAccepts(id, _manyNativeAccepts(17));
    }

    function test_setAccepts_rejectsAPriceBelowTheFloor() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(1e12 - 1));
    }

    /// The score is keyed on serviceId, so before this the only way to reprice
    /// was to re-register and abandon it. The new price is delayed for the same
    /// reason the payout rotation is.
    function test_setAccepts_doesNotMoveTheLivePriceImmediately() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(5e15));

        (, uint256 price) = reg.settlementTermsOf(id);
        assertEq(price, 1e15);
        assertEq(reg.getService(id).accepts[0].amount, 1e15);

        _warpPastTermsDelay();
        (, price) = reg.settlementTermsOf(id);
        assertEq(price, 5e15);

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.accepts.length, 1);
        assertEq(s.accepts[0].amount, 5e15);
        assertEq(s.acceptsEffectiveAt, 0);
        assertEq(s.previousNativePrice, 1e15);
        // Repricing keeps the id, so it keeps the score — the whole point.
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 0);
    }

    function test_setAccepts_repeatedRepriceCannotSkipTheDelay() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(5e15));
        _warpPastTermsDelay();

        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(9e15));
        (, uint256 price) = reg.settlementTermsOf(id);
        assertEq(price, 5e15); // the matured one, not the new one

        _warpPastTermsDelay();
        (, price) = reg.settlementTermsOf(id);
        assertEq(price, 9e15);
    }

    /// A buyer who paid the price quoted on its invoice must still score after
    /// the seller raises it, or the seller loses the point for a served call.
    function test_recordAttestation_stillScoresAPaymentAtTheDisplacedPrice() public {
        uint64 id = _register();
        _settle(id, 44); // paid 1e15, the price listed at the time

        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(5e15));
        _warpPastTermsDelay();
        (, uint256 price) = reg.settlementTermsOf(id);
        assertEq(price, 5e15);

        vm.prank(attestor);
        reg.recordAttestation(id, 44, buyer, bytes32(uint256(44)), true);
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 1);
    }

    /// The grace widens the amount check to the displaced price, not below it.
    function test_recordAttestation_stillRejectsDustAfterAReprice() public {
        uint64 id = _register();
        _settleTo(id, 45, payTarget, 1e12); // under both the old and new price

        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(5e15));
        _warpPastTermsDelay();

        vm.expectRevert(AgentGateRegistry.Underpaid.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 45, buyer, bytes32(uint256(45)), true);
    }

    function test_setGatewayBaseUrl_ownerOnlyAndTakesEffectImmediately() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setGatewayBaseUrl(id, "https://impostor.example");

        vm.prank(owner);
        reg.setGatewayBaseUrl(id, "https://gateway2.example");
        assertEq(reg.getService(id).gatewayBaseUrl, "https://gateway2.example");
    }

    // ─── ownership is two-step so a typo cannot orphan a service ────────────

    function test_transferOwnership_ownerOnly() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.transferOwnership(id, address(0x0FFE1));
    }

    function test_transferOwnership_movesNothingUntilTheOfferIsAccepted() public {
        uint64 id = _register();
        address heir = address(0x0FFE1);
        vm.prank(owner);
        reg.transferOwnership(id, heir);

        assertEq(reg.getService(id).owner, owner);
        assertEq(reg.getService(id).pendingOwner, heir);

        // nobody else may take it
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        reg.acceptOwnership(id);

        vm.prank(heir);
        reg.acceptOwnership(id);
        assertEq(reg.getService(id).owner, heir);
        assertEq(reg.getService(id).pendingOwner, address(0));

        // and every owner power moves with it, all at once
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(owner);
        reg.setActive(id, false);
        vm.prank(heir);
        reg.setActive(id, false);
        assertFalse(reg.getService(id).active);
    }

    function test_transferOwnership_zeroWithdrawsAnUnacceptedOffer() public {
        uint64 id = _register();
        address heir = address(0x0FFE1);
        vm.startPrank(owner);
        reg.transferOwnership(id, heir);
        reg.transferOwnership(id, address(0));
        vm.stopPrank();

        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(heir);
        reg.acceptOwnership(id);
        assertEq(reg.getService(id).owner, owner);
    }

    /// Ownership is the fourth door into "the subject is its own witness".
    function test_acceptOwnership_rejectsTheAttestorTakingOwnership() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.transferOwnership(id, attestor);

        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(attestor);
        reg.acceptOwnership(id);
    }

    function test_acceptOwnership_rejectsAnAttestorRotationAlreadyQueued() public {
        uint64 id = _register();
        address heir = address(0x0FFE1);
        vm.startPrank(owner);
        reg.transferOwnership(id, heir);
        reg.setAttestor(id, heir);
        vm.stopPrank();

        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(heir);
        reg.acceptOwnership(id);
    }

    // ─── the record a reader gets must be the terms that are live NOW ───────

    function test_getService_showsAnAttestorRotationThatHasMatured() public {
        uint64 id = _register();
        address rotated = address(0xF00D);
        vm.prank(owner);
        reg.setAttestor(id, rotated);
        vm.warp(block.timestamp + (reg.ATTESTOR_ROTATION_DELAY_MS() / 1000) + 1);

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.attestor, reg.effectiveAttestor(id));
        assertEq(s.attestor, rotated);
        assertEq(s.pendingAttestor, address(0));
        assertEq(s.attestorEffectiveAt, 0);
    }

    // ─── an observer must be able to recompute the settlement key ───────────

    function test_recordAttestation_emitsThePartsOfTheSettlementKey() public {
        uint64 id = _register();
        _settle(id, 61);
        vm.expectEmit(true, true, true, true);
        emit AgentGateRegistry.AttestationRecorded(
            id, bytes32(uint256(61)), buyer, 61, true, 1, 1
        );
        vm.prank(attestor);
        reg.recordAttestation(id, 61, buyer, bytes32(uint256(61)), true);
    }

    // ─── the public floor constant must state the rule it is named for ──────

    function test_minPriceWei_isExactlyTheEnforcedNativeFloor() public {
        // Read once: an expectRevert armed before this call would swallow it.
        uint256 floor = reg.MIN_PRICE_WEI();
        assertEq(floor, 1e12);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(floor), payTarget, attestor);
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativeAccepts(floor - 1), payTarget, attestor);
    }

    // ─── the witness must not be the payee, through any of the four doors ───

    /// A payout rotation the owner has already queued counts: allowed, the
    /// collision simply arrives when it matures.
    function test_setAttestor_rejectsAPayoutRotationAlreadyQueued() public {
        uint64 id = _register();
        address rotated = address(0xF00D);
        vm.prank(owner);
        reg.setPaymentTarget(id, rotated);

        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.setAttestor(id, rotated);
    }

    /// So does the payout target a rotation displaced: recordAttestation still
    /// honours settlements paid to it, so an attestor sitting on that address
    /// could pay itself from a fresh key and sign off on it — the free
    /// two-call wash loop `attestor != paymentTarget` exists to prevent.
    function test_setAttestor_rejectsTheDisplacedPayoutTarget() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xF00D));
        _warpPastTermsDelay();
        // A second rotation folds the first into storage, so payTarget is now
        // the DISPLACED target rather than the stored current one.
        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xBEEF));

        vm.expectRevert(AgentGateRegistry.InvalidAttestor.selector);
        vm.prank(owner);
        reg.setAttestor(id, payTarget); // still an attestable payee
    }

    /// The wash-trade guard has to follow the grace: a settlement to the
    /// displaced payout address is accepted, so that address paying ITSELF
    /// must be refused there too, exactly as the current one is.
    function test_recordAttestation_revertsWhenTheDisplacedPayoutPaidItself() public {
        uint64 id = _register();
        vm.deal(payTarget, 10 ether);
        vm.prank(payTarget);
        router.pay{value: 1e15}(id, 57, payTarget);

        vm.prank(owner);
        reg.setPaymentTarget(id, address(0xF00D));
        _warpPastTermsDelay();

        vm.expectRevert(AgentGateRegistry.SelfPayment.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, 57, payTarget, bytes32(uint256(57)), true);
    }

    /// A reprice that changes the LENGTH of the list exercises the storage
    /// fold: the queued list replaces the live one wholesale, strings and all,
    /// and shrinking it again must not leave the dropped entries behind.
    function test_setAccepts_replacesAListOfADifferentLength() public {
        uint64 id = _register();
        AgentGateRegistry.PaymentOption[] memory three =
            new AgentGateRegistry.PaymentOption[](3);
        three[0] = _nativeAccepts(2e15)[0];
        three[1] = _nativePlusToken(10_000, 6, "USDC")[1];
        three[2] = _nativePlusToken(20_000, 6, "USDT")[1];

        vm.prank(owner);
        reg.setAccepts(id, three);
        _warpPastTermsDelay();

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.accepts.length, 3);
        assertEq(s.accepts[0].amount, 2e15);
        assertEq(s.accepts[2].symbol, "USDT");
        (, uint256 price) = reg.settlementTermsOf(id);
        assertEq(price, 2e15);

        // Now shrink it back. The second call folds the three-entry list into
        // storage first, so this deletes it and pushes one.
        vm.prank(owner);
        reg.setAccepts(id, _nativeAccepts(3e15));
        _warpPastTermsDelay();

        s = reg.getService(id);
        assertEq(s.accepts.length, 1);
        assertEq(s.accepts[0].amount, 3e15);
        assertEq(s.previousNativePrice, 2e15);
        (, price) = reg.settlementTermsOf(id);
        assertEq(price, 3e15);
    }
}
