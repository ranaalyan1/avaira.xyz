// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IAvairaComplianceGate, CVICredential, CVIStatus} from "../interfaces/IAvairaCompliance.sol";

/// @title AvairaComplianceGate — Cleanverse CVI/CVA compliance gate
/// @notice Identity verification is STRUCTURALLY COUPLED to asset movement: any CVA
///         (Cleanverse Verified Asset) transfer or settlement contract calls
///         `gateCVATransfer` before moving value, and the call reverts unless BOTH
///         the originator and the beneficiary hold a valid, wallet-bound CVI
///         (Cleanverse Verified Identity) credential. This is the Travel Rule
///         pattern — originator AND beneficiary must be identity-verified — and it
///         is enforced inside the transfer path itself, not by an optional wrapper.
///
/// @dev Credentials are registered by the offchain CVI verification service
///      (`services/cvi`), which verifies an entity against the Cleanverse CCP API
///      and submits the issuer-signed credential via `verifyCVI`. The issuer's
///      EIP-191 signature binds wallet + credentialHash + expiry together, so a
///      credential cannot be replayed onto another wallet or forged offchain.
///      `AvairaIntentVault.checkGate` additionally consults this gate for intents
///      whose allowed actions include `cva.transfer` / `cva.settle` (any `cva.*`),
///      rejecting them with `GateReason.CVI_UNVERIFIED` before execution.
contract AvairaComplianceGate is AccessControl, IAvairaComplianceGate {
    /* --------------------------------- errors -------------------------------- */

    error ZeroAddress();
    error CredentialAlreadyExpired(uint64 expiry);
    error NotIssuerOrAdmin(address caller);

    /* -------------------------------- constants ------------------------------- */

    /// @dev EIP-191 personal-message payload the Cleanverse issuer signs:
    ///      keccak256(abi.encode(wallet, credentialHash, expiry)).
    bytes32 private constant CVI_CREDENTIAL_TYPEHASH =
        keccak256("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)");

    /* ---------------------------------- state -------------------------------- */

    /// @notice Cleanverse issuer address whose signatures attest CVI credentials.
    address public override issuer;

    /// @notice Wallet-bound CVI verification results.
    mapping(address wallet => CVICredential) private _credentials;

    /// @notice Number of wallets that currently hold a stored credential (any status).
    uint256 public credentialCount;

    /* ------------------------------- constructor ------------------------------ */

    /// @param issuer_ The Cleanverse issuer address (may be an ERC-1271 smart account).
    /// @param admin   Protocol admin; receives DEFAULT_ADMIN_ROLE.
    constructor(address issuer_, address admin) AccessControl() {
        if (issuer_ == address(0) || admin == address(0)) revert ZeroAddress();
        issuer = issuer_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit IssuerUpdated(address(0), issuer_);
    }

    /* ------------------------------ verification ------------------------------ */

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Validates the issuer signature over `(wallet, credentialHash, expiry)`
    ///      and stores the credential, overwriting any previous one (refresh flow).
    ///      SignatureChecker also accepts ERC-1271 issuer smart accounts.
    function verifyCVI(address wallet, bytes32 credentialHash, uint64 expiry, bytes calldata issuerSignature)
        external
        override
    {
        if (wallet == address(0) || credentialHash == bytes32(0)) revert InvalidCredential();
        // forge-lint: disable-next-line(block-timestamp) -- credential validity is time-based by design
        if (expiry <= block.timestamp) revert CredentialAlreadyExpired(expiry);

        bytes32 payload = keccak256(abi.encode(CVI_CREDENTIAL_TYPEHASH, wallet, credentialHash, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        if (!SignatureChecker.isValidSignatureNow(issuer, digest, issuerSignature)) {
            revert InvalidIssuerSignature(wallet, issuer);
        }

        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0)) credentialCount += 1;

        credential.wallet = wallet;
        credential.credentialHash = credentialHash;
        credential.expiry = expiry;
        credential.status = CVIStatus.VALID;
        credential.issuer = issuer;
        credential.verifiedAt = uint64(block.timestamp);

        emit CVIVerified(wallet, credentialHash, expiry);
    }

    /// @inheritdoc IAvairaComplianceGate
    function revokeCVI(address wallet) external override {
        if (msg.sender != issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotIssuerOrAdmin(msg.sender);
        }
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0) || credential.status == CVIStatus.REVOKED) revert CVI_MISSING(wallet);
        credential.status = CVIStatus.REVOKED;
        emit CVIRevoked(wallet, msg.sender);
    }

    /* --------------------------------- gating --------------------------------- */

    /// @inheritdoc IAvairaComplianceGate
    /// @dev Called by CVA transfer/settlement contracts BEFORE value moves. Reverts
    ///      naming the failing party, so a non-compliant transfer can never settle.
    function gateCVATransfer(address from, address to, uint256 amount) external override {
        _requireVerified(from);
        _requireVerified(to);
        emit CVATransferGated(from, to, amount, true);
    }

    /// @inheritdoc IAvairaComplianceGate
    function checkCVATransfer(address from, address to)
        external
        view
        override
        returns (bool allowed, address failing, CVIStatus reason)
    {
        CVIStatus fromStatus = statusOf(from);
        if (fromStatus != CVIStatus.VALID) return (false, from, fromStatus);
        CVIStatus toStatus = statusOf(to);
        if (toStatus != CVIStatus.VALID) return (false, to, toStatus);
        return (true, address(0), CVIStatus.NONE);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @inheritdoc IAvairaComplianceGate
    function credentialOf(address wallet) external view override returns (CVICredential memory) {
        return _credentials[wallet];
    }

    /// @inheritdoc IAvairaComplianceGate
    function statusOf(address wallet) public view override returns (CVIStatus) {
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0)) return CVIStatus.NONE;
        if (credential.status == CVIStatus.REVOKED) return CVIStatus.REVOKED;
        if (credential.expiry <= block.timestamp) return CVIStatus.EXPIRED;
        return CVIStatus.VALID;
    }

    /// @inheritdoc IAvairaComplianceGate
    function isWalletVerified(address wallet) external view override returns (bool) {
        return statusOf(wallet) == CVIStatus.VALID;
    }

    /// @inheritdoc IAvairaComplianceGate
    function checkWallets(address[] calldata wallets) external view override returns (bool ok, address failing) {
        uint256 len = wallets.length;
        for (uint256 i; i < len; ++i) {
            if (statusOf(wallets[i]) != CVIStatus.VALID) return (false, wallets[i]);
        }
        return (true, address(0));
    }

    /* ---------------------------------- admin --------------------------------- */

    /// @notice Reconfigures the Cleanverse issuer address.
    function setIssuer(address newIssuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newIssuer == address(0)) revert ZeroAddress();
        emit IssuerUpdated(issuer, newIssuer);
        issuer = newIssuer;
    }

    /* -------------------------------- internals ------------------------------- */

    function _requireVerified(address wallet) private view {
        CVICredential storage credential = _credentials[wallet];
        if (credential.wallet == address(0)) revert CVI_MISSING(wallet);
        if (credential.status == CVIStatus.REVOKED) revert CVI_REVOKED(wallet);
        if (credential.expiry <= block.timestamp) revert CVI_EXPIRED(wallet, credential.expiry);
    }
}
