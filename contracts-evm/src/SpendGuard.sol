// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentGateRegistry} from "./AgentGateRegistry.sol";
import {PaymentRouter} from "./PaymentRouter.sol";

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

    /// Hard ceiling on `maxCallsInWindow`, and therefore on how many entries
    /// the rate window can ever hold.
    ///
    /// The window used to be an unbounded uint32 over a list the debit path
    /// rebuilt in full on every call: it scanned every timestamp, copied the
    /// survivors into memory, popped the storage array down and wrote them all
    /// back. At a window of 1024 entries that one debit cost 2,180,345 gas
    /// against 96,572 for the same call over the ring below, and the fill
    /// needed to reach that state ran past forge's default billion-gas ceiling.
    /// A policy configured for throughput could therefore price its own `debit`
    /// out of existence with the escrow sitting behind it, reachable only by
    /// `withdraw`. The ring makes the cost independent of how full the window
    /// is; this constant bounds the one thing the ring still scales with, which
    /// is the storage the array occupies.
    uint32 public constant MAX_CALLS_IN_WINDOW = 1024;

    /// policyId => serviceId => may this policy pay it?
    ///
    /// Consulted on EVERY debit. It was once conditional on a per-policy
    /// `restrictToAllowlist` flag, and that flag is gone — see the long note on
    /// `debit`'s allowlist check for why a policy without one has no
    /// counterparty rule at all.
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
        /// A NARROWING filter over the owner's allowlist, never a substitute
        /// for one: it can take a listed counterparty away, it can never add an
        /// unlisted one. See `debit`.
        uint8 minTrustTier;
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
    /// `to` is part of the record because the recipient is a parameter now: an
    /// owner watching its own escrow has to be able to see WHERE a withdrawal
    /// went, not just that one happened.
    event Withdrawn(uint64 indexed policyId, uint256 amount, address to, uint256 remaining);

    /// Number of policies opened; ids are 1-based (1..=policiesCount).
    uint64 public policiesCount;

    mapping(uint64 => Policy) private _policies;
    /// policyId => keccak(serviceId, nonce) => already debited? Replay guard.
    /// Keyed WITH the serviceId: nonces are unique per service, so a bare nonce
    /// would collide across services inside one policy and block a legitimate
    /// call the first time two sellers happened to issue the same number.
    mapping(uint64 => mapping(bytes32 => bool)) public seenRefs;

    /// policyId => approved-debit timestamps (ms) as a RING BUFFER of at most
    /// `maxCallsInWindow` entries. Never pruned: an entry is overwritten by the
    /// call that displaces it and by nothing else, so the array grows to the
    /// policy's cap once and then stays that size forever.
    mapping(uint64 => uint64[]) private _callTimes;
    /// policyId => the ring slot the NEXT approved debit will write.
    ///
    /// Once the ring is full that slot also holds the OLDEST timestamp — the
    /// one about to be displaced — which is the whole reason the rate check can
    /// be a single read. See `debit`.
    mapping(uint64 => uint32) private _ringCursor;

    /// @notice Open a spend policy; the caller becomes its owner.
    function openPolicy(
        address gate,
        uint256 budget,
        uint256 perCallCap,
        uint64 windowMs,
        uint32 maxCallsInWindow,
        uint8 minTrustTier
    ) external returns (uint64 policyId) {
        // A policy that could accept deposits but never debit is a funds trap.
        //
        // windowMs is floored at one second because _nowMs() advances in
        // 1000ms steps: every `nowMs - t` is a multiple of 1000, so a window of
        // 0 ages out even the entry written in this block and any window
        // <= 1000 collapses to same-block-only. Either way the ring never
        // reports a live entry, `RateExceeded` never fires, and the policy
        // advertises a rate cap it does not enforce.
        //
        // maxCallsInWindow is capped at MAX_CALLS_IN_WINDOW because the ring is
        // allocated one entry per approved call up to that number, and an
        // owner who asked for 2^32 slots would be paying for storage the
        // policy's own budget could never fill — see the constant's note for
        // the gas figures that made this a funds trap rather than a nuisance.
        if (
            perCallCap == 0 || maxCallsInWindow == 0 || budget == 0
                || perCallCap > budget || windowMs < 1000 || gate == address(0)
                || minTrustTier > MAX_TRUST_TIER
                || maxCallsInWindow > MAX_CALLS_IN_WINDOW
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
        uint256 nonce
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
        //
        // What it is NOT is a counterparty rule. `_tierOf` reads a score that
        // an attacker mints for himself: register a service paying an address
        // he owns, send it 25 payments from a second address he owns (the OG
        // lands back in his own pocket, so only gas is burned), attest each
        // from a third, and the service stands at the top of this scale. The
        // rule below is therefore a NARROWING filter over the set the owner
        // already approved — it can disqualify a listed service whose track
        // record has gone bad, and it can never qualify one nobody listed.
        if (_tierOf(serviceId) < p.minTrustTier) revert UntrustedService();

        // The owner's allowlist, and the ONLY rule here that a rogue gate
        // cannot satisfy by writing the registry entry itself.
        //
        // This check was once conditional on a per-policy `restrictToAllowlist`
        // flag, and `openPolicy` accepted a policy with the flag off. That
        // combination had no counterparty rule left standing: registration is
        // permissionless, so a gate could mint a service whose paymentTarget is
        // its own address, buy it the top tier as described above, and then
        // bill the escrow up to `budget` — every other rule in this function
        // (payee, price, per-call cap, rate) is satisfied by construction when
        // the gate wrote the listing it is billing against. The flag is gone
        // rather than defaulted, because an escrow whose counterparty set is
        // "whatever the spender registers" is not a firewall in any mode.
        if (!serviceAllowed[policyId][serviceId]) revert ServiceNotAllowed();

        // Bind the money to the service it is charged against — both WHO is
        // paid and HOW MUCH. perCallCap alone left the amount asserted by the
        // gate, the exact party these rules constrain, so a service listing
        // 0.001 OG could be charged the full cap.
        _requireSettlementTerms(serviceId, payTo, amount);

        bytes32 ref = keccak256(abi.encode(serviceId, nonce));
        if (seenRefs[policyId][ref]) revert DuplicateRef();

        // Budget: must fit BOTH the escrow and the cumulative cap.
        uint256 newSpent = p.spent + amount;
        if (amount > p.balance || newSpent > p.budget) revert OverBudget();

        // ── rate window ──────────────────────────────────────────────────────
        //
        // "Are `maxCallsInWindow` approved calls already inside the window?" is
        // ONE storage read, because timestamps only ever increase. Entries are
        // written in ascending order around the ring, so the slot the next call
        // will overwrite — `cursor` — holds the oldest of them; and the ring
        // only reaches `maxCallsInWindow` entries by having that many approved
        // calls behind it. If the ring is full and its oldest entry is still
        // inside the window then all of them are, and the cap is reached. If
        // the oldest has aged out, at most maxCallsInWindow-1 remain and there
        // is room. Nothing here depends on how many entries the window holds,
        // which is exactly the property the old prune-and-rebuild lacked.
        //
        // The age test is `now - t < window` rather than `t > now - window`:
        // the latter underflows to a saturated cutoff for any `now` inside the
        // first `window` milliseconds of the epoch and would age out nothing.
        uint64 nowMs = _nowMs();
        uint64[] storage times = _callTimes[policyId];
        uint32 cursor = _ringCursor[policyId];
        if (times.length == p.maxCallsInWindow && nowMs - times[cursor] < p.windowMs) {
            revert RateExceeded();
        }

        // ── all checks passed: settle atomically ──
        // Checks-effects-interactions: every write lands before the transfer.
        uint256 remaining = p.balance - amount;
        p.balance = remaining;
        p.spent = newSpent;
        seenRefs[policyId][ref] = true;

        // Grow the ring until it reaches the policy's cap, then reuse slots.
        // The cursor advances on BOTH paths, so by the time the last slot is
        // pushed it has already wrapped to 0 — the index of the oldest entry —
        // and the invariant the check above relies on holds from the first
        // moment the ring is full.
        if (times.length < p.maxCallsInWindow) {
            times.push(nowMs);
        } else {
            times[cursor] = nowMs;
        }
        _ringCursor[policyId] = (cursor + 1) % p.maxCallsInWindow;

        // Settle THROUGH the router, not directly. A direct transfer paid the
        // seller but produced no settlement, so recordAttestation reverted
        // NoSuchPayment for every escrow-paid call: a service used only through
        // a spend policy could never earn reputation, and was therefore locked
        // out of the very policies paying it. Routing it makes both settlement
        // paths mint the same attestable evidence, with this contract as the
        // payer of record. The router forwards the value straight on and
        // custodies nothing; its own revert propagates rather than being
        // flattened into TransferFailed.
        //
        // `nonce` is passed THROUGH, unchanged and un-namespaced, and that is
        // deliberate. An audit proposed mixing `policyId` into it to stop two
        // policies colliding at the router. It must not happen: the gateway
        // verifies a payment by matching the indexed `nonce` on `Paid` against
        // the one it issued in the 402, so a rewritten nonce makes every
        // escrow-paid call unverifiable — the buyer's money is gone and the
        // call is never served. The collision the audit worried about is
        // already impossible, because the router keys its settlements on
        // (serviceId, nonce, PAYER, payTo) and the payer here is this contract.
        REGISTRY.ROUTER().pay{value: amount}(serviceId, nonce, payTo);

        emit DebitApproved(policyId, serviceId, amount, payTo, ref, remaining);
    }

    /// Payee and price must both match what the service registered. Kept in
    /// its own frame: inlined, its two locals push `debit` over the stack limit.
    ///
    /// `settlementTermsOf` reverts `ServiceInactive` for a service its own
    /// owner has switched off, and that revert is allowed to propagate rather
    /// than being caught and turned into a softer failure. `active` is the
    /// seller's kill switch; an escrow that swallowed it would keep paying a
    /// service that has declared itself unable to serve, which is the exact
    /// shape of "paid for and never delivered" the firewall exists to prevent.
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
    ///         counterparties. A policy pays nothing until its owner has
    ///         listed it here.
    function setServiceAllowed(uint64 policyId, uint64 serviceId, bool allowed) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        serviceAllowed[policyId][serviceId] = allowed;
        emit ServiceAllowedChanged(policyId, serviceId, allowed);
    }

    /// @notice Withdraw unspent escrow to an address the OWNER names. Owner
    ///         only. Works while paused, so it doubles as the post-kill-switch
    ///         recovery path.
    ///
    /// The recipient is a parameter because the owner of a policy is normally a
    /// contract — an agent controller, a factory, a multisig. One that cannot
    /// accept value (no payable receive, or a fallback that reverts) could
    /// never be paid by the old hardcoded `to = p.owner`, and since a debit is
    /// the only other way escrow leaves this contract, its balance was stranded
    /// permanently with no rescue and no ownership transfer to escape through.
    function withdraw(uint64 policyId, uint256 amount, address to) external {
        _withdraw(policyId, amount, to);
    }

    /// @notice Withdraw unspent escrow back to the policy owner. Owner only.
    ///
    /// Kept as an overload rather than replaced: this is the signature every
    /// deployed caller and every off-chain script already uses, and changing
    /// `withdraw`'s arity under them would turn each of those calls into a
    /// revert against a contract holding their money.
    function withdraw(uint64 policyId, uint256 amount) external {
        _withdraw(policyId, amount, _loadPolicy(policyId).owner);
    }

    function _withdraw(uint64 policyId, uint256 amount, address to) internal {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        if (amount == 0) revert ZeroAmount();
        // Same hazard as `debit`'s payee check: a CALL to address(0) with value
        // returns success and burns it, so an unguarded rescue would report a
        // withdrawal, zero the balance and destroy the funds.
        if (to == address(0)) revert ZeroPayTo();
        if (amount > p.balance) revert OverBudget();

        uint256 remaining = p.balance - amount;
        p.balance = remaining;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(policyId, amount, to, remaining);
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
