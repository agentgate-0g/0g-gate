// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PaymentRouter} from "./PaymentRouter.sol";

/// @title AgentGateRegistry — service discovery + payment-attestation reputation
/// @notice Service registry + payment-attestation reputation ledger.
///         Semantics are preserved exactly: 1-based ids, caller becomes owner,
///         services start active, attestations are deduped per payment tx, and
///         all timestamps are UNIX MILLISECONDS (block.timestamp * 1000) because
///         every off-chain reader is contracted on ms.
contract AgentGateRegistry {
    /// The router whose settlements back this registry's attestations.
    PaymentRouter public immutable ROUTER;

    constructor(PaymentRouter router) {
        ROUTER = router;
    }

    /// Minimum price for any accepted option, in the asset's atomic units.
    /// 1e12 wei = 1e-6 OG. A floor, not a fee: it keeps a service from being
    /// registered at a price so small that the gas to pay it dwarfs the payment.
    uint256 public constant MIN_PRICE_WEI = 1e12;

    /// Per-service attestation ring-buffer capacity (keep the newest 100).
    uint256 public constant MAX_ATTESTATIONS = 100;

    /// How long an attestor rotation waits before it takes effect.
    uint64 public constant ATTESTOR_ROTATION_DELAY_MS = 15 * 60 * 1000;

    /// One accepted way to pay for a call — an entry in a service's price list.
    /// `asset == address(0)` means native OG; any other value is an ERC-20.
    /// `name`/`version` are EIP-712 domain fields, empty for native.
    struct PaymentOption {
        address asset;
        uint256 amount;
        uint8 decimals;
        string symbol;
        string name;
        string version;
    }

    /// On-chain record describing one registered (wrapped) service.
    /// `gatewayBaseUrl` is stored, NOT the full endpoint: readers compute
    /// `endpointUrl = {gatewayBaseUrl}/svc/{id}`.
    struct Service {
        string name;
        string description;
        string gatewayBaseUrl;
        PaymentOption[] accepts;
        address paymentTarget;
        address owner;
        address attestor;
        /// Rotation target, authoritative only from `attestorEffectiveAt`.
        address pendingAttestor;
        uint64 attestorEffectiveAt; // unix MS, 0 = no rotation pending
        bool active;
        uint64 createdAt; // unix MS
    }

    /// One recorded payment outcome.
    struct Attestation {
        bytes32 paymentTxHash;
        bool success;
        uint64 timestamp; // unix MS
    }

    error NotAuthorized();
    error ServiceNotFound();
    error ServiceInactive();
    error DuplicateAttestation();
    error InvalidPrice();
    error NoSuchPayment();
    error SelfPayment();
    error Underpaid();
    error NoNativeOption();
    error InvalidAttestor();
    error InvalidPaymentTarget();
    error EmptyName();

    event ServiceRegistered(
        uint64 indexed serviceId,
        address indexed owner,
        string name,
        PaymentOption[] accepts,
        address paymentTarget,
        address attestor
    );

    /// Number of registered services; equals the id of the most recent one
    /// (ids are 1-based, 1..=servicesCount; id 0 means "absent" to every reader).
    uint64 public servicesCount;

    mapping(uint64 => Service) private _services;

    /// @notice Register a new service; the caller becomes its owner.
    /// @return serviceId the assigned 1-based id.
    function registerService(
        string calldata name,
        string calldata description,
        string calldata gatewayBaseUrl,
        PaymentOption[] calldata accepts,
        address paymentTarget,
        address attestor
    ) external returns (uint64 serviceId) {
        if (_isBlank(name)) revert EmptyName();
        if (accepts.length == 0) revert InvalidPrice();
        if (paymentTarget == address(0)) revert InvalidPaymentTarget();
        // The subject of a score cannot be its own witness. Without this the
        // owner names itself attestor in the same call that registers the
        // service, restoring exactly the self-certification the attestor role
        // exists to remove.
        if (attestor == address(0) || attestor == msg.sender || attestor == paymentTarget) {
            revert InvalidAttestor();
        }
        for (uint256 i = 0; i < accepts.length; i++) {
            // `decimals` is seller-declared and feeds the floor, so for the one
            // asset the chain actually knows — native OG — pin it. Otherwise
            // declaring `decimals = 0` collapses the floor from 1e12 to 1 wei.
            if (accepts[i].asset == address(0) && accepts[i].decimals != 18) {
                revert InvalidPrice();
            }
            if (accepts[i].amount < _minPrice(accepts[i].decimals)) revert InvalidPrice();
        }

        // 1-based ids: bump the counter first, then use it as the id.
        serviceId = servicesCount + 1;

        Service storage s = _services[serviceId];
        s.name = name;
        s.description = description;
        s.gatewayBaseUrl = gatewayBaseUrl;
        s.paymentTarget = paymentTarget;
        s.owner = msg.sender;
        s.attestor = attestor;
        s.active = true;
        s.createdAt = _nowMs();
        // Struct arrays cannot be assigned from calldata in one go; copy element-wise.
        for (uint256 i = 0; i < accepts.length; i++) {
            s.accepts.push(accepts[i]);
        }

        servicesCount = serviceId;

        emit ServiceRegistered(
            serviceId, msg.sender, name, accepts, paymentTarget, attestor
        );
    }

    /// @notice Fetch a service record. Reverts ServiceNotFound for unknown ids.
    function getService(uint64 serviceId) external view returns (Service memory) {
        return _loadService(serviceId);
    }

    /// @notice Everything a settlement path needs about `serviceId`: who to pay
    ///         and the listed native price. One narrow call rather than
    ///         `getService`, whose return size the seller controls.
    function settlementTermsOf(uint64 serviceId)
        external
        view
        returns (address paymentTarget, uint256 nativePrice)
    {
        Service storage s = _loadService(serviceId);
        return (s.paymentTarget, _nativePrice(s));
    }

    /// @notice Just the payout target for `serviceId`, without the rest of the
    ///         record. `getService` returns the whole Service — every string
    ///         and every entry of the seller-controlled `accepts[]` — so a
    ///         caller that only needs the payee would otherwise pay gas
    ///         proportional to how many prices the seller happened to list.
    function paymentTargetOf(uint64 serviceId) external view returns (address) {
        return _loadService(serviceId).paymentTarget;
    }

    event AttestationRecorded(
        uint64 indexed serviceId,
        bytes32 indexed paymentTxHash,
        bool success,
        uint64 totalCalls,
        uint64 successCalls
    );
    event ServiceStatusChanged(uint64 indexed serviceId, bool active);
    event ServiceAttestorChanged(uint64 indexed serviceId, address attestor);

    /// serviceId => total calls recorded (full history; never capped).
    mapping(uint64 => uint64) public totalCalls;
    /// serviceId => successful calls recorded (full history; never capped).
    mapping(uint64 => uint64) public successCalls;
    /// serviceId => router settlement key => already attested? Deduping on the
    /// SETTLEMENT, not the supplied tx hash, is what stops one payment being
    /// attested many times under different hashes.
    mapping(uint64 => mapping(bytes32 => bool)) public seenPayments;

    /// serviceId => ring buffer of the last MAX_ATTESTATIONS attestations.
    mapping(uint64 => Attestation[]) private _attestations;
    /// serviceId => next write slot in the ring (== oldest entry once full).
    mapping(uint64 => uint256) private _attHead;

    /// @notice Record the outcome of one paid call, identified by the router
    ///         settlement that paid for it.
    /// @param nonce          the invoice nonce that was settled
    /// @param payer          the address that settled it
    /// @param paymentTxHash  the settling transaction, kept for display only —
    ///                       the SCORE is backed by the (serviceId, nonce,
    ///                       payer) settlement above, which the chain verifies.
    function recordAttestation(
        uint64 serviceId,
        uint256 nonce,
        address payer,
        bytes32 paymentTxHash,
        bool success
    ) external {
        Service storage s = _loadService(serviceId);

        // The subject of a score is not a witness for it. The owner was
        // previously accepted here, so a seller minted its own reputation.
        _promoteAttestor(s);
        if (msg.sender != s.attestor) revert NotAuthorized();

        // `active` deliberately does NOT gate this. It is a discovery flag;
        // gating the ledger on it let an owner front-run a failure attestation
        // with setActive(false) and erase the failure without a trace.

        // Every point must map to a settlement that paid THIS service ITS
        // price. Asking the router only "was this nonce used" was not enough:
        // it is set by one wei sent to any address, including the payer's own,
        // so a perfect score still cost nothing. Querying with our OWN
        // paymentTarget means a payment misdirected anywhere else simply is
        // not found, and the amount check rejects dust.
        uint256 paid = ROUTER.settledAmount(
            ROUTER.settlementKey(serviceId, nonce, payer, s.paymentTarget)
        );
        if (paid == 0) revert NoSuchPayment();
        if (paid < _nativePrice(s)) revert Underpaid();

        // Dedup on (serviceId, nonce, payer): one score per settlement,
        // whatever display hash the attestor supplies alongside it.
        bytes32 paymentKey = keccak256(abi.encode(serviceId, nonce, payer));

        // On-chain anti-wash-trading, mirroring the gateway's isSelfPayment.
        // Note this stops the literal self-pay, not a sybil paying from a fresh
        // address — that needs the staked attestations on the roadmap.
        // The witness is as interested a party as the owner: without
        // `payer != s.attestor` the attestor pays itself and signs off on it,
        // a self-contained two-call loop needing no sybil at all.
        if (payer == s.owner || payer == s.paymentTarget || payer == s.attestor) {
            revert SelfPayment();
        }

        if (seenPayments[serviceId][paymentKey]) revert DuplicateAttestation();
        seenPayments[serviceId][paymentKey] = true;

        // Saturating: a (practically unreachable) overflow pins at MAX rather
        // than reverting and bricking the service's score forever.
        uint64 total = totalCalls[serviceId];
        uint64 succeeded = successCalls[serviceId];
        unchecked {
            total = total == type(uint64).max ? total : total + 1;
            if (success && succeeded != type(uint64).max) succeeded += 1;
        }
        totalCalls[serviceId] = total;
        successCalls[serviceId] = succeeded;

        _pushAttestation(
            serviceId,
            Attestation({
                paymentTxHash: paymentTxHash,
                success: success,
                timestamp: _nowMs()
            })
        );

        emit AttestationRecorded(serviceId, paymentTxHash, success, total, succeeded);
    }

    /// @notice Toggle a service's discovery flag. Owner only — the attestor may NOT.
    function setActive(uint64 serviceId, bool active) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.active = active;
        emit ServiceStatusChanged(serviceId, active);
    }

    /// @notice Rotate the authorised attestor. Owner only. Lets an owner replace a
    ///         compromised middleware signer without re-registering (which would
    ///         mint a new id and reset the score).
    function setAttestor(uint64 serviceId, address attestor) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        if (attestor == address(0) || attestor == s.owner || attestor == s.paymentTarget) {
            revert InvalidAttestor();
        }
        // Fold in any rotation that has already matured, so a second call
        // cannot be used to skip the delay on the first.
        _promoteAttestor(s);
        s.pendingAttestor = attestor;
        s.attestorEffectiveAt = _nowMs() + ATTESTOR_ROTATION_DELAY_MS;
        emit ServiceAttestorChanged(serviceId, attestor);
    }

    /// @notice Who may attest right now, accounting for a matured rotation that
    ///         no write has folded in yet.
    function effectiveAttestor(uint64 serviceId) external view returns (address) {
        Service storage s = _loadService(serviceId);
        if (s.attestorEffectiveAt != 0 && _nowMs() >= s.attestorEffectiveAt) {
            return s.pendingAttestor;
        }
        return s.attestor;
    }

    /// Rotation is DELAYED, not immediate, and this is load-bearing. An instant
    /// rotation let the owner front-run a pending failure attestation: the
    /// attestor's tx reverts NotAuthorized, nothing is written, and the failure
    /// disappears — the same censorship the `active` flag used to allow. A mere
    /// grace period for the outgoing attestor is not enough either, because the
    /// owner simply rotates twice. Keeping the INCUMBENT authoritative until
    /// the delay elapses is what makes an in-flight attestation unrevocable.
    ///
    /// The cost is that replacing a compromised signer takes the delay. That is
    /// bounded: an attestor can only score settlements that actually happened.
    function _promoteAttestor(Service storage s) internal {
        if (s.attestorEffectiveAt != 0 && _nowMs() >= s.attestorEffectiveAt) {
            s.attestor = s.pendingAttestor;
            s.pendingAttestor = address(0);
            s.attestorEffectiveAt = 0;
        }
    }

    /// @notice (totalCalls, successCalls). (0, 0) for unknown or unattested services.
    function getScore(uint64 serviceId)
        external
        view
        returns (uint64 total, uint64 success)
    {
        return (totalCalls[serviceId], successCalls[serviceId]);
    }

    /// @notice The last (up to) MAX_ATTESTATIONS attestations, NEWEST FIRST.
    ///         Empty for unknown services.
    function getAttestations(uint64 serviceId)
        external
        view
        returns (Attestation[] memory out)
    {
        Attestation[] storage list = _attestations[serviceId];
        uint256 n = list.length;
        out = new Attestation[](n);
        if (n == 0) return out;
        uint256 head = _attHead[serviceId];
        for (uint256 i = 0; i < n; i++) {
            // newest sits at head-1; walk backwards, wrapping within n.
            out[i] = list[(head + n - 1 - i) % n];
        }
    }

    /// Append into the ring: grow until the cap, then overwrite the oldest slot.
    /// Constant-cost per call — a ring buffer, so no O(n) storage shifting.
    function _pushAttestation(uint64 serviceId, Attestation memory a) internal {
        Attestation[] storage list = _attestations[serviceId];
        if (list.length < MAX_ATTESTATIONS) {
            list.push(a);
        } else {
            list[_attHead[serviceId]] = a;
        }
        _attHead[serviceId] = (_attHead[serviceId] + 1) % MAX_ATTESTATIONS;
    }

    /// Internal: read a service or revert ServiceNotFound.
    /// A never-registered id has owner == address(0), which registerService can
    /// never produce (msg.sender is never the zero address).
    function _loadService(uint64 serviceId) internal view returns (Service storage s) {
        s = _services[serviceId];
        if (s.owner == address(0)) revert ServiceNotFound();
    }

    /// The service's listed price in native OG. Reverts when the service has
    /// no native option — such a service cannot be settled by PaymentRouter at
    /// all, so it must not be scoreable through it either.
    function _nativePrice(Service storage s) internal view returns (uint256) {
        uint256 n = s.accepts.length;
        for (uint256 i = 0; i < n; i++) {
            if (s.accepts[i].asset == address(0)) return s.accepts[i].amount;
        }
        revert NoNativeOption();
    }

    /// The dust floor for one payment option, in that option's own atomic
    /// units: 1e-6 of a whole unit. For 18 decimals this is exactly
    /// MIN_PRICE_WEI. Comparing every asset against the 18-decimal constant
    /// made a 6-decimal token unregistrable below 1,000,000 whole tokens.
    function _minPrice(uint8 decimals) internal pure returns (uint256) {
        if (decimals > 36) revert InvalidPrice();
        uint256 floorAmt = (10 ** uint256(decimals)) / 1_000_000;
        return floorAmt == 0 ? 1 : floorAmt;
    }

    /// Block time in MILLISECONDS — the unit every off-chain reader expects.
    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }

    /// True when `s` is empty or contains only ASCII spaces/tabs/newlines —
    /// mirrors Rust's `str::trim().is_empty()` for the inputs this accepts.
    function _isBlank(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c != 0x20 && c != 0x09 && c != 0x0a && c != 0x0d) return false;
        }
        return true;
    }
}
