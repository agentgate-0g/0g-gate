// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// Drives SpendGuard through the widest authority any one key can hold over an
/// escrow: this contract is the policy OWNER and the policy GATE at once, so
/// it can open, fund, spend, pause and drain. Every argument comes from the
/// fuzzer, so the sequences below are ones nobody wrote by hand.
///
/// Reverts are a normal, wanted outcome here — an over-budget debit, a
/// duplicate nonce, a full rate window, a withdrawal larger than the balance.
/// Those are exactly the calls worth generating, because the property under
/// test is what the books look like AFTER a rule refuses a call, and
/// `fail_on_revert = false` (foundry.toml) lets the runner count them and move
/// on. The handler therefore never guards against them.
///
/// It deliberately inherits the cheat/util bases rather than `Test`: a target
/// contract exposes every public function it has to the fuzzer, and `Test`
/// would hand it the whole assertion library to call with random arguments.
contract SpendGuardHandler is CommonBase, StdCheats, StdUtils {
    SpendGuard internal immutable GUARD;
    AgentGateRegistry internal immutable REG;

    /// At most this many policies. The fuzzer picks a policy by seed, so an
    /// unbounded set spreads deposits so thinly across it that almost every
    /// debit fails on an empty escrow and the accounting under test is never
    /// reached — a first draft of this handler managed 4 settled debits in
    /// 128,000 calls. A handful of policies is also what a real deployment
    /// looks like.
    uint256 internal constant MAX_POLICIES = 4;

    uint64[] internal _policies;
    uint64[] internal _services;

    /// Ghost counters. The invariant holds trivially over a run in which every
    /// call reverted, so `afterInvariant` prints these: a run that never
    /// managed a debit has not tested anything.
    uint256 public opens;
    uint256 public deposits;
    uint256 public debits;
    uint256 public withdrawals;

    /// Escrow withdrawn to a chosen recipient has to land somewhere that
    /// accepts value; these do, and none of them is a policy or a payee.
    address[3] internal _recipients =
        [address(0xD00D01), address(0xD00D02), address(0xD00D03)];

    constructor(SpendGuard guard, AgentGateRegistry registry, uint64[] memory services) {
        GUARD = guard;
        REG = registry;
        _services = services;
        // One policy exists before the first fuzzed call, so a debit can
        // settle from call two rather than waiting on the fuzzer to open and
        // fund one in the right order.
        _open(100 ether, 1 ether, 60_000, GUARD.MAX_CALLS_IN_WINDOW());
    }

    /// Withdrawals to this handler (the policy owner) must not revert.
    receive() external payable {}

    function openPolicy(uint256 budgetSeed, uint256 capSeed, uint256 windowSeed, uint256 rateSeed)
        external
    {
        if (_policies.length >= MAX_POLICIES) return;
        uint256 budget = bound(budgetSeed, 0.5 ether, 100 ether);
        // Floored at the cheapest service's price so a policy is not opened
        // that can never pay anything; the rules that stop a debit for being
        // too large have their own tests, and here they would only stop the
        // handler from reaching the escrow at all.
        uint256 perCallCap = bound(capSeed, 1e15, budget);
        uint64 windowMs = uint64(bound(windowSeed, 1000, 3_600_000));
        // Floored well above 1 for the same reason: block time does not move
        // on its own between fuzzed calls, so a policy admitting one call per
        // window admits exactly one call for the whole run unless `warp`
        // happens to be picked in between.
        uint32 rate = uint32(bound(rateSeed, 16, GUARD.MAX_CALLS_IN_WINDOW()));
        // minTrustTier 0: the trust rule is pinned in Boundaries.t.sol, and
        // demanding a tier here would only mean every debit reverts before it
        // reached the accounting this is about.
        _open(budget, perCallCap, windowMs, rate);
    }

    function _open(uint256 budget, uint256 perCallCap, uint64 windowMs, uint32 rate) internal {
        uint64 policyId = GUARD.openPolicy(address(this), budget, perCallCap, windowMs, rate, 0);
        for (uint256 i = 0; i < _services.length; i++) {
            GUARD.setServiceAllowed(policyId, _services[i], true);
        }
        _policies.push(policyId);
        opens++;
    }

    function deposit(uint256 policySeed, uint256 amountSeed) external {
        uint64 policyId = _pickPolicy(policySeed);
        uint256 amount = bound(amountSeed, 1e15, 10 ether);
        vm.deal(address(this), address(this).balance + amount);
        GUARD.deposit{value: amount}(policyId);
        deposits++;
    }

    function debit(uint256 policySeed, uint256 serviceSeed, uint256 nonce) external {
        uint64 policyId = _pickPolicy(policySeed);
        uint64 serviceId = _services[serviceSeed % _services.length];
        // The amount and payee are read from the registry because `debit`
        // requires both to match exactly; a fuzzer picking them freely would
        // spend every call on WrongAmount and never reach the escrow.
        (address payTo, uint256 price) = REG.settlementTermsOf(serviceId);
        GUARD.debit(policyId, serviceId, price, payTo, bound(nonce, 1, 4096));
        debits++;
    }

    /// Block time is frozen across fuzzed calls, so without this the rate
    /// window never ages and the ring buffer's overwrite path — the one that
    /// rewrites a slot rather than pushing — is barely reached.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 600));
    }

    function withdrawToOwner(uint256 policySeed, uint256 amountSeed) external {
        uint64 policyId = _pickPolicy(policySeed);
        GUARD.withdraw(policyId, bound(amountSeed, 1, 10 ether));
        withdrawals++;
    }

    function withdrawToRecipient(uint256 policySeed, uint256 amountSeed, uint256 whoSeed)
        external
    {
        uint64 policyId = _pickPolicy(policySeed);
        address to = _recipients[whoSeed % _recipients.length];
        GUARD.withdraw(policyId, bound(amountSeed, 1, 10 ether), to);
        withdrawals++;
    }

    function pause(uint256 policySeed, bool paused) external {
        GUARD.pause(_pickPolicy(policySeed), paused);
    }

    /// Reverts before any policy exists, which the runner discards like any
    /// other refused call.
    function _pickPolicy(uint256 seed) internal view returns (uint64) {
        return _policies[seed % _policies.length];
    }
}

/// ESCROW SOLVENCY — the property that matters most for a contract holding
/// other people's money: what the books say the guard owes, and what the guard
/// actually holds, are the same number.
///
/// Every rule in `debit` is a rule about WHETHER to pay. This is the one about
/// the money itself, and no single-path test states it: `debit`, `deposit` and
/// both `withdraw` overloads each move a balance and an ether amount in two
/// separate statements, and a mismatch between them is not a reverting bug —
/// it is a policy quietly credited with ether the contract does not have, or
/// ether sitting in the contract that no policy can ever withdraw.
contract SpendGuardSolvencyInvariant is Test {
    AgentGateRegistry internal reg;
    PaymentRouter internal router;
    SpendGuard internal guard;
    SpendGuardHandler internal handler;

    address internal seller = address(0x5E11E7);
    address internal payout = address(0xCAFE);

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        guard = new SpendGuard(reg);
        vm.warp(1_756_500_000);

        // Three prices, so a debit's amount is not a constant.
        uint64[] memory services = new uint64[](3);
        services[0] = _register(1e15);
        services[1] = _register(0.1 ether);
        services[2] = _register(3e16);

        handler = new SpendGuardHandler(guard, reg, services);

        // Restrict the fuzzer to the handler's own entry points. Without the
        // selector list it would also call everything the handler inherits.
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = SpendGuardHandler.openPolicy.selector;
        selectors[1] = SpendGuardHandler.deposit.selector;
        selectors[2] = SpendGuardHandler.debit.selector;
        selectors[3] = SpendGuardHandler.withdrawToOwner.selector;
        selectors[4] = SpendGuardHandler.withdrawToRecipient.selector;
        selectors[5] = SpendGuardHandler.pause.selector;
        selectors[6] = SpendGuardHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _register(uint256 price) internal returns (uint64 id) {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: price, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        vm.prank(seller);
        id = reg.registerService("svc", "d", "https://g.example", a, payout, address(this));
    }

    /// Equality, not `<=`. The weaker form — never owing more than it holds —
    /// is the safety property, but it hides the opposite failure: ether that
    /// arrived without being credited is ether no policy owner can ever
    /// withdraw, and the guard has no sweep. The one way production can exceed
    /// the sum honestly is a service registering the guard itself as its
    /// payout target, which no handler here does.
    function invariant_everyPolicyBalanceIsBackedByRealEther() public view {
        uint256 owed;
        for (uint64 i = 1; i <= guard.policiesCount(); i++) {
            owed += guard.getRemaining(i);
        }
        assertEq(owed, address(guard).balance, "the guard's books do not match its balance");
    }

    function afterInvariant() public {
        emit log_named_uint("policies opened ", handler.opens());
        emit log_named_uint("deposits        ", handler.deposits());
        emit log_named_uint("debits settled  ", handler.debits());
        emit log_named_uint("withdrawals     ", handler.withdrawals());
    }
}

/// Registers services and scores them the only way the registry allows —
/// settle at the router, then attest — with the amounts, nonces and outcomes
/// all fuzzed, so underpayments, duplicate nonces and repeat attestations all
/// occur and are refused.
contract RegistryScoreHandler is CommonBase, StdCheats, StdUtils {
    AgentGateRegistry internal immutable REG;
    PaymentRouter internal immutable ROUTER;

    address internal constant SELLER = address(0x5E11E7);
    address internal constant PAYOUT = address(0xBEEF01);
    address internal constant BUYER = address(0xB0BB1);

    /// Bounded for the same reason the policy set is: the fuzzer picks a
    /// service by seed, and a set that grows on a quarter of all calls dilutes
    /// every later pick until almost nothing gets scored twice.
    uint256 internal constant MAX_SERVICES = 4;

    uint64[] internal _services;
    mapping(uint64 => uint256) internal _price;

    uint256 public registrations;
    uint256 public attestations;

    constructor(AgentGateRegistry registry, PaymentRouter router) {
        REG = registry;
        ROUTER = router;
        _register(1e15);
    }

    function registerService(uint256 priceSeed) external {
        if (_services.length >= MAX_SERVICES) return;
        _register(bound(priceSeed, REG.MIN_PRICE_WEI(), 1 ether));
    }

    function _register(uint256 price) internal {
        AgentGateRegistry.PaymentOption[] memory a =
            new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0), amount: price, decimals: 18,
            symbol: "OG", name: "", version: ""
        });
        // The seller cannot witness itself, so the handler is the attestor and
        // the service is registered under a separate seller address.
        vm.prank(SELLER);
        uint64 id = REG.registerService("svc", "d", "https://g.example", a, PAYOUT, address(this));
        _services.push(id);
        _price[id] = price;
        registrations++;
    }

    function settleAndAttest(
        uint256 serviceSeed,
        uint256 nonceSeed,
        uint256 amountSeed,
        bool success
    ) external {
        uint64 id = _services[serviceSeed % _services.length];
        // Wide enough that fresh nonces stay available for the whole run —
        // the router burns one per settlement and never releases it — but not
        // so wide that a repeat, which must be refused, never comes up.
        uint256 nonce = bound(nonceSeed, 1, 4096);
        uint256 amount = bound(amountSeed, 1, _price[id] * 2); // often under the price
        vm.deal(BUYER, amount);
        vm.prank(BUYER);
        ROUTER.pay{value: amount}(id, nonce, PAYOUT);
        REG.recordAttestation(id, nonce, BUYER, bytes32(nonce), success);
        attestations++;
    }

    /// Scoring a call that was never paid for must not move the counters. The
    /// handler makes the attempt so the fuzzer explores it; the nonce range is
    /// disjoint from `settleAndAttest`'s, so no settlement can ever back one
    /// of these and every call reverts NoSuchPayment.
    function attestWithoutPaying(uint256 serviceSeed, uint256 nonceSeed, bool success)
        external
    {
        uint64 id = _services[serviceSeed % _services.length];
        uint256 nonce = bound(nonceSeed, 1e9, 1e9 + 4096);
        REG.recordAttestation(id, nonce, BUYER, bytes32(nonce), success);
    }

    function setActive(uint256 serviceSeed, bool active) external {
        vm.prank(SELLER);
        REG.setActive(_services[serviceSeed % _services.length], active);
    }
}

/// successCalls can never exceed totalCalls, for any service, ever.
///
/// The two counters are written as a pair in `recordAttestation`, in an
/// `unchecked` block, each with its own saturating branch — a shape where the
/// success side incrementing on a path the total side does not is an easy
/// mistake and a permanent one. A service reporting more successes than calls
/// is a success RATE above 100%, which every trust tier and every dashboard
/// downstream computes from, including `SpendGuard._tierOf` — the check that
/// decides whether an escrow will pay a counterparty at all.
contract RegistryScoreInvariant is Test {
    AgentGateRegistry internal reg;
    PaymentRouter internal router;
    RegistryScoreHandler internal handler;

    function setUp() public {
        router = new PaymentRouter();
        reg = new AgentGateRegistry(router);
        vm.warp(1_756_500_000);

        handler = new RegistryScoreHandler(reg, router);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = RegistryScoreHandler.registerService.selector;
        selectors[1] = RegistryScoreHandler.settleAndAttest.selector;
        selectors[2] = RegistryScoreHandler.attestWithoutPaying.selector;
        selectors[3] = RegistryScoreHandler.setActive.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_successNeverExceedsTotalForAnyService() public view {
        uint64 count = reg.servicesCount();
        for (uint64 id = 1; id <= count; id++) {
            (uint64 total, uint64 success) = reg.getScore(id);
            assertLe(success, total, "a service reports more successes than calls");
        }
    }

    function afterInvariant() public {
        emit log_named_uint("services registered", handler.registrations());
        emit log_named_uint("calls scored       ", handler.attestations());
    }
}
