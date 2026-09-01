// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// Refuses every incoming transfer — exercises the TransferFailed path.
contract RejectingPayee {
    receive() external payable {
        revert("nope");
    }
}

contract PaymentRouterTest is Test {
    PaymentRouter internal router;
    address internal buyer = address(0xB0B);
    address internal payTo = address(0xCAFE);

    function setUp() public {
        router = new PaymentRouter();
        vm.warp(1_756_500_000);
        vm.deal(buyer, 10 ether);
    }

    function test_pay_forwardsValueAndEmitsPaid() public {
        vm.expectEmit(true, true, true, true);
        emit PaymentRouter.Paid(
            7, 12345, buyer, payTo, 1e15, 1_756_500_000_000
        );
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 12345, payTo);

        assertEq(payTo.balance, 1e15);
        assertEq(address(router).balance, 0); // router never holds funds
    }

    function test_pay_revertsOnZeroValue() public {
        vm.expectRevert(PaymentRouter.ZeroAmount.selector);
        vm.prank(buyer);
        router.pay{value: 0}(7, 1, payTo);
    }

    function test_pay_revertsOnZeroPayTo() public {
        vm.expectRevert(PaymentRouter.ZeroPayTo.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 1, address(0));
    }

    function test_pay_revertsOnReplayedNonce() public {
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
        vm.expectRevert(PaymentRouter.DuplicateNonce.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
    }

    function test_pay_sameNonceOnDifferentServiceIsAllowed() public {
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
        vm.prank(buyer);
        router.pay{value: 1e15}(8, 99, payTo); // must not revert
        assertEq(payTo.balance, 2e15);
    }

    function test_pay_revertsWhenPayeeRejects() public {
        RejectingPayee bad = new RejectingPayee();
        vm.expectRevert(PaymentRouter.TransferFailed.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 1, address(bad));
    }

    /// AUDIT #3 — a griefer must not be able to burn someone else's invoice nonce.
    /// Before the fix, the attacker's 1-wei front-run burned (serviceId, nonce)
    /// and the buyer's real payment reverted DuplicateNonce forever.
    function test_pay_attackerCannotBurnAnotherPayersNonce() public {
        address attacker = address(0xBAD);
        vm.deal(attacker, 1 ether);

        // Attacker front-runs the buyer with 1 wei paid to itself.
        vm.prank(attacker);
        router.pay{value: 1}(7, 42, attacker);

        // The buyer's legitimate settlement of the SAME invoice must still work.
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 42, payTo);
        assertEq(payTo.balance, 1e15);
    }

    /// The replay guard must still bind the same payer to one settlement.
    function test_pay_samePayerStillCannotReplayNonce() public {
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 77, payTo);
        vm.expectRevert(PaymentRouter.DuplicateNonce.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 77, payTo);
    }

    function test_pay_nonceStaysUnburnedWhenTransferFails() public {
        RejectingPayee bad = new RejectingPayee();
        vm.prank(buyer);
        try router.pay{value: 1e15}(7, 55, address(bad)) {} catch {}
        // the whole call reverted, so the nonce must still be spendable
        assertFalse(router.seenNonce(router.nonceKey(7, 55, buyer)));
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 55, payTo);
        assertEq(payTo.balance, 1e15);
    }
}
