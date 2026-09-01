// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentGateRegistry} from "./AgentGateRegistry.sol";

/// @title SpendGuard — on-chain x402 spend-firewall escrow
/// @notice EVM port of contracts/spend-guard. An agent opens a Policy and
///         pre-funds an escrow; before serving a paid call the policy's `gate`
///         calls `debit`, which enforces every rule on-chain and reverts
///         atomically on any violation, so the payment never settles.
///         All timestamps are UNIX MILLISECONDS, matching `windowMs`.
contract SpendGuard {
    /// Highest tier `_tierOf` can return. A policy demanding more than this
    /// would accept deposits and revert every debit forever — the same funds
    /// trap `openPolicy`'s other checks exist to prevent.
    uint8 public constant MAX_TRUST_TIER = 2;

    /// policyId => serviceId => may this policy pay it?
    mapping(uint64 => mapping(uint64 => bool)) public serviceAllowed;

    /// The registry this guard reads scores and payout targets from.
    AgentGateRegistry public immutable REGISTRY;

    constructor(AgentGateRegistry registry) {
        REGISTRY = registry;
    }

    /// Trust tiers are a small 0..=255 scale; the score's source is off-chain
    /// (the registry's success/total ratio, bucketed).
    struct Policy {
        address owner;
        address gate;
        uint256 budget;
        uint256 spent;
        uint256 balance;
        uint256 perCallCap;
        uint64 windowMs;
        uint32 maxCallsInWindow;
        uint8 minTrustTier;
        /// When true, `debit` only pays serviceIds the OWNER listed. Registration
        /// is permissionless, so without this the payee and tier rules are both
        /// satisfiable by a registry entry the gate writes for itself — the
        /// firewall would bind nothing a rogue gate could not mint.
        bool restrictToAllowlist;
        bool paused;
        uint64 createdAt; // unix MS
    }

    error PolicyNotFound();
    error NotAuthorized();
    error Paused();
    error ZeroAmount();
    error ZeroPayTo();
    error WrongPayee();
    error WrongAmount();
    error ServiceNotAllowed();
    error PerCallExceeded();
    error UntrustedService();
    error DuplicateRef();
    error OverBudget();
    error RateExceeded();
    error InvalidConfig();
    error TransferFailed();

    event PolicyOpened(
        uint64 indexed policyId,
        address indexed owner,
        address indexed gate,
        uint256 budget,
        uint256 perCallCap,
        uint64 windowMs,
        uint32 maxCallsInWindow,
        uint8 minTrustTier
    );
    event Deposited(uint64 indexed policyId, uint256 amount, uint256 newBalance);
    /// Emitted only on an APPROVED debit. A blocked debit reverts and emits
    /// nothing — the failed tx itself is the on-chain "blocked" signal.
    event DebitApproved(
        uint64 indexed policyId,
        uint64 indexed serviceId,
        uint256 amount,
        address payTo,
        bytes32 paymentRef,
        uint256 remaining
    );
    event ServiceAllowedChanged(uint64 indexed policyId, uint64 indexed serviceId, bool allowed);
    event PolicyPaused(uint64 indexed policyId, bool paused);
    event Withdrawn(uint64 indexed policyId, uint256 amount, uint256 remaining);

    /// Number of policies opened; ids are 1-based (1..=policiesCount).
    uint64 public policiesCount;

    mapping(uint64 => Policy) private _policies;
    /// policyId => paymentRef => already debited? Replay guard.
    mapping(uint64 => mapping(bytes32 => bool)) public seenRefs;
    /// policyId => approved-debit timestamps (ms) inside the live rate window.
    mapping(uint64 => uint64[]) private _callTimes;

    /// @notice Open a spend policy; the caller becomes its owner.
    function openPolicy(
        address gate,
        uint256 budget,
        uint256 perCallCap,
        uint64 windowMs,
        uint32 maxCallsInWindow,
        uint8 minTrustTier,
        bool restrictToAllowlist
    ) external returns (uint64 policyId) {
        // A policy that could accept deposits but never debit is a funds trap.
        //
        // windowMs is floored at one second because _nowMs() advances in
        // 1000ms steps: every `nowMs - times[i]` is a multiple of 1000, so a
        // window of 0 prunes even the entry written in this block and any
        // window <= 1000 collapses to same-block-only. Either way keptLen
        // stays 0, `keptLen >= maxCallsInWindow` never fires, and the policy
        // advertises a rate cap it does not enforce.
        if (
            perCallCap == 0 || maxCallsInWindow == 0 || budget == 0
                || perCallCap > budget || windowMs < 1000 || gate == address(0)
                || minTrustTier > MAX_TRUST_TIER
        ) {
            revert InvalidConfig();
        }

        policyId = policiesCount + 1;
        _policies[policyId] = Policy({
            owner: msg.sender,
            gate: gate,
            budget: budget,
            spent: 0,
            balance: 0,
            perCallCap: perCallCap,
            windowMs: windowMs,
            maxCallsInWindow: maxCallsInWindow,
            minTrustTier: minTrustTier,
            restrictToAllowlist: restrictToAllowlist,
            paused: false,
            createdAt: _nowMs()
        });
        policiesCount = policyId;

        emit PolicyOpened(
            policyId, msg.sender, gate, budget, perCallCap, windowMs,
            maxCallsInWindow, minTrustTier
        );
    }

    /// @notice Top up a policy's escrow. Anyone may fund.
    function deposit(uint64 policyId) external payable {
        Policy storage p = _loadPolicy(policyId);
        if (msg.value == 0) revert ZeroAmount();
        uint256 newBalance = p.balance + msg.value;
        p.balance = newBalance;
        emit Deposited(policyId, msg.value, newBalance);
    }

    /// @notice The firewall. The policy `gate` requests a spend; every rule is
    ///         enforced here and, only if ALL pass, `amount` moves from the
    ///         escrow to `payTo`. Any violation reverts and nothing moves.
    /// @dev Revert order is normative — see the design doc §8.
    function debit(
        uint64 policyId,
        uint64 serviceId,
        uint256 amount,
        address payTo,
        bytes32 paymentRef
    ) external {
        Policy storage p = _loadPolicy(policyId);

        if (msg.sender != p.gate) revert NotAuthorized();
        if (p.paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        // A CALL to address(0) with value SUCCEEDS and burns the funds, so
        // without this the escrow leaves, the ref is consumed and
        // DebitApproved is emitted while nobody was paid. PaymentRouter.pay
        // refuses the same input; both settlement paths must agree.
        if (payTo == address(0)) revert ZeroPayTo();
        if (amount > p.perCallCap) revert PerCallExceeded();

        // The tier is derived from the registry, never asserted by the caller.
        // It used to be a `uint8 trustTier` parameter supplied by `p.gate` —
        // the exact party this rule exists to constrain — so `255` made the
        // check unreachable and the firewall's trust rule decorative.
        if (_tierOf(serviceId) < p.minTrustTier) revert UntrustedService();

        // The gate must not be able to pick its own counterparty. Registration
        // is permissionless, so it can mint a service whose paymentTarget is
        // its own address and satisfy every other rule here.
        if (p.restrictToAllowlist && !serviceAllowed[policyId][serviceId]) {
            revert ServiceNotAllowed();
        }

        // Bind the money to the service it is charged against — both WHO is
        // paid and HOW MUCH. perCallCap alone left the amount asserted by the
        // gate, the exact party these rules constrain, so a service listing
        // 0.001 OG could be charged the full cap.
        _requireSettlementTerms(serviceId, payTo, amount);

        if (seenRefs[policyId][paymentRef]) revert DuplicateRef();

        // Budget: must fit BOTH the escrow and the cumulative cap.
        uint256 newSpent = p.spent + amount;
        if (amount > p.balance || newSpent > p.budget) revert OverBudget();

        // Rate window: prune entries older than the window, then check the cap.
        // The age test (now - t < window) is underflow-safe and correct at t=0,
        // unlike a `t > now - window` cutoff which saturates.
        uint64 nowMs = _nowMs();
        uint64[] storage times = _callTimes[policyId];
        uint64[] memory kept = new uint64[](times.length);
        uint256 keptLen = 0;
        for (uint256 i = 0; i < times.length; i++) {
            if (nowMs - times[i] < p.windowMs) {
                kept[keptLen] = times[i];
                keptLen++;
            }
        }
        if (keptLen >= p.maxCallsInWindow) revert RateExceeded();

        // ── all checks passed: settle atomically ──
        // Checks-effects-interactions: every write lands before the transfer.
        uint256 remaining = p.balance - amount;
        p.balance = remaining;
        p.spent = newSpent;
        seenRefs[policyId][paymentRef] = true;

        // Rewrite the pruned window plus this call.
        while (times.length > keptLen) times.pop();
        for (uint256 i = 0; i < keptLen; i++) times[i] = kept[i];
        times.push(nowMs);

        (bool ok, ) = payTo.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit DebitApproved(policyId, serviceId, amount, payTo, paymentRef, remaining);
    }

    /// Payee and price must both match what the service registered. Kept in
    /// its own frame: inlined, its two locals push `debit` over the stack limit.
    function _requireSettlementTerms(uint64 serviceId, address payTo, uint256 amount)
        internal
        view
    {
        (address target, uint256 price) = REGISTRY.settlementTermsOf(serviceId);
        if (payTo != target) revert WrongPayee();
        if (amount != price) revert WrongAmount();
    }

    /// Registry score -> trust tier. Mirrors packages/shared/src/trust.ts
    /// exactly (new = 0, reliable = 1, trusted = 2) using integer ratios, so
    /// on-chain enforcement and off-chain display can never disagree.
    function _tierOf(uint64 serviceId) internal view returns (uint8) {
        (uint64 total, uint64 success) = REGISTRY.getScore(serviceId);
        if (total < 5) return 0;
        if (total >= 25 && uint256(success) * 100 >= uint256(total) * 95) return 2;
        if (uint256(success) * 10 >= uint256(total) * 9) return 1;
        return 0;
    }

    /// @notice Allow (or revoke) one service for this policy. Owner only —
    ///         the whole point is that the GATE cannot choose its own
    ///         counterparties. No-op unless the policy was opened with
    ///         `restrictToAllowlist`.
    function setServiceAllowed(uint64 policyId, uint64 serviceId, bool allowed) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        serviceAllowed[policyId][serviceId] = allowed;
        emit ServiceAllowedChanged(policyId, serviceId, allowed);
    }

    /// @notice Withdraw unspent escrow back to the owner. Owner only. Works
    ///         while paused, so it doubles as the post-kill-switch recovery path.
    function withdraw(uint64 policyId, uint256 amount) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.balance) revert OverBudget();

        uint256 remaining = p.balance - amount;
        address to = p.owner;
        p.balance = remaining;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(policyId, amount, remaining);
    }

    /// @notice Pause / unpause a policy. Owner only.
    function pause(uint64 policyId, bool paused) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        p.paused = paused;
        emit PolicyPaused(policyId, paused);
    }

    /// @notice Fetch a policy. Reverts PolicyNotFound if never opened.
    function getPolicy(uint64 policyId) external view returns (Policy memory) {
        return _loadPolicy(policyId);
    }

    /// @notice Escrow currently available for a policy (0 if unknown).
    function getRemaining(uint64 policyId) external view returns (uint256) {
        return _policies[policyId].balance;
    }

    function _loadPolicy(uint64 policyId) internal view returns (Policy storage p) {
        p = _policies[policyId];
        if (p.owner == address(0)) revert PolicyNotFound();
    }

    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }
}
