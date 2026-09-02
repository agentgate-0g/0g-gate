// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// Exposes SpendGuard's internal tier derivation. `_tierOf` is the rule that
/// decides whether an escrow will speak to a counterparty at all, and it is
/// internal, so the only other way to read it is to watch `debit` decide with
/// it. Both readings are used below: the boundary tests go through `debit`,
/// because that is where the number touches money, and the fuzz goes through
/// this probe, because it needs thousands of scores that would each cost tens
/// of thousands of gas to build honestly.
contract TierProbe is SpendGuard {
    constructor(AgentGateRegistry registry) SpendGuard(registry) {}

    function tierOf(uint64 serviceId) external view returns (uint8) {
        return _tierOf(serviceId);
    }
}

/// NUMERIC BOUNDARIES — the numbers inside the guards, not the guards.
///
/// A mutation run over the suite as it stood found revert identity and revert
/// ORDER pinned well and the arithmetic behind them barely pinned at all. Four
/// mutations left the whole suite green:
///   * deleting the `Underpaid` floor in recordAttestation, so underpaying a
///     service earned it full reputation;
///   * moving `_tierOf`'s trusted threshold from 95% to 50%;
///   * moving `_tierOf`'s minimum-calls gate from 5 to 1;
///   * deleting the `decimals > 36` ceiling in `_minPrice`.
/// Three of the four decide whether money moves or a reputation is earned, and
/// the fourth decides whether a price can be declared at a scale that makes the
/// floor meaningless.
///
/// Every one is pinned here from BOTH sides — the last value the guard refuses
/// and the first it accepts. One side alone is worth much less than half: a
/// test that only checks the refusing side survives any mutation that LOOSENS
/// the number, which is exactly the direction that costs somebody money.
contract BoundariesTest is Test {
    AgentGateRegistry internal reg;
    PaymentRouter internal router;
    SpendGuard internal guard;
    TierProbe internal probe;

    address internal owner = address(0xA11CE);
    address internal payTarget = address(0xCAFE);
    address internal buyer = address(0xB0BB1);

    uint256 internal constant PRICE = 1e15;

    /// This contract is the attestor of every service it registers (so it can
    /// score them without a prank) and the gate of every policy it opens (so
    /// it can call `debit` without one). Neither is the owner or the payee, so
    /// no self-payment rule is in play.
    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        guard = new SpendGuard(reg);
        probe = new TierProbe(reg);
        vm.warp(1_756_500_000);
        vm.deal(buyer, 100 ether);
        vm.deal(address(this), 100 ether);
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

    /// A native option (mandatory — PaymentRouter settles nothing else) plus
    /// the ERC-20 entry actually under test. The native entry is priced well
    /// clear of its own floor so it never decides the outcome.
    function _nativePlusToken(uint256 amount, uint8 decimals)
        internal
        pure
        returns (AgentGateRegistry.PaymentOption[] memory a)
    {
        a = new AgentGateRegistry.PaymentOption[](2);
        a[0] = _nativeAccepts(PRICE)[0];
        a[1] = AgentGateRegistry.PaymentOption({
            asset: address(0xdAC17F958D2ee523a2206206994597C13D831ec7),
            amount: amount,
            decimals: decimals,
            symbol: "TKN",
            name: "Token",
            version: "1"
        });
    }

    function _register() internal returns (uint64 id) {
        vm.prank(owner);
        id = reg.registerService(
            "svc", "d", "https://g.example", _nativeAccepts(PRICE), payTarget, address(this)
        );
    }

    /// Give `serviceId` exactly `total` recorded calls, `successes` of them
    /// successful, through the only path that can produce them: one real
    /// router settlement at the listed price per call, each scored by this
    /// contract as the service's attestor.
    function _seedScore(uint64 serviceId, uint64 total, uint64 successes) internal {
        for (uint64 i = 1; i <= total; i++) {
            vm.prank(buyer);
            router.pay{value: PRICE}(serviceId, i, payTarget);
            reg.recordAttestation(serviceId, i, buyer, bytes32(uint256(i)), i <= successes);
        }
    }

    /// Does `serviceId`'s registry score clear a policy demanding `minTier`?
    ///
    /// Read through `debit`, because the tier is not a display value — it is a
    /// rule standing between an escrow and a counterparty, and this is the
    /// only place it is enforced. `debit`'s revert order (normative, see the
    /// design doc §8) puts UntrustedService immediately before
    /// ServiceNotAllowed, so a service the policy has deliberately NOT
    /// allowlisted separates the two answers exactly: UntrustedService means
    /// the tier was below the minimum, ServiceNotAllowed means it cleared and
    /// the next rule stopped the call. Nothing after that point runs, so the
    /// probe never has to satisfy the price or the payee.
    function _tierClears(uint64 serviceId, uint8 minTier) internal returns (bool) {
        uint64 policyId = guard.openPolicy(address(this), 10 ether, 1 ether, 60_000, 10, minTier);
        try guard.debit(policyId, serviceId, PRICE, payTarget, 1) {
            revert("tier probe: debit must not succeed, the service is not allowlisted");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (sel == SpendGuard.UntrustedService.selector) return false;
            if (sel == SpendGuard.ServiceNotAllowed.selector) return true;
            revert("tier probe: debit reverted for a reason other than the tier");
        }
    }

    // ─── the Underpaid floor: a point costs the LISTED price ────────────────

    /// The mutation that deleted this check left the suite green, and what it
    /// bought was a full reputation point for a payment of one wei: the score
    /// is the only thing a buyer has to go on when picking a service, and the
    /// floor is the entire reason a point costs anything at all.
    function test_recordAttestation_refusesAPaymentOneWeiUnderTheListedPrice() public {
        uint64 id = _register();
        vm.prank(buyer);
        router.pay{value: PRICE - 1}(id, 1, payTarget);

        vm.expectRevert(AgentGateRegistry.Underpaid.selector);
        reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);

        (uint64 total,) = reg.getScore(id);
        assertEq(total, 0, "an underpaid call must leave no trace on the score");
    }

    /// The other side of the same wei. Without this a mutation that tightened
    /// the comparison to `<=` — refusing the exact listed price, which is what
    /// every honest buyer pays — would go unnoticed.
    function test_recordAttestation_acceptsExactlyTheListedPrice() public {
        uint64 id = _register();
        vm.prank(buyer);
        router.pay{value: PRICE}(id, 1, payTarget);

        reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);

        (uint64 total, uint64 success) = reg.getScore(id);
        assertEq(total, 1, "the exact listed price must score");
        assertEq(success, 1);
    }

    // ─── _tierOf: the trusted threshold is 95%, not "high" ──────────────────

    /// 38 of 40 is 95.0% exactly — the first ratio the top tier accepts.
    function test_debit_admitsAServiceAtExactlyNinetyFivePercentSuccess() public {
        uint64 id = _register();
        _seedScore(id, 40, 38);
        assertTrue(_tierClears(id, 2), "38/40 is exactly 95% and must reach the trusted tier");
    }

    /// 37 of 40 is 92.5% — one call short, and the tier the whole rule exists
    /// to gate must not be reached. Weakening the threshold to 50% left every
    /// existing test green while admitting this service and every worse one.
    function test_debit_refusesAServiceOneCallShortOfNinetyFivePercent() public {
        uint64 id = _register();
        _seedScore(id, 40, 37);
        assertFalse(_tierClears(id, 2), "37/40 is under 95% and must not be trusted");
    }

    // ─── _tierOf: no tier at all until 5 calls have been recorded ───────────

    /// Four perfect calls is a 100% success rate over a sample that means
    /// nothing, which is exactly why the gate is there: a fresh sybil can buy
    /// a handful of calls far more cheaply than 25. Moving the gate to 1 left
    /// the suite green and handed this service the reliable tier.
    function test_debit_refusesAServiceWithFourPerfectCalls() public {
        uint64 id = _register();
        _seedScore(id, 4, 4);
        assertFalse(_tierClears(id, 1), "4 calls is below the minimum sample and must not rate");
    }

    function test_debit_admitsAServiceAtTheFifthPerfectCall() public {
        uint64 id = _register();
        _seedScore(id, 5, 5);
        assertTrue(_tierClears(id, 1), "5 perfect calls is the first sample that rates");
    }

    // ─── _tierOf: the reliable threshold is 90% ─────────────────────────────

    /// Same class of hole as the 95% one directly above, one line away in the
    /// same function and equally unpinned: nothing in the suite noticed which
    /// ratio separated tier 1 from tier 0.
    function test_debit_admitsAServiceAtExactlyNinetyPercentSuccess() public {
        uint64 id = _register();
        _seedScore(id, 10, 9);
        assertTrue(_tierClears(id, 1), "9/10 is exactly 90% and must reach the reliable tier");
    }

    function test_debit_refusesAServiceOneCallShortOfNinetyPercent() public {
        uint64 id = _register();
        _seedScore(id, 10, 8);
        assertFalse(_tierClears(id, 1), "8/10 is under 90% and must not rate");
    }

    // ─── _minPrice: the decimals ceiling, and the floor at each scale ───────

    /// 36 decimals is the largest scale the registry will price, and its floor
    /// is 1e30 atomic units — a millionth of a whole unit, the same economic
    /// rule as the native 1e12.
    function test_registerService_acceptsAnAssetAtExactlyThirtySixDecimals() public {
        vm.prank(owner);
        uint64 id = reg.registerService(
            "s", "d", "u", _nativePlusToken(1e30, 36), payTarget, address(this)
        );
        assertEq(reg.getService(id).accepts[1].decimals, 36);
    }

    function test_registerService_rejectsDustOnAThirtySixDecimalAsset() public {
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService(
            "s", "d", "u", _nativePlusToken(1e30 - 1, 36), payTarget, address(this)
        );
    }

    /// 37 decimals, priced at the largest number there is: nothing except the
    /// ceiling itself can refuse this list. With the ceiling deleted the floor
    /// for such an asset simply becomes a bigger number and the registration
    /// succeeds — and for a declared 78 decimals or more, `10 ** decimals`
    /// overflows and the seller gets an arithmetic panic instead of a
    /// contract error, from a public entry point, forever.
    function test_registerService_rejectsAnAssetDeclaringThirtySevenDecimals() public {
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService(
            "s", "d", "u", _nativePlusToken(type(uint256).max, 37), payTarget, address(this)
        );
    }

    /// Hardcoded, on purpose. The fuzz below derives the floor from the public
    /// constant, which is the pin that matters but would still agree with the
    /// contract if BOTH drifted; these five numbers do not move, and they are
    /// the scales real assets are actually issued at.
    function test_minPrice_floorAtTheScalesRealAssetsUse() public {
        _assertFloorIs(0, 1); // clamped: a millionth of a whole unit rounds to 0
        _assertFloorIs(6, 1); // USDC/USDT
        _assertFloorIs(8, 100); // WBTC
        _assertFloorIs(18, 1e12); // native OG, == MIN_PRICE_WEI
        _assertFloorIs(36, 1e30); // the ceiling
    }

    /// `floorAmt` must register and `floorAmt - 1` must not. At the two scales
    /// where the floor clamps to 1, "one under" is 0, which the same guard
    /// refuses for the same reason.
    function _assertFloorIs(uint8 decimals, uint256 floorAmt) internal {
        vm.prank(owner);
        reg.registerService(
            "s", "d", "u", _nativePlusToken(floorAmt, decimals), payTarget, address(this)
        );
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService(
            "s", "d", "u", _nativePlusToken(floorAmt - 1, decimals), payTarget, address(this)
        );
    }

    // ─── fuzz ───────────────────────────────────────────────────────────────

    /// The floor at EVERY legal scale, stated the way the public constant
    /// states it: one millionth of a whole unit. MIN_PRICE_WEI is read out of
    /// the contract rather than written down here, so this is the test that
    /// fails if the constant and the enforced floor are ever decoupled again —
    /// which is what the constant was, before it was wired into `_minPrice`.
    function testFuzz_registerService_priceFloorIsExactAtEveryLegalScale(uint8 decimals)
        public
    {
        uint8 d = uint8(bound(uint256(decimals), 0, 36));
        uint256 perWholeUnit = 1e18 / reg.MIN_PRICE_WEI(); // 1e6
        uint256 floorAmt = (10 ** uint256(d)) / perWholeUnit;
        if (floorAmt == 0) floorAmt = 1;
        _assertFloorIs(d, floorAmt);
    }

    /// No price, however large, buys an asset a scale the registry refuses to
    /// reason about. `amount` is left entirely unconstrained to say so.
    function testFuzz_registerService_rejectsEveryScaleAboveTheCeiling(
        uint8 decimals,
        uint256 amount
    ) public {
        uint8 d = uint8(bound(uint256(decimals), 37, type(uint8).max));
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("s", "d", "u", _nativePlusToken(amount, d), payTarget, address(this));
    }

    /// Anything at or above the listed price scores; anything under it does
    /// not. The fuzz covers the whole span on both sides of the one wei the
    /// boundary tests above pin exactly.
    function testFuzz_recordAttestation_scoresAtOrAboveTheListedPriceOnly(uint256 paidSeed)
        public
    {
        uint64 id = _register();
        uint256 paid = bound(paidSeed, 1, 10 ether);

        vm.prank(buyer);
        router.pay{value: paid}(id, 1, payTarget);

        if (paid < PRICE) {
            vm.expectRevert(AgentGateRegistry.Underpaid.selector);
            reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);
            (uint64 total,) = reg.getScore(id);
            assertEq(total, 0, "an underpayment scored");
        } else {
            reg.recordAttestation(id, 1, buyer, bytes32(uint256(1)), true);
            (uint64 total,) = reg.getScore(id);
            assertEq(total, 1, "a payment at or above the listed price did not score");
        }
    }

    /// Serving one more call successfully can only ever help. Stated as a
    /// property because it is the shape of the rule, not any one threshold:
    /// `_tierOf` is three comparisons whose ratios could be reordered or
    /// mistyped into a function where doing better lowered your tier, and no
    /// single-point test would notice.
    function testFuzz_tierOf_neverFallsWhenSuccessesRise(
        uint64 total,
        uint64 fewer,
        uint64 more
    ) public {
        uint64 t = uint64(bound(uint256(total), 0, type(uint64).max));
        uint64 lo = uint64(bound(uint256(fewer), 0, t));
        uint64 hi = uint64(bound(uint256(more), lo, t));
        assertGe(
            _tierAt(t, hi), _tierAt(t, lo), "more successes at the same total lowered the tier"
        );
    }

    /// `openPolicy` refuses a minTrustTier above MAX_TRUST_TIER because such a
    /// policy would take deposits and refuse every debit forever. That cap is
    /// only correct while the constant really is the ceiling `_tierOf` can
    /// return — a fourth tier would make it a cap on legitimate policies
    /// instead of a funds-trap guard.
    function testFuzz_tierOf_neverExceedsTheAdvertisedMaximum(uint64 total, uint64 success)
        public
    {
        uint64 t = uint64(bound(uint256(total), 0, type(uint64).max));
        uint64 s = uint64(bound(uint256(success), 0, t));
        assertLe(_tierAt(t, s), guard.MAX_TRUST_TIER(), "a tier above MAX_TRUST_TIER");
    }

    /// A score of (total, success) as `_tierOf` would read it. Mocked at the
    /// registry boundary rather than seeded, because seeding one point costs a
    /// settlement and an attestation and these two properties want hundreds of
    /// thousands of scores, including totals no chain will ever hold.
    function _tierAt(uint64 total, uint64 success) internal returns (uint8) {
        vm.mockCall(
            address(reg),
            abi.encodeWithSelector(AgentGateRegistry.getScore.selector),
            abi.encode(total, success)
        );
        uint8 tier = probe.tierOf(1);
        vm.clearMockedCalls();
        return tier;
    }
}
