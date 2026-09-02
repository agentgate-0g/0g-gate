// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PaymentRouter} from "./PaymentRouter.sol";

/// @title AgentGateRegistry — service discovery + payment-attestation reputation
/// @notice Service registry + payment-attestation reputation ledger.
///         Semantics are preserved exactly: 1-based ids, caller becomes owner,
///         services start active, attestations are deduped per payment tx, and
///         all timestamps are UNIX MILLISECONDS (block.timestamp * 1000) because
///         every off-chain reader is contracted on ms.
///
///         Two classes of mutation live here and they are deliberately not
///         alike. Anything that only describes the service — its URL, its
///         discovery flag, who owns it — moves the instant the owner says so.
///         The MONEY TERMS (who gets paid, and how much) move on a delay,
///         because a buyer is quoted them in a 402 and then pays them in a
///         separate transaction: see TERMS_CHANGE_DELAY_MS below.
contract AgentGateRegistry {
    /// The router whose settlements back this registry's attestations.
    PaymentRouter public immutable ROUTER;

    constructor(PaymentRouter router) {
        ROUTER = router;
    }

    /// Minimum price for any accepted option, in the asset's atomic units.
    /// 1e12 wei = 1e-6 OG. A floor, not a fee: it keeps a service from being
    /// registered at a price so small that the gas to pay it dwarfs the payment.
    ///
    /// This constant is the SOURCE of the floor, not a description of it —
    /// `_minPrice` derives every asset's floor from it rather than restating
    /// the number. When the two were written down separately, a change to the
    /// constant moved what the contract advertised and left what it enforced
    /// exactly where it was, and nothing in the world would have said so.
    uint256 public constant MIN_PRICE_WEI = 1e12;

    /// Per-service attestation ring-buffer capacity (keep the newest 100).
    uint256 public constant MAX_ATTESTATIONS = 100;

    /// Longest price list a service may publish.
    ///
    /// The seller alone decides how long `accepts[]` is, and everyone else
    /// walks it: the gateway prices a 402 from it, `_listedNativePrice` scans
    /// it on the settlement path, and `getService` returns every byte of it to
    /// whoever asked. Uncapped, a seller could publish a list long enough to
    /// make reading its own record cost more gas than any caller is willing to
    /// spend — a denial of service the seller inflicts on its own buyers, for
    /// free, and one the registry can never undo because the record is
    /// already written. 16 is far above any real price list.
    uint256 public constant MAX_PAYMENT_OPTIONS = 16;

    /// How long an attestor rotation waits before it takes effect.
    uint64 public constant ATTESTOR_ROTATION_DELAY_MS = 15 * 60 * 1000;

    /// How long a change to the MONEY TERMS — the payout target or the price
    /// list — waits before it takes effect.
    ///
    /// An instant setter moves the terms out from under a buyer who is already
    /// mid-payment. The sequence is not exotic, it is the normal one: the
    /// gateway reads the live record to quote a 402, the buyer signs a payment
    /// for exactly that payee and that amount, and `SpendGuard.debit` then
    /// re-reads the record and demands `payTo == the live target` and
    /// `amount == the live price`. Anything that moved either value in between
    /// turns an honest, already-signed payment into a `WrongPayee` or
    /// `WrongAmount` revert — the buyer is refused for paying precisely what
    /// they were asked for. Making the change wait means the quote a buyer is
    /// holding stays payable for the whole window.
    uint64 public constant TERMS_CHANGE_DELAY_MS = 15 * 60 * 1000;

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
    ///
    /// The queue fields (`pending*`, `*EffectiveAt`, `previous*`) are the
    /// delayed-terms machinery. They are part of the RETURNED record on
    /// purpose: an off-chain reader that can see a rotation is coming can stop
    /// quoting a price it knows is about to expire. `getService` folds any
    /// change that has already matured before it returns, so what a reader
    /// gets is always the terms that are live NOW.
    struct Service {
        string name;
        string description;
        string gatewayBaseUrl;
        PaymentOption[] accepts;
        /// When the queued price list becomes authoritative; 0 = none queued.
        uint64 acceptsEffectiveAt;
        /// The native price the last matured reprice displaced; 0 = never repriced.
        uint256 previousNativePrice;
        address paymentTarget;
        /// Payout rotation target, authoritative only from `paymentTargetEffectiveAt`.
        address pendingPaymentTarget;
        uint64 paymentTargetEffectiveAt; // unix MS, 0 = no rotation pending
        /// The payout address the last matured rotation displaced.
        address previousPaymentTarget;
        address owner;
        /// Offered owner; owns nothing until it calls `acceptOwnership`.
        address pendingOwner;
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
    error TooManyOptions();
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

    /// serviceId => the price list queued by `setAccepts`, live only once
    /// `acceptsEffectiveAt` has passed.
    ///
    /// Kept OUT of the Service struct deliberately. A struct member would ride
    /// along on every `getService`, so each caller would pay to decode a
    /// second seller-controlled array of strings it almost never wants, and
    /// the returned record would then contain two price lists with no way to
    /// tell from the type which of them a 402 should be quoted from.
    mapping(uint64 => PaymentOption[]) private _pendingAccepts;

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
        if (paymentTarget == address(0)) revert InvalidPaymentTarget();
        // The subject of a score cannot be its own witness. Without this the
        // owner names itself attestor in the same call that registers the
        // service, restoring exactly the self-certification the attestor role
        // exists to remove.
        if (attestor == address(0) || attestor == msg.sender || attestor == paymentTarget) {
            revert InvalidAttestor();
        }
        _validateAccepts(accepts);

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
    ///
    /// Every delayed change that has already matured is folded into the
    /// RETURNED COPY, and its queue fields cleared there, even though no
    /// transaction has written it back to storage yet. Without that fold a
    /// matured rotation is invisible to the one reader that most needs to see
    /// it: the gateway prices its 402s from this record, so it would keep
    /// quoting a payee and a price that `settlementTermsOf` — and therefore
    /// `SpendGuard.debit` — have already stopped accepting, and every buyer
    /// following the quote would be refused.
    function getService(uint64 serviceId) external view returns (Service memory out) {
        Service storage s = _loadService(serviceId);
        out = s;

        uint64 nowMs = _nowMs();

        if (out.attestorEffectiveAt != 0 && nowMs >= out.attestorEffectiveAt) {
            out.attestor = out.pendingAttestor;
            out.pendingAttestor = address(0);
            out.attestorEffectiveAt = 0;
        }

        if (out.paymentTargetEffectiveAt != 0 && nowMs >= out.paymentTargetEffectiveAt) {
            out.previousPaymentTarget = out.paymentTarget;
            out.paymentTarget = out.pendingPaymentTarget;
            out.pendingPaymentTarget = address(0);
            out.paymentTargetEffectiveAt = 0;
        }

        if (out.acceptsEffectiveAt != 0 && nowMs >= out.acceptsEffectiveAt) {
            out.previousNativePrice = _listedNativePriceMemory(out.accepts);
            out.accepts = _pendingAccepts[serviceId];
            out.acceptsEffectiveAt = 0;
        }
    }

    /// @notice Everything a settlement path needs about `serviceId`: who to pay
    ///         and the listed native price. One narrow call rather than
    ///         `getService`, whose return size the seller controls.
    ///
    /// Reverts `ServiceInactive` for a paused service. `active` used to gate
    /// discovery and nothing else, so a service its own owner had switched off
    /// was still fully payable through a SpendGuard escrow policy — the kill
    /// switch removed the listing and left the money path wide open. This is
    /// the one read `debit` makes, so refusing it here is what actually stops
    /// the spend.
    function settlementTermsOf(uint64 serviceId)
        external
        view
        returns (address paymentTarget, uint256 nativePrice)
    {
        Service storage s = _loadService(serviceId);
        if (!s.active) revert ServiceInactive();
        return (_effectivePaymentTarget(s), _effectiveNativePrice(serviceId, s));
    }

    /// @notice Just the payout target for `serviceId`, without the rest of the
    ///         record. `getService` returns the whole Service — every string
    ///         and every entry of the seller-controlled `accepts[]` — so a
    ///         caller that only needs the payee would otherwise pay gas
    ///         proportional to how many prices the seller happened to list.
    function paymentTargetOf(uint64 serviceId) external view returns (address) {
        return _effectivePaymentTarget(_loadService(serviceId));
    }

    event AttestationRecorded(
        uint64 indexed serviceId,
        bytes32 indexed paymentTxHash,
        address indexed payer,
        uint256 nonce,
        bool success,
        uint64 totalCalls,
        uint64 successCalls
    );
    event ServiceStatusChanged(uint64 indexed serviceId, bool active);
    event ServiceAttestorChanged(uint64 indexed serviceId, address attestor);
    event ServicePaymentTargetChanged(
        uint64 indexed serviceId, address paymentTarget, uint64 effectiveAt
    );
    event ServiceAcceptsChanged(
        uint64 indexed serviceId, PaymentOption[] accepts, uint64 effectiveAt
    );
    event ServiceGatewayBaseUrlChanged(uint64 indexed serviceId, string gatewayBaseUrl);
    event ServiceOwnershipTransferStarted(
        uint64 indexed serviceId, address indexed from, address indexed to
    );
    event ServiceOwnershipTransferred(
        uint64 indexed serviceId, address indexed from, address indexed to
    );

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

        _requireBackingSettlement(serviceId, s, nonce, payer);

        // Dedup on (serviceId, nonce, payer): one score per settlement,
        // whatever display hash the attestor supplies alongside it.
        bytes32 paymentKey = keccak256(abi.encode(serviceId, nonce, payer));

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

        // `payer` and `nonce` are emitted so an observer can recompute the
        // router settlement key this point was minted against. Without them
        // the event says a score moved and gives no way to check it against
        // the settlement that justified it.
        emit AttestationRecorded(
            serviceId, paymentTxHash, payer, nonce, success, total, succeeded
        );
    }

    /// Every rule that says this settlement really bought a call from THIS
    /// service, at its price, from someone with no stake in its score.
    ///
    /// Kept in its own frame rather than inlined into `recordAttestation`: the
    /// two payees, the amount paid and the two prices are five more live
    /// locals, and with them in scope the function runs out of stack slots
    /// (the same reason `SpendGuard._requireSettlementTerms` sits apart).
    function _requireBackingSettlement(
        uint64 serviceId,
        Service storage s,
        uint256 nonce,
        address payer
    ) internal view {
        address payee = _effectivePaymentTarget(s);
        address displacedPayee = _displacedPaymentTarget(s);

        // Every point must map to a settlement that paid THIS service ITS
        // price. Asking the router only "was this nonce used" was not enough:
        // it is set by one wei sent to any address, including the payer's own,
        // so a perfect score still cost nothing. Querying with our OWN
        // paymentTarget means a payment misdirected anywhere else simply is
        // not found, and the amount check rejects dust.
        uint256 paid =
            ROUTER.settledAmount(ROUTER.settlementKey(serviceId, nonce, payer, payee));

        // On a miss, ask again under the payout address the last rotation
        // displaced. `settledAmount` is keyed on the address that was PAID, so
        // a rotation landing while an invoice was in flight made this lookup
        // miss on a payment that had really been made: the buyer paid the payee
        // they were quoted, the service served the call, and the attestation
        // then reverted NoSuchPayment. The seller silently lost the point for
        // work it had actually done, and nothing anywhere said why. The grace
        // reaches back exactly ONE rotation — far enough to cover every invoice
        // quoted before the change, not so far that every address a service
        // ever paid out to stays attestable forever.
        if (paid == 0 && displacedPayee != address(0)) {
            paid = ROUTER.settledAmount(
                ROUTER.settlementKey(serviceId, nonce, payer, displacedPayee)
            );
        }
        if (paid == 0) revert NoSuchPayment();

        // The same grace on the amount. A buyer who paid the price printed on
        // their invoice must still score after the seller raises it, so the
        // floor is the LOWER of the live price and the one the last matured
        // reprice displaced. `previousNativePrice == 0` means there has never
        // been a reprice, and must NOT be read as "any payment will do" — that
        // reading deletes the Underpaid floor outright for every service that
        // has never changed its price, which is most of them, and a full
        // reputation point then costs one wei.
        uint256 floorWei = _effectiveNativePrice(serviceId, s);
        uint256 displacedPrice = _displacedNativePrice(s);
        if (displacedPrice != 0 && displacedPrice < floorWei) floorWei = displacedPrice;
        if (paid < floorWei) revert Underpaid();

        // On-chain anti-wash-trading, mirroring the gateway's isSelfPayment.
        // Note this stops the literal self-pay, not a sybil paying from a fresh
        // address — that needs the staked attestations on the roadmap.
        // The witness is as interested a party as the owner: without
        // `payer != s.attestor` the attestor pays itself and signs off on it,
        // a self-contained two-call loop needing no sybil at all.
        //
        // The DISPLACED payout address is in the list for the same reason it is
        // in the lookup above: a settlement paid to it is attestable, so that
        // address paying ITSELF is a complete wash trade. Checking only the
        // current payee would leave the loop open for one rotation window,
        // whose timing the owner alone chooses.
        if (
            payer == s.owner || payer == payee || payer == s.attestor
                || (displacedPayee != address(0) && payer == displacedPayee)
        ) {
            revert SelfPayment();
        }
    }

    /// @notice Toggle a service's discovery flag. Owner only — the attestor may NOT.
    function setActive(uint64 serviceId, bool active) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.active = active;
        emit ServiceStatusChanged(serviceId, active);
    }

    /// @notice Change the gateway that fronts this service. Owner only.
    ///         Immediate, unlike the money terms: the URL is not part of any
    ///         quote a buyer is holding, and a seller whose gateway host has
    ///         just died should not have to wait out a delay to point buyers
    ///         somewhere that answers.
    function setGatewayBaseUrl(uint64 serviceId, string calldata url) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.gatewayBaseUrl = url;
        emit ServiceGatewayBaseUrlChanged(serviceId, url);
    }

    /// @notice Rotate the authorised attestor. Owner only. Lets an owner replace a
    ///         compromised middleware signer without re-registering (which would
    ///         mint a new id and reset the score).
    function setAttestor(uint64 serviceId, address attestor) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        // The witness must never be a payee — not the current one, not one the
        // owner has already queued, and not the one a rotation displaced.
        //
        // Only the first is obvious. The queued one matters because the owner
        // controls both queues: name X attestor now, queue the payout to X, and
        // the collision simply arrives when the payout matures — with no
        // further call for anyone to notice. The DISPLACED one matters because
        // `recordAttestation` still honours settlements paid to it, so an
        // attestor sitting on that address can pay itself from a fresh key and
        // sign off on it: the free two-call wash loop `attestor != paymentTarget`
        // exists to prevent, reached one rotation late.
        if (
            attestor == address(0) || attestor == s.owner || attestor == s.paymentTarget
                || attestor == s.pendingPaymentTarget || attestor == s.previousPaymentTarget
        ) {
            revert InvalidAttestor();
        }
        // Fold in any rotation that has already matured, so a second call
        // cannot be used to skip the delay on the first.
        _promoteAttestor(s);
        s.pendingAttestor = attestor;
        s.attestorEffectiveAt = _nowMs() + ATTESTOR_ROTATION_DELAY_MS;
        emit ServiceAttestorChanged(serviceId, attestor);
    }

    /// @notice Queue a new payout address. Owner only; live after
    ///         TERMS_CHANGE_DELAY_MS.
    ///
    /// The registry used to be a one-way door here: `paymentTarget` was
    /// write-once, so a seller whose payout key was compromised had no move
    /// except to register again — a new id, and therefore a score of zero, for
    /// a service that had been earning one for months.
    function setPaymentTarget(uint64 serviceId, address newTarget) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        if (newTarget == address(0)) revert InvalidPaymentTarget();
        // The other direction of the rule `setAttestor` enforces: the witness
        // must not become the payee either. `pendingAttestor` is checked as
        // well because a rotation the owner has already queued is a witness
        // that arrives on its own, with no third call to inspect.
        if (newTarget == s.attestor || newTarget == s.pendingAttestor) {
            revert InvalidPaymentTarget();
        }
        // Fold a rotation that has already MATURED into storage before queueing
        // the next one. Without this the second call simply overwrites the
        // pending slot, and the matured rotation is erased: the live payee
        // snaps back to the previous address, instantly and with no delay — the
        // exact instant terms move this whole mechanism exists to prevent, and
        // now aimed at a buyer who was quoted the NEW payee and is already
        // holding a signed payment to it. The erased rotation is also never
        // recorded in `previousPaymentTarget`, so that in-flight payment stops
        // being attestable too: the buyer pays, the service serves, and the
        // point is lost.
        _promotePaymentTarget(s);
        s.pendingPaymentTarget = newTarget;
        s.paymentTargetEffectiveAt = _nowMs() + TERMS_CHANGE_DELAY_MS;
        emit ServicePaymentTargetChanged(serviceId, newTarget, s.paymentTargetEffectiveAt);
    }

    /// @notice Queue a new price list. Owner only; live after
    ///         TERMS_CHANGE_DELAY_MS.
    ///
    /// Repricing used to mean re-registering, and the score is keyed on
    /// serviceId, so every price change cost a seller its entire reputation.
    /// The list is validated NOW, at the moment it is written, rather than
    /// when it matures: a queued list that fails validation would otherwise
    /// become live automatically and leave the service holding terms the
    /// settlement path refuses, with no transaction anywhere to blame.
    function setAccepts(uint64 serviceId, PaymentOption[] calldata accepts) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        _validateAccepts(accepts);

        // Same fold-before-queue as setPaymentTarget, for the same reason: a
        // matured reprice that the next queue overwrites is a price that snaps
        // back to the old one with no delay at all, under a buyer who is
        // mid-payment at the matured one.
        _promoteAccepts(serviceId, s);

        PaymentOption[] storage queued = _pendingAccepts[serviceId];
        // Clear before writing. `push` alone would leave the tail of a longer
        // previous queue in place, so shortening a price list would silently
        // keep options the seller had just removed — including, at worst, a
        // cheaper one it had deliberately withdrawn.
        delete _pendingAccepts[serviceId];
        for (uint256 i = 0; i < accepts.length; i++) {
            queued.push(accepts[i]);
        }

        s.acceptsEffectiveAt = _nowMs() + TERMS_CHANGE_DELAY_MS;
        emit ServiceAcceptsChanged(serviceId, accepts, s.acceptsEffectiveAt);
    }

    /// @notice Offer ownership of a service to `newOwner`. Owner only.
    ///         `address(0)` withdraws an offer that has not been accepted.
    ///
    /// Two-step on purpose. A one-step transfer hands the service — its
    /// payout address, its attestor, its kill switch — to whatever address was
    /// typed, and a typo is not recoverable: the new "owner" is an address
    /// nobody holds the key to, and every owner-only door on a live,
    /// earning service is shut forever. Requiring the recipient to call
    /// `acceptOwnership` means only an address that can transact can ever
    /// receive one.
    function transferOwnership(uint64 serviceId, address newOwner) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.pendingOwner = newOwner;
        emit ServiceOwnershipTransferStarted(serviceId, msg.sender, newOwner);
    }

    /// @notice Accept an ownership offer made to the caller.
    function acceptOwnership(uint64 serviceId) external {
        Service storage s = _loadService(serviceId);
        // `pendingOwner == address(0)` is checked separately from the sender
        // match so that a withdrawn offer cannot be accepted by anyone: with
        // the match alone, an offer withdrawn by setting the field to zero is
        // still an open offer to address(0).
        if (s.pendingOwner == address(0) || msg.sender != s.pendingOwner) {
            revert NotAuthorized();
        }
        // The fourth door into "the subject is its own witness", and the
        // quietest: `registerService`, `setAttestor` and `setPaymentTarget`
        // all refuse to pair the witness with the seller, and none of them is
        // involved here. The attestor simply accepts the service, and from
        // that moment the address scoring the calls is the address being
        // scored. The pending attestor counts too — otherwise the owner
        // queues a rotation to the heir and hands over, and the collision
        // lands by itself when the rotation matures.
        address witness = _effectiveAttestor(s);
        if (msg.sender == witness || msg.sender == s.pendingAttestor) {
            revert InvalidAttestor();
        }
        address from = s.owner;
        s.owner = msg.sender;
        s.pendingOwner = address(0);
        emit ServiceOwnershipTransferred(serviceId, from, msg.sender);
    }

    /// @notice Who may attest right now, accounting for a matured rotation that
    ///         no write has folded in yet.
    function effectiveAttestor(uint64 serviceId) external view returns (address) {
        return _effectiveAttestor(_loadService(serviceId));
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

    /// The attestor authoritative right now, whether or not a write has folded
    /// a matured rotation in yet.
    function _effectiveAttestor(Service storage s) internal view returns (address) {
        if (s.attestorEffectiveAt != 0 && _nowMs() >= s.attestorEffectiveAt) {
            return s.pendingAttestor;
        }
        return s.attestor;
    }

    /// Fold a matured payout rotation into storage, remembering the address it
    /// displaced so `recordAttestation` can still honour settlements already
    /// paid to it.
    function _promotePaymentTarget(Service storage s) internal {
        if (s.paymentTargetEffectiveAt != 0 && _nowMs() >= s.paymentTargetEffectiveAt) {
            s.previousPaymentTarget = s.paymentTarget;
            s.paymentTarget = s.pendingPaymentTarget;
            s.pendingPaymentTarget = address(0);
            s.paymentTargetEffectiveAt = 0;
        }
    }

    /// The payout address authoritative right now. Mirrors `_effectiveAttestor`:
    /// a matured change is live from the instant it matures, not from whenever
    /// the next write happens to fold it in — otherwise the terms a buyer is
    /// quoted would depend on whether some unrelated transaction had touched
    /// the record since.
    function _effectivePaymentTarget(Service storage s) internal view returns (address) {
        if (s.paymentTargetEffectiveAt != 0 && _nowMs() >= s.paymentTargetEffectiveAt) {
            return s.pendingPaymentTarget;
        }
        return s.paymentTarget;
    }

    /// The payout address the most recent rotation displaced, or address(0) if
    /// none has. When a rotation has matured but not been folded in, the
    /// address STORED as current is the one being displaced — reading
    /// `previousPaymentTarget` in that state would reach a rotation further
    /// back and re-open a payee that should already have expired.
    function _displacedPaymentTarget(Service storage s) internal view returns (address) {
        if (s.paymentTargetEffectiveAt != 0 && _nowMs() >= s.paymentTargetEffectiveAt) {
            return s.paymentTarget;
        }
        return s.previousPaymentTarget;
    }

    /// Fold a matured reprice into storage: the queued list becomes the live
    /// one wholesale, and the native price it displaced is remembered so a
    /// buyer holding an invoice at the old price can still be scored.
    function _promoteAccepts(uint64 serviceId, Service storage s) internal {
        if (s.acceptsEffectiveAt == 0 || _nowMs() < s.acceptsEffectiveAt) return;

        s.previousNativePrice = _listedNativePrice(s.accepts);

        PaymentOption[] storage queued = _pendingAccepts[serviceId];
        uint256 n = queued.length;
        // `delete` before the copy, not a truncation after it: a new list
        // shorter than the live one would otherwise leave the dropped entries
        // in place behind it, and a stale option is a price the gateway will
        // still quote and the settlement path will still honour.
        delete s.accepts;
        for (uint256 i = 0; i < n; i++) {
            s.accepts.push();
            s.accepts[i] = queued[i];
        }
        delete _pendingAccepts[serviceId];
        s.acceptsEffectiveAt = 0;
    }

    /// The native price authoritative right now — the queued list's, once the
    /// reprice has matured, otherwise the live list's.
    function _effectiveNativePrice(uint64 serviceId, Service storage s)
        internal
        view
        returns (uint256)
    {
        if (s.acceptsEffectiveAt != 0 && _nowMs() >= s.acceptsEffectiveAt) {
            return _listedNativePrice(_pendingAccepts[serviceId]);
        }
        return _listedNativePrice(s.accepts);
    }

    /// The native price the most recent reprice displaced, or 0 if there has
    /// never been one. Same reasoning as `_displacedPaymentTarget`: while a
    /// reprice has matured but not been folded in, the price STORED as live is
    /// the one being displaced.
    function _displacedNativePrice(Service storage s)
        internal
        view
        returns (uint256)
    {
        if (s.acceptsEffectiveAt != 0 && _nowMs() >= s.acceptsEffectiveAt) {
            return _listedNativePrice(s.accepts);
        }
        return s.previousNativePrice;
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

    /// Every rule a price list must satisfy, in one place because
    /// `registerService` and `setAccepts` must enforce exactly the same set.
    /// When the checks lived only in `registerService`, `setAccepts` was the
    /// door that let an already-registered service acquire terms the registry
    /// would have refused to create.
    function _validateAccepts(PaymentOption[] calldata accepts) internal pure {
        // A service with no price cannot be quoted at all: the gateway has
        // nothing to put in its 402 and `_listedNativePrice` reverts on the
        // settlement path.
        if (accepts.length == 0) revert InvalidPrice();
        if (accepts.length > MAX_PAYMENT_OPTIONS) revert TooManyOptions();

        bool hasNative = false;
        for (uint256 i = 0; i < accepts.length; i++) {
            if (accepts[i].asset == address(0)) {
                // `decimals` is seller-declared and feeds the floor, so for the
                // one asset the chain actually knows — native OG — pin it.
                // Otherwise declaring `decimals = 0` collapses the floor from
                // 1e12 to 1 wei.
                if (accepts[i].decimals != 18) revert InvalidPrice();
                hasNative = true;
            }
            if (accepts[i].amount < _minPrice(accepts[i].decimals)) revert InvalidPrice();
        }

        // PaymentRouter settles native OG and nothing else. A list without a
        // native option used to register happily and fail much later, inside
        // recordAttestation, where the price lookup reverts — after a buyer had
        // already been quoted a price that no rail in this system can settle.
        if (!hasNative) revert NoNativeOption();
    }

    /// The service's listed price in native OG. Reverts when the list has
    /// no native option — such a service cannot be settled by PaymentRouter at
    /// all, so it must not be scoreable through it either. `_validateAccepts`
    /// makes that unreachable for any list this contract stores; it stays as
    /// the backstop that keeps the two facts from drifting apart.
    function _listedNativePrice(PaymentOption[] storage list)
        internal
        view
        returns (uint256)
    {
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            if (list[i].asset == address(0)) return list[i].amount;
        }
        revert NoNativeOption();
    }

    /// The same read against a memory copy, for `getService`'s fold.
    function _listedNativePriceMemory(PaymentOption[] memory list)
        internal
        pure
        returns (uint256)
    {
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            if (list[i].asset == address(0)) return list[i].amount;
        }
        revert NoNativeOption();
    }

    /// The dust floor for one payment option, in that option's own atomic
    /// units: one millionth of a whole unit, DERIVED from MIN_PRICE_WEI rather
    /// than restated, so the public constant and the enforced rule cannot
    /// drift. For 18 decimals this is exactly MIN_PRICE_WEI. Comparing every
    /// asset against the 18-decimal constant made a 6-decimal token
    /// unregistrable below 1,000,000 whole tokens.
    ///
    /// The `decimals > 36` ceiling is not cosmetic. `decimals` is a
    /// seller-declared number with no on-chain source of truth, and the line
    /// below raises 10 to it: at 78 or more the exponentiation overflows and a
    /// public entry point answers with an arithmetic panic instead of a named
    /// contract error, forever, for anyone who mistypes the field. Below that,
    /// an absurd scale just makes the floor an absurd number, which is a floor
    /// that means nothing.
    function _minPrice(uint8 decimals) internal pure returns (uint256) {
        if (decimals > 36) revert InvalidPrice();
        uint256 perWholeUnit = 1e18 / MIN_PRICE_WEI; // 1e6 — a millionth of a unit
        uint256 floorAmt = (10 ** uint256(decimals)) / perWholeUnit;
        // Below 6 decimals a millionth of a whole unit rounds to zero, and a
        // floor of zero is no floor: clamp to the smallest amount there is.
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
