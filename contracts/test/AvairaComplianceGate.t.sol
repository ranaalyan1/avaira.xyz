// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaComplianceGate} from "avaira/core/AvairaComplianceGate.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {IAvairaComplianceGate, CVICredential, CVIStatus} from "avaira/interfaces/IAvairaCompliance.sol";
import {GateReason, IAvairaIntentVault} from "avaira/interfaces/IAvaira.sol";
import {RiskEnvelope, RiskEnvelopeLib} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaComplianceGateTest — Cleanverse CVI/CVA compliance gate
/// @dev Identity verification is structurally coupled to asset movement: the
///      transfer path itself reverts without a valid wallet-bound CVI credential,
///      and the Avaira pre-execution gate blocks cva.* intents whose parties are
///      not identity-verified (Travel Rule: originator AND beneficiary).
contract AvairaComplianceGateTest is AvairaFixture {
    /// @dev The Cleanverse issuer key is known so tests produce real signatures.
    uint256 internal constant ISSUER_PK = 0xC1EA47E;
    address internal issuerSigner = vm.addr(ISSUER_PK);

    AvairaComplianceGate internal gate;
    uint64 internal constant TTL = 30 days;

    bytes32 private constant CVI_CREDENTIAL_TYPEHASH =
        keccak256("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)");

    function setUp() public override {
        super.setUp();
        gate = new AvairaComplianceGate(issuerSigner, owner);
    }

    /* --------------------------------- helpers -------------------------------- */

    function _signCVI(uint256 pk, address wallet, bytes32 credentialHash, uint64 expiry)
        internal
        pure
        returns (bytes memory signature)
    {
        bytes32 payload = keccak256(abi.encode(CVI_CREDENTIAL_TYPEHASH, wallet, credentialHash, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _verify(address wallet) internal returns (bytes32 credentialHash, uint64 expiry) {
        credentialHash = keccak256(abi.encode("cleanverse.ccp.result", wallet));
        expiry = uint64(block.timestamp + TTL);
        gate.verifyCVI(wallet, credentialHash, expiry, _signCVI(ISSUER_PK, wallet, credentialHash, expiry));
    }

    /* ------------------------------ verifyCVI unit ---------------------------- */

    function test_VerifyCVI_RegistersWalletBoundCredentialAndEmits() public {
        bytes32 credentialHash = keccak256("cleanverse.ccp.result:alice");
        uint64 expiry = uint64(block.timestamp + TTL);
        bytes memory signature = _signCVI(ISSUER_PK, alice, credentialHash, expiry);

        vm.expectEmit(true, false, false, true, address(gate));
        emit IAvairaComplianceGate.CVIVerified(alice, credentialHash, expiry);

        gate.verifyCVI(alice, credentialHash, expiry, signature);

        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.VALID));
        assertTrue(gate.isWalletVerified(alice));
        CVICredential memory credential = gate.credentialOf(alice);
        assertEq(credential.wallet, alice);
        assertEq(credential.credentialHash, credentialHash);
        assertEq(credential.expiry, expiry);
        assertEq(uint8(credential.status), uint8(CVIStatus.VALID));
        assertEq(credential.issuer, issuerSigner);
        assertEq(credential.verifiedAt, uint64(block.timestamp));
        assertEq(gate.credentialCount(), 1);
    }

    function test_VerifyCVI_RefreshOverwritesPreviousCredential() public {
        (bytes32 firstHash, uint64 firstExpiry) = _verify(alice);
        assertEq(gate.credentialOf(alice).credentialHash, firstHash);

        bytes32 secondHash = keccak256("cleanverse.ccp.result:alice:refresh");
        uint64 secondExpiry = uint64(block.timestamp + 2 * TTL);
        gate.verifyCVI(alice, secondHash, secondExpiry, _signCVI(ISSUER_PK, alice, secondHash, secondExpiry));

        assertEq(gate.credentialOf(alice).credentialHash, secondHash);
        assertEq(gate.credentialOf(alice).expiry, secondExpiry);
        assertEq(gate.credentialCount(), 1, "refresh must not double count");
        assertNotEq(firstExpiry, secondExpiry);
    }

    function test_VerifyCVI_RejectsInvalidInputsAndExpiredCommitments() public {
        bytes32 credentialHash = keccak256("x");
        uint64 expiry = uint64(block.timestamp + TTL);
        bytes memory signature = _signCVI(ISSUER_PK, alice, credentialHash, expiry);

        vm.expectRevert(IAvairaComplianceGate.InvalidCredential.selector);
        gate.verifyCVI(address(0), credentialHash, expiry, signature);

        vm.expectRevert(IAvairaComplianceGate.InvalidCredential.selector);
        gate.verifyCVI(alice, bytes32(0), expiry, signature);

        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.CredentialAlreadyExpired.selector, uint64(block.timestamp)));
        gate.verifyCVI(alice, credentialHash, uint64(block.timestamp), signature);
    }

    function test_VerifyCVI_RejectsForgedOrMisboundSignatures() public {
        bytes32 credentialHash = keccak256("cleanverse.ccp.result:alice");
        uint64 expiry = uint64(block.timestamp + TTL);

        // Signature from a key that is not the configured issuer.
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.InvalidIssuerSignature.selector, alice, issuerSigner));
        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(BOB_PK, alice, credentialHash, expiry));

        // Real issuer, but the signature binds a different wallet.
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.InvalidIssuerSignature.selector, alice, issuerSigner));
        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(ISSUER_PK, bob, credentialHash, expiry));

        // Real issuer, but the signature binds a different expiry.
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.InvalidIssuerSignature.selector, alice, issuerSigner));
        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(ISSUER_PK, alice, credentialHash, expiry + 1));

        // Real issuer, but the signature binds a different credential hash.
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.InvalidIssuerSignature.selector, alice, issuerSigner));
        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(ISSUER_PK, alice, keccak256("other"), expiry));
    }

    function test_SetIssuer_RotatesTheCleanverseIssuer() public {
        uint256 newIssuerPk = 0x1551E2;
        address newIssuer = vm.addr(newIssuerPk);

        vm.prank(alice);
        vm.expectRevert();
        gate.setIssuer(newIssuer);

        vm.expectEmit(true, true, false, false, address(gate));
        emit IAvairaComplianceGate.IssuerUpdated(issuerSigner, newIssuer);
        vm.prank(owner);
        gate.setIssuer(newIssuer);
        assertEq(gate.issuer(), newIssuer);

        // Old issuer signatures no longer verify; the new issuer's do.
        bytes32 credentialHash = keccak256("post-rotation");
        uint64 expiry = uint64(block.timestamp + TTL);
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.InvalidIssuerSignature.selector, alice, newIssuer));
        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(ISSUER_PK, alice, credentialHash, expiry));

        gate.verifyCVI(alice, credentialHash, expiry, _signCVI(newIssuerPk, alice, credentialHash, expiry));
        assertTrue(gate.isWalletVerified(alice));

        vm.prank(owner);
        vm.expectRevert(AvairaComplianceGate.ZeroAddress.selector);
        gate.setIssuer(address(0));
    }

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(AvairaComplianceGate.ZeroAddress.selector);
        new AvairaComplianceGate(address(0), owner);
        vm.expectRevert(AvairaComplianceGate.ZeroAddress.selector);
        new AvairaComplianceGate(issuerSigner, address(0));
    }

    /* -------------------------------- revocation ------------------------------ */

    function test_RevokeCVI_ByIssuerOrAdminOnly() public {
        _verify(alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaComplianceGate.NotIssuerOrAdmin.selector, bob));
        gate.revokeCVI(alice);

        vm.expectEmit(true, true, false, false, address(gate));
        emit IAvairaComplianceGate.CVIRevoked(alice, issuerSigner);
        vm.prank(issuerSigner);
        gate.revokeCVI(alice);
        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.REVOKED));
        assertFalse(gate.isWalletVerified(alice));
    }

    function test_RevokeCVI_AdminRevokeAndDoubleRevokeReverts() public {
        _verify(alice);
        vm.prank(owner);
        gate.revokeCVI(alice);
        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.REVOKED));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, alice));
        gate.revokeCVI(alice);

        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, bob));
        vm.prank(owner);
        gate.revokeCVI(bob);
    }

    function test_StatusOf_DerivesExpiryByTime() public {
        (, uint64 expiry) = _verify(alice);
        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.VALID));

        vm.warp(expiry - 1);
        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.VALID));

        vm.warp(expiry);
        assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.EXPIRED));
        assertFalse(gate.isWalletVerified(alice));
    }

    function test_StatusOf_NoneForUnknownWallet() public {
        assertEq(uint8(gate.statusOf(makeAddr("stranger"))), uint8(CVIStatus.NONE));
        assertFalse(gate.isWalletVerified(makeAddr("stranger")));
    }

    /* ------------------------------ gateCVATransfer --------------------------- */

    function test_GateCVATransfer_AllowsVerifiedOriginatorAndBeneficiary() public {
        _verify(alice);
        _verify(bob);

        vm.expectEmit(true, true, false, true, address(gate));
        emit IAvairaComplianceGate.CVATransferGated(alice, bob, 250e6, true);

        gate.gateCVATransfer(alice, bob, 250e6);
    }

    function test_GateCVATransfer_RevertsWhenOriginatorLacksCVI() public {
        _verify(bob); // beneficiary verified, originator not

        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, alice));
        gate.gateCVATransfer(alice, bob, 100e6);
    }

    function test_GateCVATransfer_RevertsWhenBeneficiaryLacksCVI() public {
        _verify(alice); // originator verified, beneficiary not

        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, bob));
        gate.gateCVATransfer(alice, bob, 100e6);
    }

    function test_GateCVATransfer_RevertsOnExpiredCredential() public {
        (, uint64 expiry) = _verify(alice);
        _verify(bob);

        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_EXPIRED.selector, alice, expiry));
        gate.gateCVATransfer(alice, bob, 100e6);
    }

    function test_GateCVATransfer_RevertsOnRevokedCredential() public {
        _verify(alice);
        _verify(bob);
        vm.prank(issuerSigner);
        gate.revokeCVI(bob);

        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_REVOKED.selector, bob));
        gate.gateCVATransfer(alice, bob, 100e6);
    }

    function test_GateCVATransfer_ZeroAddressPartiesAreMissing() public {
        _verify(alice);
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, address(0)));
        gate.gateCVATransfer(alice, address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, address(0)));
        gate.gateCVATransfer(address(0), alice, 1);
    }

    function test_CheckCVATransfer_ReportsFirstFailingParty() public {
        // Neither party verified: the originator is reported first.
        (bool allowed, address failing, CVIStatus reason) = gate.checkCVATransfer(alice, bob);
        assertFalse(allowed);
        assertEq(failing, alice);
        assertEq(uint8(reason), uint8(CVIStatus.NONE));

        // Only the beneficiary verified: now the originator is reported.
        (, uint64 bobExpiry) = _verify(bob);
        (allowed, failing, reason) = gate.checkCVATransfer(alice, bob);
        assertFalse(allowed);
        assertEq(failing, alice);
        assertEq(uint8(reason), uint8(CVIStatus.NONE));

        // Verify alice later: her credential outlives bob's.
        vm.warp(block.timestamp + 10 days);
        _verify(alice);

        // Just before bob's expiry: both valid.
        vm.warp(bobExpiry - 1);
        (allowed, failing, reason) = gate.checkCVATransfer(alice, bob);
        assertTrue(allowed);
        assertEq(failing, address(0));
        assertEq(uint8(reason), uint8(CVIStatus.NONE));

        // Just after bob's expiry: the beneficiary is reported as expired.
        vm.warp(bobExpiry + 1);
        (allowed, failing, reason) = gate.checkCVATransfer(alice, bob);
        assertFalse(allowed);
        assertEq(failing, bob);
        assertEq(uint8(reason), uint8(CVIStatus.EXPIRED));
    }

    function test_CheckWallets_AllMustBeVerified() public {
        _verify(alice);
        _verify(bob);
        address stranger = makeAddr("stranger");
        address[] memory wallets = new address[](3);
        wallets[0] = alice;
        wallets[1] = bob;
        wallets[2] = stranger;

        (bool ok, address failing) = gate.checkWallets(wallets);
        assertFalse(ok);
        assertEq(failing, stranger);

        wallets[2] = carol;
        _verify(carol);
        (ok, failing) = gate.checkWallets(wallets);
        assertTrue(ok);
        assertEq(failing, address(0));
    }

    /* ---------------------------------- fuzzing -------------------------------- */

    function testFuzz_VerifyCVI_AnyWalletBindsOnlyWithIssuerSignature(address wallet, bytes32 seed) public {
        vm.assume(wallet != address(0));
        bytes32 credentialHash = keccak256(abi.encode(seed, wallet));
        uint64 expiry = uint64(block.timestamp + 1 days);

        // A non-issuer signature never registers a credential.
        vm.expectRevert();
        gate.verifyCVI(wallet, credentialHash, expiry, _signCVI(0xDEAD, wallet, credentialHash, expiry));
        assertEq(uint8(gate.statusOf(wallet)), uint8(CVIStatus.NONE));

        gate.verifyCVI(wallet, credentialHash, expiry, _signCVI(ISSUER_PK, wallet, credentialHash, expiry));
        assertTrue(gate.isWalletVerified(wallet));
        assertEq(gate.credentialOf(wallet).credentialHash, credentialHash);
    }

    function testFuzz_GateCVATransfer_PassesIffBothPartiesVerified(address from, address to, uint256 amount, bool verifyFrom, bool verifyTo)
        public
    {
        vm.assume(from != address(0) && to != address(0) && from != to);
        if (verifyFrom) _verify(from);
        if (verifyTo) _verify(to);

        if (verifyFrom && verifyTo) {
            gate.gateCVATransfer(from, to, amount); // must not revert
        } else {
            address failing = verifyFrom ? to : from;
            vm.expectRevert(abi.encodeWithSelector(IAvairaComplianceGate.CVI_MISSING.selector, failing));
            gate.gateCVATransfer(from, to, amount);
        }
    }

    function testFuzz_StatusTransitions_ExpiryDerivedFromTime(uint64 ttl, uint64 warpBy) public {
        ttl = uint64(bound(ttl, 1, 365 days));
        (, uint64 expiry) = _verify(alice);

        vm.warp(block.timestamp + warpBy);
        if (block.timestamp < expiry) {
            assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.VALID));
        } else {
            assertEq(uint8(gate.statusOf(alice)), uint8(CVIStatus.EXPIRED));
        }
    }
}

/// @title AvairaComplianceGateVaultIntegration — checkGate blocks cva.* intents
/// @dev The pre-execution gate must reject intents whose allowed actions include
///      `cva.transfer` / `cva.settle` while any involved wallet lacks a valid CVI —
///      execute_fn therefore never runs for an unverified party.
contract AvairaComplianceGateVaultIntegrationTest is AvairaFixture {
    uint256 internal constant ISSUER_PK = 0xC1EA47E;
    address internal issuerSigner = vm.addr(ISSUER_PK);

    AvairaComplianceGate internal gate;
    uint256 internal agentId;
    bytes32 internal cvaIntentHash = keccak256("intent:cva-transfer:1");

    bytes32 private constant CVI_CREDENTIAL_TYPEHASH =
        keccak256("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)");

    function setUp() public override {
        super.setUp();
        gate = new AvairaComplianceGate(issuerSigner, owner);
        vm.prank(owner);
        vault.setComplianceGate(address(gate));
        agentId = _activeAgent(alice, MIN_STAKE, 78);
    }

    function _signCVI(uint256 pk, address wallet, bytes32 credentialHash, uint64 expiry)
        internal
        pure
        returns (bytes memory signature)
    {
        bytes32 payload = keccak256(abi.encode(CVI_CREDENTIAL_TYPEHASH, wallet, credentialHash, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _verify(address wallet) internal {
        bytes32 credentialHash = keccak256(abi.encode("cleanverse.ccp.result", wallet));
        uint64 expiry = uint64(block.timestamp + 30 days);
        gate.verifyCVI(wallet, credentialHash, expiry, _signCVI(ISSUER_PK, wallet, credentialHash, expiry));
    }

    function _commit(bytes32 intentHash, string memory action) internal {
        RiskEnvelope memory envelope = _envelope(50e6, action, uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);
    }

    function test_CheckGate_BlocksCvaTransferIntentWithoutCVI() public {
        _commit(cvaIntentHash, "cva.transfer");

        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertFalse(allowed);
        assertEq(score, 78); // agent itself is healthy
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));
    }

    function test_CheckGate_BlocksCvaSettleIntentWithoutCVI() public {
        _commit(cvaIntentHash, "cva.settle");
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));
    }

    function test_CheckGate_AllowsCvaIntentOnceOperatorVerified() public {
        _commit(cvaIntentHash, "cva.transfer");
        _verify(alice); // alice owns the identity and has no agent wallet bound

        (bool allowed,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_CheckGate_RequiresAgentExecutionWalletToo() public {
        _commit(cvaIntentHash, "cva.transfer");
        _verify(alice);

        // Bind carol's wallet as the agent execution wallet: carol becomes an
        // involved wallet and must hold CVI as well.
        uint256 nonce = identity.agentWalletNonce(agentId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = identity.hashAgentWalletSet(agentId, carol, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CAROL_PK, digest);
        vm.prank(alice);
        identity.setAgentWallet(agentId, carol, deadline, abi.encodePacked(r, s, v));

        (bool allowed,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));

        _verify(carol);
        (allowed,, reason) = vault.checkGate(agentId, cvaIntentHash);
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_CheckGate_RevokedOrExpiredCviBlocksAgain() public {
        _commit(cvaIntentHash, "cva.transfer");
        _verify(alice);
        (bool allowed,,) = vault.checkGate(agentId, cvaIntentHash);
        assertTrue(allowed);

        vm.prank(issuerSigner);
        gate.revokeCVI(alice);
        (,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));

        // Re-verify (inside a long-lived intent) then let the credential lapse.
        RiskEnvelope memory longLived = _envelope(50e6, "cva.transfer", uint64(block.timestamp + 90 days));
        bytes32 longIntentHash = keccak256("intent:cva-longlived");
        vm.prank(alice);
        vault.commitIntent(agentId, longIntentHash, longLived);

        _verify(alice);
        (allowed,,) = vault.checkGate(agentId, longIntentHash);
        assertTrue(allowed);
        vm.warp(block.timestamp + 31 days);
        (,, reason) = vault.checkGate(agentId, longIntentHash);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));
    }

    function test_CheckGate_NonCvaIntentsUnaffectedByGate() public {
        _commit(keccak256("intent:web:1"), "web.search");
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, keccak256("intent:web:1"));
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_CheckGate_BackwardsCompatibleWithoutGate() public {
        // A vault with no compliance gate behaves exactly as before.
        vm.prank(owner);
        vault.setComplianceGate(address(0));

        _commit(cvaIntentHash, "cva.transfer");
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash);
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_CheckGate_EnvelopeOverloadInheritsCviCheck() public {
        RiskEnvelope memory envelope = _envelope(50e6, "cva.transfer", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, cvaIntentHash, envelope);

        (bool allowed,, GateReason reason) = vault.checkGate(agentId, cvaIntentHash, RiskEnvelopeLib.hash(envelope));
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));

        _verify(alice);
        (allowed,, reason) = vault.checkGate(agentId, cvaIntentHash, RiskEnvelopeLib.hash(envelope));
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_SetComplianceGate_AdminOnlyAndEmits() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setComplianceGate(address(0));

        vm.expectEmit(false, false, false, true, address(vault));
        emit AvairaIntentVault.ComplianceGateUpdated(address(gate), address(0));
        vm.prank(owner);
        vault.setComplianceGate(address(0));
        assertEq(address(vault.complianceGate()), address(0));
    }

    function test_RecordGateDecision_AcceptsCviReason() public {
        _commit(cvaIntentHash, "cva.transfer");
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAvairaIntentVault.GateDecisionRecorded(agentId, cvaIntentHash, false, GateReason.CVI_UNVERIFIED, 42);
        vault.recordGateDecision(agentId, cvaIntentHash, false, GateReason.CVI_UNVERIFIED, 42);
    }

    function testFuzz_CvaIntentGating_AnyCvaPrefixedActionRequiresCvi(string memory suffix) public {
        // MAX_ACTION_LENGTH is 96 bytes; keep "cva." + suffix inside it.
        vm.assume(bytes(suffix).length > 0 && bytes(suffix).length <= 92);
        string memory action = string.concat("cva.", suffix);
        bytes32 intentHash = keccak256(abi.encode("fuzz", action));
        RiskEnvelope memory envelope = _envelope(50e6, action, uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.CVI_UNVERIFIED));

        _verify(alice);
        (allowed,,) = vault.checkGate(agentId, intentHash);
        assertTrue(allowed);
    }
}
