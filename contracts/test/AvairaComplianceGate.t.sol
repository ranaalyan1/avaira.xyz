// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaComplianceGate} from "avaira/core/AvairaComplianceGate.sol";
import {AvairaCVA} from "avaira/tokens/AvairaCVA.sol";
import {IAvairaComplianceGate, CVIStatus, CVICredential} from "avaira/interfaces/IAvairaComplianceGate.sol";
import {GateReason} from "avaira/interfaces/IAvaira.sol";
import {RiskEnvelope, RiskEnvelopeLib} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaComplianceGateTest — Workstream 1 (Cleanverse CVI/CVA)
/// @notice Proves the compliance property the hackathon asks for: CVI verification is
///         structurally coupled to CVA movement, so an unverified counterparty cannot
///         send *or* receive, and a `cva.*` intent cannot clear the pre-execution gate.
contract AvairaComplianceGateTest is AvairaFixture {
    uint64 internal constant DEFAULT_VALIDITY = 365 days;

    AvairaComplianceGate internal complianceGate;
    AvairaCVA internal cva;

    uint256 internal constant ISSUER_PK = 0xC1EA4;
    address internal issuer = vm.addr(ISSUER_PK);

    uint256 internal constant OTHER_PK = 0x0BAD;
    address internal stranger = vm.addr(OTHER_PK);

    address internal verifiedA = makeAddr("cviAgentA");
    address internal verifiedB = makeAddr("cviAgentB");
    address internal unverifiedC = makeAddr("cviAgentC");

    bytes32 internal constant CREDENTIAL_HASH = keccak256("ccp:identity:agent-a");

    function setUp() public override {
        super.setUp();

        complianceGate = new AvairaComplianceGate(owner, issuer, DEFAULT_VALIDITY);
        cva = new AvairaCVA(address(complianceGate), owner);

        vm.prank(owner);
        vault.setComplianceGate(address(complianceGate));

        _verify(verifiedA, CREDENTIAL_HASH);
        _verify(verifiedB, keccak256("ccp:identity:agent-b"));
    }

    /* --------------------------------- helpers -------------------------------- */

    /// @dev Produces a real issuer signature over the gate's EIP-712 `CVIClaimShort`.
    function _issuerSig(address wallet, bytes32 credentialHash) internal view returns (bytes memory) {
        uint256 nonce = complianceGate.credentialNonce(wallet);
        bytes32 digest = complianceGate.hashCVIClaim(wallet, credentialHash, nonce);
        return _sig(ISSUER_PK, digest);
    }

    function _issuerSigWithExpiry(address wallet, bytes32 credentialHash, uint64 expiry, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _sig(ISSUER_PK, complianceGate.hashCVIClaimWithExpiry(wallet, credentialHash, expiry, nonce));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _verify(address wallet, bytes32 credentialHash) internal {
        complianceGate.verifyCVI(wallet, _issuerSig(wallet, credentialHash), credentialHash);
    }

    function _mintCVA(address to) internal {
        vm.prank(owner);
        cva.mint(to, 1_000e18);
    }

    /* ------------------------------ CVI verification --------------------------- */

    function test_VerifyCVI_RegistersWalletBoundCredential() public {
        address wallet = makeAddr("freshWallet");
        bytes32 hash = keccak256("ccp:fresh");

        vm.expectEmit(true, false, false, true, address(complianceGate));
        emit IAvairaComplianceGate.CVIVerified(wallet, hash, uint64(block.timestamp) + DEFAULT_VALIDITY);

        complianceGate.verifyCVI(wallet, _issuerSig(wallet, hash), hash);

        CVICredential memory credential = complianceGate.credentialOf(wallet);
        assertEq(credential.wallet, wallet);
        assertEq(credential.credentialHash, hash);
        assertEq(credential.expiry, uint64(block.timestamp) + DEFAULT_VALIDITY);
        assertEq(uint256(credential.status), uint256(CVIStatus.VALID));
        assertEq(credential.issuer, issuer);
        assertTrue(complianceGate.isCVIValid(wallet));
        assertEq(complianceGate.credentialNonce(wallet), 1);
        assertEq(uint256(complianceGate.credentialStatusOf(wallet)), uint256(CVIStatus.VALID));
    }

    /// @dev The credential is wallet-bound: submitting the claim for another wallet fails.
    function test_VerifyCVI_RevertsForNonIssuerSignature() public {
        address wallet = makeAddr("signedByStranger");
        bytes32 hash = keccak256("ccp:forged");
        bytes32 digest = complianceGate.hashCVIClaim(wallet, hash, 0);

        vm.expectRevert(
            abi.encodeWithSelector(AvairaComplianceGate.CVI_UNKNOWN_ISSUER.selector, vm.addr(OTHER_PK))
        );
        complianceGate.verifyCVI(wallet, _sig(OTHER_PK, digest), hash);
        assertFalse(complianceGate.isCVIValid(wallet));
    }

    function test_VerifyCVI_RevertsWhenSignatureIsReplayedForAnotherWallet() public {
        address walletA = makeAddr("replayA");
        address walletB = makeAddr("replayB");
        bytes memory signature = _issuerSig(walletA, CREDENTIAL_HASH);

        complianceGate.verifyCVI(walletA, signature, CREDENTIAL_HASH);

        // Same signature, different wallet: the digest no longer matches.
        vm.expectRevert();
        complianceGate.verifyCVI(walletB, signature, CREDENTIAL_HASH);
        assertFalse(complianceGate.isCVIValid(walletB));
    }

    function test_VerifyCVI_RejectsReplayOnSameWallet() public {
        address wallet = makeAddr("replayer");
        bytes memory signature = _issuerSig(wallet, CREDENTIAL_HASH);
        complianceGate.verifyCVI(wallet, signature, CREDENTIAL_HASH);

        // Nonce advanced to 1, so the stale signature (nonce 0) can never be reused.
        vm.expectRevert();
        complianceGate.verifyCVI(wallet, signature, CREDENTIAL_HASH);
        assertEq(complianceGate.credentialNonce(wallet), 1);
    }

    function test_VerifyCVIWithExpiry_HonoursIssuerExpiryAndNonce() public {
        address wallet = makeAddr("issuerExpiry");
        bytes32 hash = keccak256("ccp:expiry");
        uint64 expiry = uint64(block.timestamp + 30 days);
        bytes memory firstClaim = _issuerSigWithExpiry(wallet, hash, expiry, 0);

        complianceGate.verifyCVIWithExpiry(wallet, firstClaim, hash, expiry, 0);
        assertEq(complianceGate.credentialOf(wallet).expiry, expiry);

        // Replaying the same claim (nonce 0 consumed) is rejected explicitly.
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_NONCE_MISMATCH.selector, 1, 0));
        complianceGate.verifyCVIWithExpiry(wallet, firstClaim, hash, expiry, 0);

        // And an expiry beyond policy is refused.
        uint64 tooFar = uint64(block.timestamp + 20 * 365 days);
        bytes memory tooFarClaim = _issuerSigWithExpiry(wallet, hash, tooFar, 1);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_INVALID_EXPIRY.selector, tooFar));
        complianceGate.verifyCVIWithExpiry(wallet, tooFarClaim, hash, tooFar, 1);
    }

    function test_VerifyCVI_IsPermissionless() public {
        address wallet = makeAddr("submittedByThirdParty");
        bytes32 hash = keccak256("ccp:third-party");
        bytes memory signature = _issuerSig(wallet, hash);

        // The issuer signature is the authorisation; the caller is irrelevant.
        vm.prank(stranger);
        complianceGate.verifyCVI(wallet, signature, hash);
        assertTrue(complianceGate.isCVIValid(wallet));
    }

    function test_VerifyCVI_RevertsOnZeroCredentialOrZeroWallet() public {
        address wallet = makeAddr("zeroHashWallet");
        bytes memory zeroHashClaim = _issuerSig(wallet, bytes32(0));
        vm.expectRevert(AvairaComplianceGate.ZeroCredentialHash.selector);
        complianceGate.verifyCVI(wallet, zeroHashClaim, bytes32(0));

        bytes memory zeroWalletClaim = _issuerSig(address(0), CREDENTIAL_HASH);
        vm.expectRevert(AvairaComplianceGate.ZeroAddress.selector);
        complianceGate.verifyCVI(address(0), zeroWalletClaim, CREDENTIAL_HASH);
    }

    /* -------------------------------- revocation ------------------------------- */

    function test_RevokeCVI_OnlyIssuerOrAdminAndBlocksTransfers() public {
        vm.prank(alice);
        vm.expectRevert("AvairaCVI: not an issuer");
        complianceGate.revokeCVI(verifiedA);

        vm.prank(issuer);
        complianceGate.revokeCVI(verifiedA);

        assertEq(uint256(complianceGate.credentialStatusOf(verifiedA)), uint256(CVIStatus.REVOKED));
        assertFalse(complianceGate.isCVIValid(verifiedA));

        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_REVOKED.selector, verifiedA));
        complianceGate.gateCVATransfer(verifiedA, verifiedB, 1e18);
    }

    function test_RevokeCVI_RevertsForUnknownWallet() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        complianceGate.revokeCVI(unverifiedC);
    }

    function test_RevokeCVI_IsRecoverableWithFreshCredential() public {
        vm.prank(issuer);
        complianceGate.revokeCVI(verifiedA);

        _verify(verifiedA, keccak256("ccp:identity:agent-a:refresh"));
        assertTrue(complianceGate.isCVIValid(verifiedA));
    }

    /* --------------------------------- the gate -------------------------------- */

    function test_GateCVATransfer_AllowsVerifiedPair() public {
        vm.expectEmit(true, true, false, true, address(complianceGate));
        emit IAvairaComplianceGate.CVATransferGated(verifiedA, verifiedB, 250e18, true);

        complianceGate.gateCVATransfer(verifiedA, verifiedB, 250e18);
        assertEq(complianceGate.gatedTransferCount(), 1);
    }

    function test_GateCVATransfer_RevertsWhenSenderHasNoCVI() public {
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        complianceGate.gateCVATransfer(unverifiedC, verifiedB, 1e18);
    }

    function test_GateCVATransfer_RevertsWhenRecipientHasNoCVI() public {
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        complianceGate.gateCVATransfer(verifiedA, unverifiedC, 1e18);
    }

    function test_GateCVATransfer_RevertsWhenCredentialExpired() public {
        uint64 expiry = uint64(block.timestamp) + DEFAULT_VALIDITY;
        vm.warp(expiry + 1);

        // Both sides are expired; the originator is reported first (Travel Rule order).
        assertEq(uint256(complianceGate.credentialStatusOf(verifiedA)), uint256(CVIStatus.EXPIRED));
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_EXPIRED.selector, verifiedA, expiry));
        complianceGate.gateCVATransfer(verifiedA, verifiedB, 1e18);

        // Refreshing both credentials restores the transfer.
        _verify(verifiedA, keccak256("ccp:identity:agent-a:refresh"));
        _verify(verifiedB, keccak256("ccp:identity:agent-b:refresh"));
        complianceGate.gateCVATransfer(verifiedA, verifiedB, 1e18);
    }

    function test_PreviewGateCVATransfer_ReportsStatusesAndBlocker() public {
        (bool allowed, CVIStatus fromStatus, CVIStatus toStatus, address blocker) =
            complianceGate.previewGateCVATransfer(verifiedA, verifiedB, 1e18);
        assertTrue(allowed);
        assertEq(uint256(fromStatus), uint256(CVIStatus.VALID));
        assertEq(uint256(toStatus), uint256(CVIStatus.VALID));
        assertEq(blocker, address(0));

        (allowed, fromStatus, toStatus, blocker) = complianceGate.previewGateCVATransfer(verifiedA, unverifiedC, 1e18);
        assertFalse(allowed);
        assertEq(uint256(toStatus), uint256(CVIStatus.NONE));
        assertEq(blocker, unverifiedC);

        (allowed, fromStatus, toStatus, blocker) = complianceGate.previewGateCVATransfer(unverifiedC, verifiedA, 1e18);
        assertFalse(allowed);
        assertEq(uint256(fromStatus), uint256(CVIStatus.NONE));
        assertEq(blocker, unverifiedC);
    }

    function test_RecordGatedTransfer_EmitsExplorerVisibleDenial() public {
        vm.expectEmit(true, true, false, true, address(complianceGate));
        emit IAvairaComplianceGate.CVATransferGated(unverifiedC, verifiedA, 5e18, false);
        complianceGate.recordGatedTransfer(unverifiedC, verifiedA, 5e18, false);
    }

    function test_RequiresCVI_NamespacesOnlyCvaActions() public {
        assertTrue(complianceGate.requiresCVI("cva.transfer"));
        assertTrue(complianceGate.requiresCVI("cva.settle"));
        assertTrue(complianceGate.requiresCVI("cva.mint"));
        assertFalse(complianceGate.requiresCVI("perpl.place_order"));
        assertFalse(complianceGate.requiresCVI("cva"));
        assertFalse(complianceGate.requiresCVI(""));
        assertFalse(complianceGate.requiresCVI("x.cva.transfer"));
    }

    /* ---------------------------------- admin ---------------------------------- */

    function test_SetIssuer_ControlsWhoMaySign() public {
        vm.prank(alice);
        vm.expectRevert();
        complianceGate.setIssuer(alice, true);

        vm.prank(owner);
        complianceGate.setIssuer(alice, true);

        address wallet = makeAddr("signedByNewIssuer");
        bytes32 hash = keccak256("ccp:new-issuer");
        bytes32 digest = complianceGate.hashCVIClaim(wallet, hash, 0);
        complianceGate.verifyCVI(wallet, _sig(ALICE_PK, digest), hash);
        assertTrue(complianceGate.isCVIValid(wallet));

        vm.prank(owner);
        complianceGate.setIssuer(alice, false);
        address lateWallet = makeAddr("afterRemoval");
        bytes32 lateDigest = complianceGate.hashCVIClaim(lateWallet, hash, 0);
        bytes memory lateSignature = _sig(ALICE_PK, lateDigest);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_UNKNOWN_ISSUER.selector, alice));
        complianceGate.verifyCVI(lateWallet, lateSignature, hash);
    }

    function test_SetDefaultValidity_Bounded() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_INVALID_EXPIRY.selector, uint64(10)));
        complianceGate.setDefaultValidity(10);

        vm.prank(owner);
        complianceGate.setDefaultValidity(30 days);
        assertEq(complianceGate.defaultValidity(), 30 days);
    }

    /* ------------------------------ structural coupling ------------------------ */

    function test_CVA_MintAndTransferRequireBothSidesVerified() public {
        // Mint to an unverified wallet is blocked: the token itself refuses.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        cva.mint(unverifiedC, 10e18);

        _mintCVA(verifiedA);
        _mintCVA(verifiedB);
        assertEq(cva.balanceOf(verifiedA), 1_000e18);

        // Verified -> verified succeeds.
        vm.prank(verifiedA);
        cva.transfer(verifiedB, 400e18);
        assertEq(cva.balanceOf(verifiedB), 1_400e18);

        // Verified -> unverified reverts with the gate's own reason: no wrapper involved.
        vm.prank(verifiedA);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        cva.transfer(unverifiedC, 1e18);

        // transferFrom is gated identically (allowances cannot bypass identity).
        vm.prank(verifiedA);
        cva.approve(stranger, 1e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unverifiedC));
        cva.transferFrom(verifiedA, unverifiedC, 1e18);
    }

    function test_CVA_BurnRequiresVerifiedHolder() public {
        _mintCVA(verifiedA);
        vm.prank(owner);
        cva.burn(verifiedA, 100e18);
        assertEq(cva.balanceOf(verifiedA), 900e18);

        vm.prank(issuer);
        complianceGate.revokeCVI(verifiedA);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_REVOKED.selector, verifiedA));
        cva.burn(verifiedA, 1e18);
    }

    function test_CVA_ExpiredCredentialFreezesBalancesUntilRefreshed() public {
        _mintCVA(verifiedA);
        _mintCVA(verifiedB);
        vm.warp(block.timestamp + DEFAULT_VALIDITY + 1);

        vm.prank(verifiedA);
        vm.expectRevert();
        cva.transfer(verifiedB, 1e18);

        _verify(verifiedA, keccak256("ccp:identity:agent-a:renewed"));
        _verify(verifiedB, keccak256("ccp:identity:agent-b:renewed"));
        vm.prank(verifiedA);
        cva.transfer(verifiedB, 1e18);
        assertEq(cva.balanceOf(verifiedB), 1_000e18 + 1e18);
    }

    /* ------------------------------ try-gate variant --------------------------- */

    /// @dev The non-reverting variant reports the same decision and only counts allowed moves.
    function test_TryGateCVATransfer_AllowsVerifiedPairAndCountsIt() public {
        uint256 before = complianceGate.gatedTransferCount();

        vm.expectEmit(true, true, false, true, address(complianceGate));
        emit IAvairaComplianceGate.CVATransferGated(verifiedA, verifiedB, 1e18, true);
        bool allowed = complianceGate.tryGateCVATransfer(verifiedA, verifiedB, 1e18);

        assertTrue(allowed);
        assertEq(complianceGate.gatedTransferCount(), before + 1);
    }

    /// @dev An unverified side returns false rather than reverting, so integrators can branch.
    function test_TryGateCVATransfer_ReturnsFalseWithoutReverting() public {
        address unknownWallet = makeAddr("tryGateStranger");
        uint256 before = complianceGate.gatedTransferCount();

        assertFalse(complianceGate.tryGateCVATransfer(unknownWallet, verifiedB, 1e18));
        assertFalse(complianceGate.tryGateCVATransfer(verifiedA, unknownWallet, 1e18));
        assertEq(complianceGate.gatedTransferCount(), before, "a refused quote must not be counted");

        // Same wallet once the credential lapses.
        vm.warp(block.timestamp + DEFAULT_VALIDITY + 1);
        assertFalse(complianceGate.tryGateCVATransfer(verifiedA, verifiedB, 1e18));
    }

    /// @dev The view reports a lapsed credential as EXPIRED even though storage still says VALID.
    function test_CredentialOf_ReportsLapsedCredentialAsExpired() public {
        assertEq(uint256(complianceGate.credentialOf(verifiedA).status), uint256(CVIStatus.VALID));

        vm.warp(block.timestamp + DEFAULT_VALIDITY + 1);

        CVICredential memory credential = complianceGate.credentialOf(verifiedA);
        assertEq(uint256(credential.status), uint256(CVIStatus.EXPIRED));
        assertEq(credential.wallet, verifiedA);
        // `requireVerified` is the public, standalone entry point integrators call.
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_EXPIRED.selector, verifiedA, credential.expiry));
        complianceGate.requireVerified(verifiedA);
    }

    /// @dev `requireVerified` mirrors the token's own checks for every failure mode.
    function test_RequireVerified_RevertsForMissingRevokedAndExpired() public {
        address unknownWallet = makeAddr("requireVerifiedStranger");
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_MISSING.selector, unknownWallet));
        complianceGate.requireVerified(unknownWallet);

        vm.prank(issuer);
        complianceGate.revokeCVI(verifiedA);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CVI_REVOKED.selector, verifiedA));
        complianceGate.requireVerified(verifiedA);

        // And it returns quietly for a healthy credential.
        complianceGate.requireVerified(verifiedB);
    }

    /* ----------------------------------- fuzz ---------------------------------- */

    /// @dev Any wallet without a credential is refused, for any amount.
    function testFuzz_GateCVATransfer_UnverifiedAlwaysBlocked(address from, address to, uint256 amount) public {
        vm.assume(from != address(0) && to != address(0));
        if (complianceGate.isCVIValid(from) && complianceGate.isCVIValid(to)) return;

        vm.expectRevert();
        complianceGate.gateCVATransfer(from, to, amount);
    }

    /// @dev Verified pairs always move the exact fuzzed amount through the token.
    function testFuzz_CVA_VerifiedPairTransfersExactAmount(uint96 amount) public {
        uint256 transferAmount = bound(uint256(amount), 0, 1_000e18);

        _mintCVA(verifiedA);
        vm.prank(verifiedA);
        cva.transfer(verifiedB, transferAmount);
        assertEq(cva.balanceOf(verifiedB), transferAmount);
        assertEq(cva.balanceOf(verifiedA), 1_000e18 - transferAmount);
    }

    /// @dev Expiry is strictly enforced for every validity window the gate accepts.
    function testFuzz_CredentialExpiresExactlyAtExpiry(uint64 validity) public {
        validity = uint64(bound(validity, 60, 10 * 365 days));
        address wallet = makeAddr("fuzzExpiry");
        vm.prank(owner);
        complianceGate.setDefaultValidity(validity);

        _verify(wallet, keccak256("ccp:fuzz-expiry"));
        uint64 expiry = uint64(block.timestamp) + validity;
        assertEq(complianceGate.credentialOf(wallet).expiry, expiry);

        vm.warp(expiry - 1);
        assertTrue(complianceGate.isCVIValid(wallet));

        vm.warp(expiry);
        assertFalse(complianceGate.isCVIValid(wallet));
        assertEq(uint256(complianceGate.credentialStatusOf(wallet)), uint256(CVIStatus.EXPIRED));
    }
}
