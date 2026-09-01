// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PaymentRouter — binds an x402 invoice nonce to an on-chain payment
/// @notice A plain EVM value transfer carries no invoice reference, so nothing binds a payment
///         to the 402 invoice that requested it. EVM native transfers carry no
///         such field, so payments are routed through this contract instead:
///         `pay()` forwards the full value to the seller and emits `Paid` with
///         the invoice nonce indexed, which is what the gateway matches on.
///         The router never custodies funds — value in, value straight out.
contract PaymentRouter {
    error ZeroAmount();
    error ZeroPayTo();
    error DuplicateNonce();
    error TransferFailed();

    /// @notice Emitted on every settled payment. `serviceId` and `nonce` are
    ///         indexed so the gateway's verification is a single exact-match
    ///         eth_getLogs — no block scanning, no external indexer.
    event Paid(
        uint64 indexed serviceId,
        uint256 indexed nonce,
        address indexed payer,
        address payTo,
        uint256 amount,
        uint64 timestamp // unix MS
    );

    /// keccak(serviceId, nonce, payer) => already paid? On-chain replay guard,
    /// in addition to the gateway's own single-use invoice burn.
    ///
    /// The key includes the payer deliberately. Keyed on (serviceId, nonce)
    /// alone, ANY address could burn ANY invoice for 1 wei — front-run the
    /// buyer, and their real payment reverts DuplicateNonce with no way to
    /// re-settle that invoice. Binding the key to msg.sender makes a griefer
    /// able to burn only their own slot. Two honest payers racing the same
    /// nonce is harmless: the gateway burns the invoice in its own store before
    /// it proxies, so only one of them is ever served.
    mapping(bytes32 => bool) public seenNonce;

    /// @notice The `seenNonce` key for a (serviceId, nonce, payer) triple.
    function nonceKey(uint64 serviceId, uint256 nonce, address payer)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(serviceId, nonce, payer));
    }

    /// @notice Pay a service's 402 invoice. The whole `msg.value` is forwarded
    ///         to `payTo`; the nonce is burned so the same invoice can never
    ///         settle twice.
    function pay(uint64 serviceId, uint256 nonce, address payTo) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (payTo == address(0)) revert ZeroPayTo();

        bytes32 key = nonceKey(serviceId, nonce, msg.sender);
        if (seenNonce[key]) revert DuplicateNonce();

        // Checks-effects-interactions: burn the nonce before the outbound call.
        // A failed transfer reverts the whole tx, which also rolls this back —
        // the nonce stays spendable, as test_pay_nonceStaysUnburned asserts.
        seenNonce[key] = true;

        (bool ok, ) = payTo.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Paid(
            serviceId, nonce, msg.sender, payTo, msg.value, uint64(block.timestamp) * 1000
        );
    }
}
