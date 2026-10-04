// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cleanverse Verified Identity (CVI) status for a wallet.
/// @dev `NONE` means no credential was ever registered. `EXPIRED` and `REVOKED`
///      are terminal for the *current* credential but recoverable: a fresh
///      `verifyCVI` call always overwrites the record.
enum CVIStatus {
    NONE,
    VALID,
    EXPIRED,
    REVOKED
}

/// @notice A wallet-bound Cleanverse Verified Identity credential.
/// @param wallet The bound wallet (the only address the credential authorises).
/// @param credentialHash keccak256 of the off-chain CCP identity payload + result.
/// @param expiry Unix seconds after which the credential stops authorising transfers.
/// @param status Current status (VALID/EXPIRED/REVOKED).
/// @param issuer Address of the Cleanverse issuer that signed the credential.
/// @param verifiedAt Unix seconds of registration/refresh.
struct CVICredential {
    address wallet;
    bytes32 credentialHash;
    uint64 expiry;
    CVIStatus status;
    address issuer;
    uint64 verifiedAt;
}

/// @title IAvairaComplianceGate
/// @notice The Cleanverse CVI/CVA compliance surface: wallet-bound identity verification
///         that CVA (Cleanverse Verified Asset) movement is *structurally* coupled to.
/// @dev Structurally coupled, not advisory: `AvairaCVA._update` calls
///      `gateCVATransfer` on every mint, transfer and burn, so a CVA balance cannot
///      change unless **both** counterparties hold a valid, wallet-bound CVI
///      credential. This is the Travel Rule pattern — originator *and* beneficiary
///      must be identity-verified — enforced by the token itself rather than by an
///      optional wrapper contract.
interface IAvairaComplianceGate {
    /// @notice Emitted when a wallet's CVI credential is registered or refreshed.
    event CVIVerified(address indexed wallet, bytes32 credentialHash, uint256 expiry);
    /// @notice Emitted when an issuer revokes a wallet's credential.
    event CVIRevoked(address indexed wallet, bytes32 credentialHash);
    /// @notice Emitted for every gated CVA movement, allowed or not.
    event CVATransferGated(address indexed from, address indexed to, uint256 amount, bool allowed);
    /// @notice Emitted when the issuer set or the credential TTL policy changes.
    event IssuerUpdated(address indexed issuer, bool allowed);
    /// @notice Emitted when the default credential validity changes.
    event DefaultValidityUpdated(uint64 previousValidity, uint64 newValidity);

    /// @notice Registers or refreshes a wallet-bound CVI credential from an issuer signature.
    /// @param wallet Wallet the credential is bound to (must equal the signed claim).
    /// @param issuerSignature EIP-712 `CVIClaimShort` signature from a whitelisted issuer.
    /// @param credentialHash keccak256 of the CCP identity verification result.
    function verifyCVI(address wallet, bytes calldata issuerSignature, bytes32 credentialHash) external;

    /// @notice Registers a credential with an issuer-chosen expiry (EIP-712 `CVIClaim`).
    function verifyCVIWithExpiry(
        address wallet,
        bytes calldata issuerSignature,
        bytes32 credentialHash,
        uint64 expiry,
        uint256 nonce
    ) external;

    /// @notice Revokes `wallet`'s credential. Callable by an issuer or the protocol admin.
    function revokeCVI(address wallet) external;

    /// @notice THE TRANSFER GATE. Reverts unless both sides hold a valid CVI credential.
    /// @dev Called by `AvairaCVA` from `_update`, i.e. inside every transfer/mint/burn.
    function gateCVATransfer(address from, address to, uint256 amount) external;

    /// @notice Reverts unless `wallet` holds a valid, unexpired, unrevoked CVI credential.
    function requireVerified(address wallet) external view;

    /// @notice Non-reverting preview of a gated transfer (used by the SDK, bot and dashboard).
    function previewGateCVATransfer(address from, address to, uint256 amount)
        external
        view
        returns (bool allowed, CVIStatus fromStatus, CVIStatus toStatus, address blockingWallet);

    /// @notice Records a blocked transfer attempt onchain so denials are explorer-visible.
    /// @dev Mirrors `AvairaIntentVault.recordGateDecision`: the reverting path cannot emit,
    ///      so the gateway/service writes the denial trace here instead.
    function recordGatedTransfer(address from, address to, uint256 amount, bool allowed) external;

    /// @notice True when `wallet` currently holds a valid CVI credential.
    function isCVIValid(address wallet) external view returns (bool);

    /// @notice Full credential record for `wallet`.
    function credentialOf(address wallet) external view returns (CVICredential memory);

    /// @notice Effective status of `wallet`, accounting for expiry at the current timestamp.
    function credentialStatusOf(address wallet) external view returns (CVIStatus);

    /// @notice True when `action` is a CVA action that requires CVI verification.
    function requiresCVI(string calldata action) external pure returns (bool);

    /// @notice Per-wallet nonce consumed by each verified credential (anti-replay).
    function credentialNonce(address wallet) external view returns (uint256);

    /// @notice TTL applied by the canonical `verifyCVI(address,bytes,bytes32)` path.
    function defaultValidity() external view returns (uint64);
}
