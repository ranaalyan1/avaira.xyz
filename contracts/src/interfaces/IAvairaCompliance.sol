// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAvairaCompliance — Cleanverse CVI/CVA compliance surface
/// @notice Travel-Rule style identity gating for Cleanverse Verified Assets (CVA):
///         asset movement is structurally coupled to Cleanverse Verified Identity (CVI).
///         A CVA transfer contract calls `gateCVATransfer` before moving value and
///         reverts unless BOTH the originator and the beneficiary hold a valid,
///         wallet-bound CVI credential issued by the configured Cleanverse issuer.

/// @notice Effective state of a wallet's CVI credential.
/// @dev NONE = no credential was ever registered for the wallet (=> CVI_MISSING).
///      EXPIRED is derived from `expiry`, never stored; stored statuses are
///      VALID or REVOKED.
enum CVIStatus {
    NONE, // 0 — no CVI credential registered
    VALID, // 1 — credential present and unexpired
    EXPIRED, // 2 — credential present but past its expiry
    REVOKED // 3 — credential revoked by issuer/admin
}

struct CVICredential {
    /// @notice Wallet the credential is bound to (the credential subject).
    address wallet;
    /// @notice keccak256 commitment to the offchain Cleanverse verification result.
    bytes32 credentialHash;
    /// @notice Unix timestamp after which the credential is no longer valid.
    uint64 expiry;
    /// @notice Stored status (VALID or REVOKED; EXPIRED is derived from `expiry`).
    CVIStatus status;
    /// @notice Cleanverse issuer address whose signature attested this credential.
    address issuer;
    /// @notice Unix timestamp of the last (re-)verification.
    uint64 verifiedAt;
}

interface IAvairaComplianceGate {
    /* --------------------------------- events -------------------------------- */

    /// @notice A CVI credential was registered or refreshed for `wallet`.
    event CVIVerified(address indexed wallet, bytes32 credentialHash, uint256 expiry);
    /// @notice A CVI credential was revoked.
    event CVIRevoked(address indexed wallet, address indexed revoker);
    /// @notice A CVA transfer passed the compliance gate (it reverts when not allowed).
    event CVATransferGated(address indexed from, address indexed to, uint256 amount, bool allowed);
    /// @notice The Cleanverse issuer address changed.
    event IssuerUpdated(address indexed previousIssuer, address indexed newIssuer);

    /* --------------------------------- errors -------------------------------- */

    /// @notice No CVI credential was ever registered for `wallet`.
    error CVI_MISSING(address wallet);
    /// @notice The CVI credential of `wallet` expired at `expiredAt`.
    error CVI_EXPIRED(address wallet, uint64 expiredAt);
    /// @notice The CVI credential of `wallet` was revoked.
    error CVI_REVOKED(address wallet);
    /// @notice The issuer signature over the credential did not validate.
    error InvalidIssuerSignature(address wallet, address expectedIssuer);
    /// @notice Credential parameters failed basic validation.
    error InvalidCredential();

    /* -------------------------------- mutations ------------------------------ */

    /// @notice Registers or refreshes a wallet-bound CVI credential.
    /// @dev `issuerSignature` is the configured Cleanverse issuer's EIP-191
    ///      personal signature over `keccak256(abi.encode(wallet, credentialHash, expiry))`,
    ///      which binds the credential to the wallet, its content hash and its expiry.
    function verifyCVI(address wallet, bytes32 credentialHash, uint64 expiry, bytes calldata issuerSignature) external;

    /// @notice Revokes `wallet`'s credential (issuer or admin only).
    function revokeCVI(address wallet) external;

    /* --------------------------------- gating -------------------------------- */

    /// @notice Travel-Rule gate for a CVA transfer or settlement.
    /// @dev Reverts with CVI_MISSING / CVI_EXPIRED / CVI_REVOKED naming the failing
    ///      party when EITHER the originator or the beneficiary lacks a valid CVI.
    ///      CVA transfer/settlement contracts MUST call this before moving value.
    function gateCVATransfer(address from, address to, uint256 amount) external;

    /// @notice Non-reverting view over `gateCVATransfer` for SDKs and dashboards.
    /// @return allowed True when both parties hold valid CVI credentials.
    /// @return failing The first party lacking a valid credential (zero address when allowed).
    /// @return reason   Effective CVIStatus of the failing party (NONE when allowed).
    function checkCVATransfer(address from, address to) external view returns (bool allowed, address failing, CVIStatus reason);

    /* ---------------------------------- views -------------------------------- */

    /// @notice Full credential record for `wallet`.
    function credentialOf(address wallet) external view returns (CVICredential memory);

    /// @notice Effective CVI status of `wallet` (NONE/VALID/EXPIRED/REVOKED).
    function statusOf(address wallet) external view returns (CVIStatus);

    /// @notice True when `wallet` holds a valid, unexpired, unrevoked CVI credential.
    function isWalletVerified(address wallet) external view returns (bool);

    /// @notice True when every wallet in `wallets` holds a valid CVI credential.
    /// @return ok True when all wallets are CVI-verified.
    /// @return failing The first wallet without a valid credential (zero address when all pass).
    function checkWallets(address[] calldata wallets) external view returns (bool ok, address failing);

    /// @notice The Cleanverse issuer whose signatures attest CVI credentials.
    function issuer() external view returns (address);
}
