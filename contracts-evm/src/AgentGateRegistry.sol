// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AgentGateRegistry — service discovery + payment-attestation reputation
/// @notice Service registry + payment-attestation reputation ledger.
///         Semantics are preserved exactly: 1-based ids, caller becomes owner,
///         services start active, attestations are deduped per payment tx, and
///         all timestamps are UNIX MILLISECONDS (block.timestamp * 1000) because
///         every off-chain reader is contracted on ms.
contract AgentGateRegistry {
    /// Minimum price for any accepted option, in the asset's atomic units.
    /// 1e12 wei = 1e-6 OG. A floor, not a fee: it keeps a service from being
    /// registered at a price so small that the gas to pay it dwarfs the payment.
    uint256 public constant MIN_PRICE_WEI = 1e12;

    /// Per-service attestation ring-buffer capacity (keep the newest 100).
    uint256 public constant MAX_ATTESTATIONS = 100;

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
        for (uint256 i = 0; i < accepts.length; i++) {
            if (accepts[i].amount < MIN_PRICE_WEI) revert InvalidPrice();
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
    /// serviceId => paymentTxHash => already attested? Duplicate guard.
    mapping(uint64 => mapping(bytes32 => bool)) public seenPayments;

    /// serviceId => ring buffer of the last MAX_ATTESTATIONS attestations.
    mapping(uint64 => Attestation[]) private _attestations;
    /// serviceId => next write slot in the ring (== oldest entry once full).
    mapping(uint64 => uint256) private _attHead;

    /// @notice Record the outcome of one paid call, identified by the payment tx
    ///         hash. Caller must be the service's attestor or owner.
    function recordAttestation(uint64 serviceId, bytes32 paymentTxHash, bool success)
        external
    {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.attestor && msg.sender != s.owner) revert NotAuthorized();
        if (!s.active) revert ServiceInactive();
        if (seenPayments[serviceId][paymentTxHash]) revert DuplicateAttestation();
        seenPayments[serviceId][paymentTxHash] = true;

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
        s.attestor = attestor;
        emit ServiceAttestorChanged(serviceId, attestor);
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
