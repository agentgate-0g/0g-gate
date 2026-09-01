// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGuard} from "../src/SpendGuard.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract SpendGuardTest is Test {
    SpendGuard internal guard;
    AgentGateRegistry internal reg;
    PaymentRouter internal router;

    address internal owner = address(0xA11CE);
    address internal gate = address(0x6A7E);
    address internal payTo = address(0xCAFE);

    uint256 internal constant BUDGET = 10 ether;
    uint256 internal constant PER_CALL = 1 ether;
    uint64 internal constant WINDOW_MS = 60_000;
    uint32 internal constant MAX_CALLS = 3;
    uint8 internal constant MIN_TIER = 2;

    uint64 internal SVC_TRUSTED;
    uint64 internal SVC_NEW;
    address internal svcBuyer = address(0xB1D);

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        guard = new SpendGuard(reg);
        vm.warp(1_756_500_000);
        vm.deal(owner, 100 ether);
        vm.deal(svcBuyer, 100 ether);

        SVC_TRUSTED = _registerService();
        SVC_NEW = _registerService();
        // Every price the debit tests settle at needs a service listing it.
        _seedSvc(1 ether); _seedSvc(2 ether); _seedSvc(0.3 ether);
        _seedSvc(0.5 ether); _seedSvc(0.05 ether); _seedSvc(0.1 ether);
        _seedSvc(1e15);
        // 25 settled successes puts SVC_TRUSTED in the top tier; SVC_NEW is
        // left unattested so it sits at tier 0.
        for (uint256 i = 1; i <= 25; i++) {
            vm.prank(svcBuyer);
            router.pay{value: 1e15}(SVC_TRUSTED, i, payTo);
            vm.prank(address(this));
            reg.recordAttestation(SVC_TRUSTED, i, svcBuyer, bytes32(uint256(i)), true);
        }
    }

    /// A trusted service listing exactly `price`, memoised so the 25-settlement
    /// seeding runs once per distinct price. debit now requires the amount to
    /// equal the service's listed price, so a test that debits X needs a
    /// service that charges X.
    mapping(uint256 => uint64) internal _svcByPrice;

    /// Lookup only — seeding happens in setUp, because registering pranks as
    /// the owner and these are called inside a `vm.prank(gate)` argument list.
    function _svc(uint256 price) internal view returns (uint64) {
        return _svcByPrice[price];
    }

    function _seedSvc(uint256 price) internal returns (uint64 id) {
        id = _svcByPrice[price];
        if (id != 0) return id;
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: price, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        vm.prank(owner);
        id = reg.registerService("svc", "d", "https://g.example", a, payTo, address(this));
        for (uint256 i = 1; i <= 25; i++) {
            vm.prank(svcBuyer);
            router.pay{value: price}(id, i, payTo);
            reg.recordAttestation(id, i, svcBuyer, bytes32(uint256(i)), true);
        }
        _svcByPrice[price] = id;
    }

    /// paymentTarget is `payTo`, attestor is this test, so debits can settle.
    function _registerService() internal returns (uint64 id) {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: 1e15, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        vm.prank(owner);
        id = reg.registerService("svc", "d", "https://g.example", a, payTo, address(this));
    }

    function _open() internal returns (uint64 id) {
        vm.prank(owner);
        id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER, false);
    }

    function _openFunded(uint256 amount) internal returns (uint64 id) {
        id = _open();
        vm.prank(owner);
        guard.deposit{value: amount}(id);
    }

    function test_openPolicy_storesConfigAndAssignsOneBasedId() public {
        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.PolicyOpened(1, owner, gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER);
        uint64 id = _open();
        assertEq(id, 1);
        assertEq(guard.policiesCount(), 1);

        SpendGuard.Policy memory p = guard.getPolicy(id);
        assertEq(p.owner, owner);
        assertEq(p.gate, gate);
        assertEq(p.budget, BUDGET);
        assertEq(p.spent, 0);
        assertEq(p.balance, 0);
        assertEq(p.perCallCap, PER_CALL);
        assertEq(p.windowMs, WINDOW_MS);
        assertEq(p.maxCallsInWindow, MAX_CALLS);
        assertEq(p.minTrustTier, MIN_TIER);
        assertFalse(p.paused);
        assertEq(p.createdAt, 1_756_500_000_000);
    }

    function test_openPolicy_revertsOnInvalidConfig() public {
        vm.startPrank(owner);
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, BUDGET, 0, WINDOW_MS, MAX_CALLS, MIN_TIER, false); // zero cap
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, 0, MIN_TIER, false); // zero rate
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 0, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER, false); // zero budget
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 1 ether, 2 ether, WINDOW_MS, MAX_CALLS, MIN_TIER, false); // cap > budget
        vm.stopPrank();
    }

    function test_deposit_creditsEscrowAndAnyoneMayFund() public {
        uint64 id = _open();
        address stranger = address(0xD00D);
        vm.deal(stranger, 5 ether);

        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.Deposited(id, 2 ether, 2 ether);
        vm.prank(stranger);
        guard.deposit{value: 2 ether}(id);
        assertEq(guard.getRemaining(id), 2 ether);
    }

    function test_deposit_revertsOnZeroAndUnknownPolicy() public {
        uint64 id = _open();
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(owner);
        guard.deposit{value: 0}(id);

        vm.expectRevert(SpendGuard.PolicyNotFound.selector);
        vm.prank(owner);
        guard.deposit{value: 1 ether}(99);
    }

    function test_debit_movesEscrowAndUpdatesCounters() public {
        uint64 id = _openFunded(5 ether);
        uint256 ref = 7001;
        // setUp seeded payTo via 25 router payments, so measure the delta.
        uint256 payToBefore = payTo.balance;

        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.DebitApproved(id, _svc(1 ether), 1 ether, payTo, keccak256(abi.encode(_svc(1 ether), ref)), 4 ether);
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, ref);

        assertEq(payTo.balance - payToBefore, 1 ether);
        SpendGuard.Policy memory p = guard.getPolicy(id);
        assertEq(p.balance, 4 ether);
        assertEq(p.spent, 1 ether);
    }

    function test_debit_revertOrderIsNormative() public {
        uint64 id = _openFunded(5 ether);
        uint256 ref = 7002;

        // PolicyNotFound before NotAuthorized (stranger on a missing policy)
        vm.expectRevert(SpendGuard.PolicyNotFound.selector);
        vm.prank(address(0xDEAD));
        guard.debit(99, _svc(1 ether), 1 ether, payTo, ref);

        // NotAuthorized before Paused: pause first, so the next call
        // violates BOTH rules (wrong caller on an already-paused policy)
        // and NotAuthorized must still win.
        vm.prank(owner);
        guard.pause(id, true);
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        guard.debit(id, _svc(1 ether), 1 ether, payTo, ref);

        // Paused before ZeroAmount: still paused, correct caller, zero
        // amount — both rules violated, Paused must still win.
        vm.expectRevert(SpendGuard.Paused.selector);
        vm.prank(gate);
        guard.debit(id, _svc(0), 0, payTo, ref);
        vm.prank(owner);
        guard.pause(id, false);

        // ZeroAmount fires here too, but this pair is not pinned: openPolicy
        // requires perCallCap > 0, so a zero amount can never simultaneously
        // exceed it. This only confirms ZeroAmount still fires in position.
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(gate);
        guard.debit(id, _svc(0), 0, payTo, ref);

        // PerCallExceeded before UntrustedService (over cap AND untrusted —
        // both rules violated, PerCallExceeded must still win).
        vm.expectRevert(SpendGuard.PerCallExceeded.selector);
        vm.prank(gate);
        guard.debit(id, _svc(2 ether), 2 ether, payTo, ref);

        // Burn `ref` legitimately so the next case can combine an
        // already-seen ref with an untrusted caller.
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, ref);

        // UntrustedService before DuplicateRef: ref is already burned AND
        // the caller is untrusted — both rules violated, UntrustedService
        // must still win.
        vm.expectRevert(SpendGuard.UntrustedService.selector);
        vm.prank(gate);
        guard.debit(id, SVC_NEW, 1 ether, payTo, ref);

        // DuplicateRef before OverBudget: a second, thinly-funded policy so
        // an in-cap amount can exceed what's left of the escrow. Burn a ref,
        // then reuse it while asking for more than the balance — both rules
        // violated, DuplicateRef must still win. The ref derives from
        // (serviceId, nonce) now, so the replay has to name the SAME service:
        // the same nonce on a different service is a different call and must
        // not collide.
        vm.prank(owner);
        uint64 id2 = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER, false);
        vm.prank(owner);
        guard.deposit{value: 0.5 ether}(id2);
        uint256 ref2 = 7003;
        vm.prank(gate);
        guard.debit(id2, _svc(0.3 ether), 0.3 ether, payTo, ref2); // balance -> 0.2 ether
        // Same service, same nonce, and now asking for more than the balance.
        vm.expectRevert(SpendGuard.DuplicateRef.selector);
        vm.prank(gate);
        guard.debit(id2, _svc(0.3 ether), 0.3 ether, payTo, ref2);

        // OverBudget before RateExceeded: fill id2's rate window to its cap
        // with two more small, freshly-refed debits, then request an
        // in-cap amount that exceeds what's left of the escrow — both
        // rules violated, OverBudget must still win. This is the one pair
        // the suite never previously exercised at all.
        vm.prank(gate);
        guard.debit(id2, _svc(0.05 ether), 0.05 ether, payTo, 3); // balance -> 0.15
        vm.prank(gate);
        guard.debit(id2, _svc(0.05 ether), 0.05 ether, payTo, 4); // balance -> 0.10, window full (3/3)
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id2, _svc(1 ether), 1 ether, payTo, 5);
    }

    function test_debit_revertsOverEscrowBalance() public {
        uint64 id = _openFunded(0.5 ether);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, 1);
    }

    function test_debit_revertsOverCumulativeBudget() public {
        // budget 2 ether, cap 1 ether, escrow 5 ether: the 3rd call breaches budget
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, 2 ether, 1 ether, WINDOW_MS, 10, 0, false);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, 1);
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, 2);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, 3);
    }

    function test_debit_rateWindowBlocksThenReopens() public {
        uint64 id = _openFunded(10 ether);
        for (uint256 i = 1; i <= MAX_CALLS; i++) {
            vm.prank(gate);
            guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, i);
        }
        vm.expectRevert(SpendGuard.RateExceeded.selector);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 99);

        // roll past the window (windowMs is MS; block.timestamp is SECONDS)
        vm.warp(block.timestamp + (WINDOW_MS / 1000) + 1);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 100);
    }

    /// Pins the partial-prune ("shift-down") branch of the rate-window
    /// rewrite: calls at t0, t0+30s and t0+45s all sit inside the 60s
    /// window; warping to t0+61s ages out only the first one, so the prune
    /// keeps 2 of 3 entries (times.length=3, keptLen=2) and the settle step
    /// must shift those survivors down before appending — the branch
    /// `test_debit_rateWindowBlocksThenReopens` never reaches, since that
    /// test's warp clears the window completely. Exactly one new call fits
    /// in the freed slot; the very next one must hit the maxCallsInWindow
    /// boundary again.
    function test_debit_rateWindowPartialPruneAdmitsOneSlotThenBlocks() public {
        uint64 id = _openFunded(10 ether);
        uint256 t0 = block.timestamp;

        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 1); // t0

        vm.warp(t0 + 30);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 2); // t0+30s

        vm.warp(t0 + 45);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 3); // t0+45s

        // t0 is now 61s old (>= the 60s window) and prunes; the other two
        // (31s and 16s old) survive and shift down. One slot is free.
        vm.warp(t0 + 61);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 4);

        // The window (2 survivors + this new entry) is immediately full
        // again, so a second call at the same timestamp must revert.
        vm.expectRevert(SpendGuard.RateExceeded.selector);
        vm.prank(gate);
        guard.debit(id, _svc(0.1 ether), 0.1 ether, payTo, 5);
    }

    function test_withdraw_ownerOnlyAndWorksWhilePaused() public {
        uint64 id = _openFunded(3 ether);
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(gate);
        guard.withdraw(id, 1 ether);

        vm.prank(owner);
        guard.pause(id, true); // withdraw is the recovery path after the kill-switch
        uint256 before = owner.balance;

        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.Withdrawn(id, 1 ether, 2 ether);
        vm.prank(owner);
        guard.withdraw(id, 1 ether);
        assertEq(owner.balance, before + 1 ether);
        assertEq(guard.getRemaining(id), 2 ether);
    }

    function test_withdraw_revertsOverBalanceAndOnZero() public {
        uint64 id = _openFunded(1 ether);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(owner);
        guard.withdraw(id, 2 ether);
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(owner);
        guard.withdraw(id, 0);
    }

    function test_pause_ownerOnly() public {
        uint64 id = _open();
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(gate);
        guard.pause(id, true);

        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.PolicyPaused(id, true);
        vm.prank(owner);
        guard.pause(id, true);
        assertTrue(guard.getPolicy(id).paused);
    }

    function test_getRemaining_isZeroForUnknownPolicy() public view {
        assertEq(guard.getRemaining(999), 0);
    }

    // ─────────── AUDIT #5 — escrow must never be sent to address(0) ───────────

    /// A CALL to address(0) with value returns success, so without an explicit
    /// guard `debit` burns the escrow, consumes the paymentRef and emits
    /// DebitApproved — the payment reads as settled while nobody was paid.
    /// PaymentRouter.pay already refuses this exact input.
    function test_debit_revertsOnZeroPayee() public {
        uint64 id = _openFunded(5 ether);
        vm.expectRevert(SpendGuard.ZeroPayTo.selector);
        vm.prank(gate);
        guard.debit(id, SVC_TRUSTED, 1 ether, address(0), 558206);
    }

    /// ─────────── AUDIT #6 — a sub-second window silently disables the cap ────

    /// `_nowMs()` advances in 1000ms steps, so any window <= 1000 prunes every
    /// entry and `maxCallsInWindow` never fires. openPolicy must refuse it
    /// rather than accept a policy whose advertised rate cap is inert.
    function test_openPolicy_rejectsSubSecondWindow() public {
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        vm.prank(owner);
        guard.openPolicy(gate, BUDGET, PER_CALL, 0, MAX_CALLS, MIN_TIER, false);
    }

    function test_openPolicy_rejectsZeroGate() public {
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        vm.prank(owner);
        guard.openPolicy(address(0), BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER, false);
    }

    // ─── AUDIT #4 — the trust rule must come from the chain, not the caller ───

    /// Before the fix `trustTier` was a parameter supplied by `p.gate` — the
    /// very party the rule constrains — so passing 255 made it unreachable.
    /// The tier now comes from the registry score for `serviceId`.
    function test_debit_revertsWhenRegistryTierIsBelowPolicyMinimum() public {
        uint64 id = _openFunded(5 ether);
        vm.expectRevert(SpendGuard.UntrustedService.selector);
        vm.prank(gate);
        guard.debit(id, SVC_NEW, 1 ether, payTo, 536815);
    }

    function test_debit_allowsAServiceThatEarnedTheTierOnChain() public {
        uint64 id = _openFunded(5 ether);
        vm.prank(gate);
        guard.debit(id, _svc(1 ether), 1 ether, payTo, 523936);
        assertEq(guard.getRemaining(id), 4 ether);
    }

    /// `payTo` was never checked against the service, so a gate could charge a
    /// policy under one service's id while paying an unrelated address.
    function test_debit_revertsWhenPayeeIsNotTheServicePaymentTarget() public {
        uint64 id = _openFunded(5 ether);
        vm.expectRevert(SpendGuard.WrongPayee.selector);
        vm.prank(gate);
        guard.debit(id, SVC_TRUSTED, 1 ether, address(0xDEAD), 523499);
    }

    // ─── AUDIT R5 — the amount must be the service's listed price ───────────

    /// perCallCap was the ONLY bound on amount, so a gate could pay its cap for
    /// a service listing far less — the same "constrained party sets the value"
    /// defect that moved trustTier on-chain, left in place for the money.
    function test_debit_revertsWhenAmountIsNotTheListedPrice() public {
        uint64 id = _openFunded(5 ether);
        // SVC_TRUSTED lists 1e15; paying the policy's full per-call cap for it
        // is exactly the overcharge perCallCap alone could not prevent.
        vm.expectRevert(SpendGuard.WrongAmount.selector);
        vm.prank(gate);
        guard.debit(id, SVC_TRUSTED, 1 ether, payTo, 526327);
    }

    function test_debit_acceptsTheListedPrice() public {
        uint64 id = _openFunded(5 ether);
        vm.prank(gate);
        guard.debit(id, _svc(1e15), 1e15, payTo, 510055);
        assertEq(guard.getRemaining(id), 5 ether - 1e15);
    }

    // ─── AUDIT R8 — a gate must not be able to mint its own counterparty ────

    /// registerService is permissionless, so the WrongPayee and tier rules are
    /// both satisfiable by a registry entry the gate writes for itself. An
    /// allowlist is the only thing that binds a policy to counterparties its
    /// OWNER chose.
    function test_debit_revertsForAServiceNotOnAnEnforcedAllowlist() public {
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 0, true);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        vm.expectRevert(SpendGuard.ServiceNotAllowed.selector);
        vm.prank(gate);
        guard.debit(id, _svc(1e15), 1e15, payTo, 556394);
    }

    function test_debit_allowsAServiceTheOwnerListed() public {
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 0, true);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);
        vm.prank(owner);
        guard.setServiceAllowed(id, _svc(1e15), true);

        vm.prank(gate);
        guard.debit(id, _svc(1e15), 1e15, payTo, 561850);
        assertEq(guard.getRemaining(id), 5 ether - 1e15);
    }

    function test_setServiceAllowed_ownerOnly() public {
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 0, true);
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(gate);
        guard.setServiceAllowed(id, SVC_TRUSTED, true);
    }

    // ─── a minTrustTier no service can reach is the funds trap openPolicy
    //     rejects everywhere else ──────────────────────────────────────────

    function test_openPolicy_rejectsAnUnreachableTrustTier() public {
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        vm.prank(owner);
        guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 3, false);
    }

    // ─── AUDIT R6 — escrow-settled calls must be attestable ─────────────────

    /// debit paid the seller directly, so it produced no router settlement and
    /// recordAttestation reverted NoSuchPayment for every guard-paid call. A
    /// service used only through escrow was pinned at tier 0 forever — locked
    /// out of the very policies that were paying it, while the only reputation
    /// reachable came from the direct router path.
    function test_debit_producesAnAttestableSettlement() public {
        uint64 svc = _svc(1e15);
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 0, false);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        vm.prank(gate);
        guard.debit(id, svc, 1e15, payTo, 4242);

        // The guard is the payer of record; the attestor can now score it.
        reg.recordAttestation(svc, 4242, address(guard), bytes32(uint256(1)), true);
        (uint64 total, uint64 succ) = reg.getScore(svc);
        assertEq(total, 26); // 25 seeded + this one
        assertEq(succ, 26);
    }

    /// The seller still receives the money — routing it does not custody it.
    function test_debit_stillPaysTheSellerThroughTheRouter() public {
        uint64 svc = _svc(1e15);
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, 0, false);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        uint256 before = payTo.balance;
        vm.prank(gate);
        guard.debit(id, svc, 1e15, payTo, 4243);
        assertEq(payTo.balance - before, 1e15);
        assertEq(address(guard).balance, 5 ether - 1e15);
    }
}
