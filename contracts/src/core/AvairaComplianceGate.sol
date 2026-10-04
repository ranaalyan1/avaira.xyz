// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {CVIStatus, CVICredential, IAvairaComplianceGate} from "../interfaces/IAvairaComplianceGate.sol";

/// @title AvairaComplianceGate — Cleanverse CVI/CVA compliance gate
/// @notice Binds Cleanverse Verified Identity (CVI) to Cleanverse Verified Asset (CVA)
///         movement. Identity verification is **structurally coupled** to asset movement:
///         `AvairaCVA._update` calls `gateCVATransfer` inside every mint/transfer/burn, and
///         that call reverts unless BOTH counterparties hold a valid, wallet-bound CVI
///         credential. There is no code path in which a CVA balance changes without an
///         on-chain identity check — it is not an optional wrapper.
///
///         Travel Rule: the originator AND the beneficiary must be identity-verified.
///         Originator-only checks (the common ERC-3643-style implementation) let an
///         agent send value to an unverified wallet and launder the proceeds; here the
///         transfer reverts with `CVI_MISSING` on either side.
///
///         Credentials are wallet-bound and issuer-signed: a whitelisted Cleanverse
///         issuer signs an EIP-712 `CVIClaim{,Short}` over (wallet, credentialHash,
///         [expiry], nonce) after the CCP API has verified the entity. The credential
///         can be submitted by anyone (the Avaira CVI service does), because the
///         signature — not the submitter — is what authorises the binding.
contract AvairaComplianceGate is AccessControl, EIP712, IAvairaComplianceGate {
    using ECDSA for bytes32;

    /* --------------------------------- errors -------------------------------- */

    /// @notice `wallet` has no CVI credential at all.
    error CVI_MISSING(address wallet);
    /// @notice `wallet`'s CVI credential expired at `expiry`.
    error CVI_EXPIRED(address wallet, uint64 expiry);
    /// @notice `wallet`'s CVI credential was revoked by its issuer.
    error CVI_REVOKED(address wallet);
    /// @notice The issuer signature did not recover to a whitelisted issuer.
    error CVI_UNKNOWN_ISSUER(address recovered);
    /// @notice The supplied nonce is not the wallet's current credential nonce.
    error CVI_NONCE_MISMATCH(uint256 expected, uint256 provided);
    /// @notice The issuer asked for an expiry the gate will not accept.
    error CVI_INVALID_EXPIRY(uint64 expiry);
    error ZeroAddress();
    error ZeroCredentialHash();

    /* -------------------------------- constants ------------------------------- */

    /// @notice Role allowed to sign (and revoke) CVI credentials.
    bytes32 public constant ISSUER_ROLE = keccak256("AVAIRA_CVI_ISSUER");
    /// @notice Role allowed to submit credentials on behalf of an issuer.
    bytes32 public constant VERIFIER_ROLE = keccak256("AVAIRA_CVI_VERIFIER");

    /// @dev Canonical claim: the issuer attests (wallet, credentialHash) at a given nonce.
    ///      The TTL is gate policy (`defaultValidity`), so the signature stays valid
    ///      regardless of which block lands it.
    bytes32 public constant CVI_CLAIM_SHORT_TYPEHASH =
        keccak256("CVIClaimShort(address wallet,bytes32 credentialHash,uint256 nonce)");

    /// @dev Extended claim: issuer-chosen expiry (CCP KYC validity), same nonce replay guard.
    bytes32 public constant CVI_CLAIM_TYPEHASH =
        keccak256("CVIClaim(address wallet,bytes32 credentialHash,uint64 expiry,uint256 nonce)");

    /// @dev Action namespace that forces a CVI check in the intent gate: the ASCII prefix `cva.`.
    bytes4 private constant CVA_PREFIX = 0x6376612e;
    /// @dev Bound on issuer-chosen TTLs: 1 minute .. 10 years.
    uint64 private constant MIN_VALIDITY = 60;
    uint64 private constant MAX_VALIDITY = 10 * 365 days;

    /* ---------------------------------- state --------------------------------- */

    mapping(address wallet => CVICredential) private _credentials;
    /// @notice Monotonic nonce consumed per credential; prevents signature replay.
    mapping(address wallet => uint256) public credentialNonce;
    /// @notice Whitelisted Cleanverse issuer addresses.
    mapping(address issuer => bool) public isIssuer;
    /// @notice TTL applied by the canonical `verifyCVI` path.
    uint64 public defaultValidity;
    /// @notice Number of CVA movements the gate has allowed (Telemetry for the dashboard).
    uint256 public gatedTransferCount;

    /* ------------------------------- constructor ------------------------------ */

    /// @param admin Protocol admin (also granted `ISSUER_ROLE`).
    /// @param issuer Initial Cleanverse issuer signer (may be zero to set later).
    /// @param defaultValidity_ TTL for credentials registered without an explicit expiry.
    constructor(address admin, address issuer, uint64 defaultValidity_) EIP712("AvairaComplianceGate", "1") {
        if (admin == address(0)) revert ZeroAddress();
        if (defaultValidity_ < MIN_VALIDITY || defaultValidity_ > MAX_VALIDITY) revert CVI_INVALID_EXPIRY(defaultValidity_);

        defaultValidity = defaultValidity_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        emit DefaultValidityUpdated(0, defaultValidity_);

        if (issuer != address(0)) {
            isIssuer[issuer] = true;
            _grantRole(ISSUER_ROLE, issuer);
            emit IssuerUpdated(issuer, true);
        }
    }

    /* ------------------------------ verification ------------------------------ */

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Permissionless submission: the issuer signature is the authorisation, and the
    ///      per-wallet nonce makes each signature single-use.
    function verifyCVI(address wallet, bytes calldata issuerSignature, bytes32 credentialHash) public override {
        uint256 nonce = credentialNonce[wallet];
        if (credentialHash == bytes32(0)) revert ZeroCredentialHash();
        address issuer = _recoverIssuer(
            keccak256(abi.encode(CVI_CLAIM_SHORT_TYPEHASH, wallet, credentialHash, nonce)), issuerSignature
        );
        _store(wallet, credentialHash, _expiryFromNow(defaultValidity), issuer, nonce);
    }

    /// @inheritdoc IAvairaComplianceGate
    function verifyCVIWithExpiry(
        address wallet,
        bytes calldata issuerSignature,
        bytes32 credentialHash,
        uint64 expiry,
        uint256 nonce
    ) external override {
        if (credentialHash == bytes32(0)) revert ZeroCredentialHash();
        if (nonce != credentialNonce[wallet]) revert CVI_NONCE_MISMATCH(credentialNonce[wallet], nonce);
        // Signature deadlines are time-based by design.
        // forge-lint: disable-next-line(block-timestamp)
        if (expiry <= block.timestamp || expiry > _expiryFromNow(MAX_VALIDITY)) revert CVI_INVALID_EXPIRY(expiry);

        address issuer =
            _recoverIssuer(keccak256(abi.encode(CVI_CLAIM_TYPEHASH, wallet, credentialHash, expiry, nonce)), issuerSignature);
        _store(wallet, credentialHash, expiry, issuer, nonce);
    }

    /// @inheritdoc IAvairaComplianceGate
    function revokeCVI(address wallet) external override {
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0)) revert CVI_MISSING(wallet);

        bool allowed = hasRole(ISSUER_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
            || msg.sender == credential.issuer;
        require(allowed, "AvairaCVI: not an issuer");

        credential.status = CVIStatus.REVOKED;
        emit CVIRevoked(wallet, credential.credentialHash);
    }

    /* ---------------------------------- gate ---------------------------------- */

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Called from `AvairaCVA._update`. Reverts (and therefore rolls back the whole
    ///      token movement) when either side is unverified.
    function gateCVATransfer(address from, address to, uint256 amount) external override {
        _requireVerified(from);
        _requireVerified(to);
        unchecked {
            gatedTransferCount += 1;
        }
        emit CVATransferGated(from, to, amount, true);
    }

    /// @notice Non-reverting variant for integrators that want to branch on the result.
    function tryGateCVATransfer(address from, address to, uint256 amount) external returns (bool allowed) {
        if (!isCVIValid(from) || !isCVIValid(to)) return false;
        unchecked {
            gatedTransferCount += 1;
        }
        emit CVATransferGated(from, to, amount, true);
        return true;
    }

    /// @inheritdoc IAvairaComplianceGate
    function requireVerified(address wallet) public view override {
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0) || credential.status == CVIStatus.NONE) revert CVI_MISSING(wallet);
        if (credential.status == CVIStatus.REVOKED) revert CVI_REVOKED(wallet);
        // forge-lint: disable-next-line(block-timestamp)
        if (credential.status == CVIStatus.EXPIRED || credential.expiry <= block.timestamp) {
            revert CVI_EXPIRED(wallet, credential.expiry);
        }
    }

    /// @inheritdoc IAvairaComplianceGate
    function previewGateCVATransfer(address from, address to, uint256)
        external
        view
        override
        returns (bool allowed, CVIStatus fromStatus, CVIStatus toStatus, address blockingWallet)
    {
        fromStatus = credentialStatusOf(from);
        toStatus = credentialStatusOf(to);
        bool fromOk = fromStatus == CVIStatus.VALID;
        bool toOk = toStatus == CVIStatus.VALID;
        allowed = fromOk && toOk;
        if (!fromOk) return (allowed, fromStatus, toStatus, from);
        if (!toOk) return (allowed, fromStatus, toStatus, to);
        return (allowed, fromStatus, toStatus, address(0));
    }

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Emitted by the CVI service (or the dashboard) after a reverting transfer, so the
    ///      denial is still explorer-visible: EVM logs are rolled back with the revert.
    function recordGatedTransfer(address from, address to, uint256 amount, bool allowed) external override {
        emit CVATransferGated(from, to, amount, allowed);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @inheritdoc IAvairaComplianceGate
    function isCVIValid(address wallet) public view override returns (bool) {
        return credentialStatusOf(wallet) == CVIStatus.VALID;
    }

    /// @inheritdoc IAvairaComplianceGate
    function credentialOf(address wallet) external view override returns (CVICredential memory) {
        CVICredential memory credential = _credentials[wallet];
        // forge-lint: disable-next-line(block-timestamp)
        if (credential.status == CVIStatus.VALID && credential.expiry <= block.timestamp) {
            credential.status = CVIStatus.EXPIRED;
        }
        return credential;
    }

    /// @inheritdoc IAvairaComplianceGate
    function credentialStatusOf(address wallet) public view override returns (CVIStatus) {
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0)) return CVIStatus.NONE;
        if (credential.status == CVIStatus.REVOKED) return CVIStatus.REVOKED;
        // forge-lint: disable-next-line(block-timestamp)
        if (credential.status == CVIStatus.EXPIRED || credential.expiry <= block.timestamp) return CVIStatus.EXPIRED;
        return CVIStatus.VALID;
    }

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Namespace rule used by `AvairaIntentVault.checkGate`: any committed action whose
    ///      name starts with `cva.` (cva.transfer, cva.settle, cva.mint, ...) forces a
    ///      wallet-bound identity check on the wallets executing the intent.
    function requiresCVI(string calldata action) external pure override returns (bool) {
        bytes calldata raw = bytes(action);
        if (raw.length < 4) return false;
        return bytes4(raw[0]) | (bytes4(raw[1]) >> 8) | (bytes4(raw[2]) >> 16) | (bytes4(raw[3]) >> 24) == CVA_PREFIX;
    }

    /// @notice EIP-712 digest the issuer must sign for the canonical 3-argument `verifyCVI`.
    function hashCVIClaim(address wallet, bytes32 credentialHash, uint256 nonce) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CVI_CLAIM_SHORT_TYPEHASH, wallet, credentialHash, nonce)));
    }

    /// @notice EIP-712 digest for the issuer-expiry variant.
    function hashCVIClaimWithExpiry(address wallet, bytes32 credentialHash, uint64 expiry, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CVI_CLAIM_TYPEHASH, wallet, credentialHash, expiry, nonce)));
    }

    /* ---------------------------------- admin --------------------------------- */

    /// @notice Adds or removes a Cleanverse issuer signer.
    function setIssuer(address issuer, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (issuer == address(0)) revert ZeroAddress();
        isIssuer[issuer] = allowed;
        if (allowed) {
            _grantRole(ISSUER_ROLE, issuer);
        } else {
            _revokeRole(ISSUER_ROLE, issuer);
        }
        emit IssuerUpdated(issuer, allowed);
    }

    /// @notice Updates the TTL applied by the canonical `verifyCVI` path.
    function setDefaultValidity(uint64 newValidity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newValidity < MIN_VALIDITY || newValidity > MAX_VALIDITY) revert CVI_INVALID_EXPIRY(newValidity);
        emit DefaultValidityUpdated(defaultValidity, newValidity);
        defaultValidity = newValidity;
    }

    /* -------------------------------- internals ------------------------------- */

    function _store(address wallet, bytes32 credentialHash, uint64 expiry, address issuer, uint256 nonce) private {
        if (wallet == address(0)) revert ZeroAddress();
        _credentials[wallet] = CVICredential({
            wallet: wallet,
            credentialHash: credentialHash,
            expiry: expiry,
            status: CVIStatus.VALID,
            issuer: issuer,
            verifiedAt: uint64(block.timestamp)
        });
        credentialNonce[wallet] = nonce + 1;
        emit CVIVerified(wallet, credentialHash, expiry);
    }

    function _recoverIssuer(bytes32 structHash, bytes calldata signature) private view returns (address issuer) {
        issuer = _hashTypedDataV4(structHash).recover(signature);
        if (!isIssuer[issuer] || !hasRole(ISSUER_ROLE, issuer)) revert CVI_UNKNOWN_ISSUER(issuer);
    }

    // forge-lint: disable-next-line(block-timestamp)
    function _expiryFromNow(uint64 validity) private view returns (uint64) {
        return uint64(block.timestamp) + validity;
    }

    function _requireVerified(address wallet) private view {
        if (!isCVIValid(wallet)) {
            CVICredential storage credential = _credentials[wallet];
            if (credential.wallet == address(0)) revert CVI_MISSING(wallet);
            if (credential.status == CVIStatus.REVOKED) revert CVI_REVOKED(wallet);
            revert CVI_EXPIRED(wallet, credential.expiry);
        }
    }
}
