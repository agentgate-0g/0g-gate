// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

contract SpendGuardTest is Test {
    SpendGuard internal guard;

    address internal owner = address(0xA11CE);
    address internal gate = address(0x6A7E);
    address internal payTo = address(0xCAFE);

    uint256 internal constant BUDGET = 10 ether;
    uint256 internal constant PER_CALL = 1 ether;
    uint64 internal constant WINDOW_MS = 60_000;
    uint32 internal constant MAX_CALLS = 3;
    uint8 internal constant MIN_TIER = 2;

    function setUp() public {
        guard = new SpendGuard();
        vm.warp(1_756_500_000);
        vm.deal(owner, 100 ether);
    }

    function _open() internal returns (uint64 id) {
        vm.prank(owner);
        id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER);
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
        guard.openPolicy(gate, BUDGET, 0, WINDOW_MS, MAX_CALLS, MIN_TIER); // zero cap
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, 0, MIN_TIER); // zero rate
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 0, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER); // zero budget
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 1 ether, 2 ether, WINDOW_MS, MAX_CALLS, MIN_TIER); // cap > budget
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
        bytes32 ref = bytes32(uint256(1));

        vm.expectEmit(true, true, true, true, address(guard));
        emit SpendGuard.DebitApproved(id, 7, 1 ether, payTo, ref, 4 ether);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER);

        assertEq(payTo.balance, 1 ether);
        SpendGuard.Policy memory p = guard.getPolicy(id);
        assertEq(p.balance, 4 ether);
        assertEq(p.spent, 1 ether);
    }

    function test_debit_revertOrderIsNormative() public {
        uint64 id = _openFunded(5 ether);
        bytes32 ref = bytes32(uint256(1));

        // PolicyNotFound before NotAuthorized (stranger on a missing policy)
        vm.expectRevert(SpendGuard.PolicyNotFound.selector);
        vm.prank(address(0xDEAD));
        guard.debit(99, 7, 1 ether, payTo, ref, MIN_TIER);

        // NotAuthorized before Paused: pause first, so the next call
        // violates BOTH rules (wrong caller on an already-paused policy)
        // and NotAuthorized must still win.
        vm.prank(owner);
        guard.pause(id, true);
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER);

        // Paused before ZeroAmount: still paused, correct caller, zero
        // amount — both rules violated, Paused must still win.
        vm.expectRevert(SpendGuard.Paused.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0, payTo, ref, MIN_TIER);
        vm.prank(owner);
        guard.pause(id, false);

        // ZeroAmount fires here too, but this pair is not pinned: openPolicy
        // requires perCallCap > 0, so a zero amount can never simultaneously
        // exceed it. This only confirms ZeroAmount still fires in position.
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0, payTo, ref, MIN_TIER);

        // PerCallExceeded before UntrustedService (over cap AND untrusted —
        // both rules violated, PerCallExceeded must still win).
        vm.expectRevert(SpendGuard.PerCallExceeded.selector);
        vm.prank(gate);
        guard.debit(id, 7, 2 ether, payTo, ref, 0);

        // Burn `ref` legitimately so the next case can combine an
        // already-seen ref with an untrusted caller.
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER);

        // UntrustedService before DuplicateRef: ref is already burned AND
        // the caller is untrusted — both rules violated, UntrustedService
        // must still win.
        vm.expectRevert(SpendGuard.UntrustedService.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER - 1);

        // DuplicateRef before OverBudget: a second, thinly-funded policy so
        // an in-cap amount can exceed what's left of the escrow. Burn a
        // ref, then reuse it while asking for more than the balance — both
        // rules violated, DuplicateRef must still win.
        vm.prank(owner);
        uint64 id2 = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER);
        vm.prank(owner);
        guard.deposit{value: 0.5 ether}(id2);
        bytes32 ref2 = bytes32(uint256(2));
        vm.prank(gate);
        guard.debit(id2, 7, 0.3 ether, payTo, ref2, MIN_TIER); // balance -> 0.2 ether
        vm.expectRevert(SpendGuard.DuplicateRef.selector);
        vm.prank(gate);
        guard.debit(id2, 7, 0.5 ether, payTo, ref2, MIN_TIER); // also > balance

        // OverBudget before RateExceeded: fill id2's rate window to its cap
        // with two more small, freshly-refed debits, then request an
        // in-cap amount that exceeds what's left of the escrow — both
        // rules violated, OverBudget must still win. This is the one pair
        // the suite never previously exercised at all.
        vm.prank(gate);
        guard.debit(id2, 7, 0.05 ether, payTo, bytes32(uint256(3)), MIN_TIER); // balance -> 0.15
        vm.prank(gate);
        guard.debit(id2, 7, 0.05 ether, payTo, bytes32(uint256(4)), MIN_TIER); // balance -> 0.10, window full (3/3)
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id2, 7, 1 ether, payTo, bytes32(uint256(5)), MIN_TIER);
    }

    function test_debit_revertsOverEscrowBalance() public {
        uint64 id = _openFunded(0.5 ether);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(1)), MIN_TIER);
    }

    function test_debit_revertsOverCumulativeBudget() public {
        // budget 2 ether, cap 1 ether, escrow 5 ether: the 3rd call breaches budget
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, 2 ether, 1 ether, WINDOW_MS, 10, 0);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(1)), 0);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(2)), 0);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(3)), 0);
    }

    function test_debit_rateWindowBlocksThenReopens() public {
        uint64 id = _openFunded(10 ether);
        for (uint256 i = 1; i <= MAX_CALLS; i++) {
            vm.prank(gate);
            guard.debit(id, 7, 0.1 ether, payTo, bytes32(i), MIN_TIER);
        }
        vm.expectRevert(SpendGuard.RateExceeded.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(99)), MIN_TIER);

        // roll past the window (windowMs is MS; block.timestamp is SECONDS)
        vm.warp(block.timestamp + (WINDOW_MS / 1000) + 1);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(100)), MIN_TIER);
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
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(1)), MIN_TIER); // t0

        vm.warp(t0 + 30);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(2)), MIN_TIER); // t0+30s

        vm.warp(t0 + 45);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(3)), MIN_TIER); // t0+45s

        // t0 is now 61s old (>= the 60s window) and prunes; the other two
        // (31s and 16s old) survive and shift down. One slot is free.
        vm.warp(t0 + 61);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(4)), MIN_TIER);

        // The window (2 survivors + this new entry) is immediately full
        // again, so a second call at the same timestamp must revert.
        vm.expectRevert(SpendGuard.RateExceeded.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(5)), MIN_TIER);
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
}
