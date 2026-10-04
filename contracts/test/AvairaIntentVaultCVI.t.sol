// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaComplianceGate} from "avaira/core/AvairaComplianceGate.sol";
import {AvairaCVA} from "avaira/tokens/AvairaCVA.sol";
import {CVIStatus} from "avaira/interfaces/IAvairaComplianceGate.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {GateReason, IAvairaIntentVault} from "avaira/interfaces/IAvaira.sol";
import {RiskEnvelope} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @notice A minimal agent runtime: exactly the SDK's discipline — read the gate, and only
///         touch the asset if it cleared. Used to prove `execute_fn` is never reached.
contract GatedCVAExecutor {
    IAvairaIntentVault public immutable vault;
    AvairaCVA public immutable cva;

    error GateClosed(GateReason reason);

    constructor(IAvairaIntentVault vault_, AvairaCVA cva_) {
        vault = vault_;
        cva = cva_;
    }

    /// @dev Mirrors `avaira.run()`: the gate is evaluated before anything moves.
    function execute(uint256 agentId, bytes32 intentHash, address from, address to, uint256 amount) external {
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        if (!allowed) revert GateClosed(reason);
        cva.transferFrom(from, to, amount);
    }
}

/// @title AvairaIntentVaultCVITest — the CVI hook inside the pre-execution gate
/// @notice Workstream 1 acceptance: an intent whose envelope allows `cva.*` is blocked with
///         `CVI_UNVERIFIED` when any involved wallet lacks a valid CVI credential, and
///         `execute_fn` never runs.
contract AvairaIntentVaultCVITest is AvairaFixture {
    uint64 internal constant DEFAULT_VALIDITY = 365 days;
    uint256 internal constant ISSUER_PK = 0xC1EA4;
    uint256 internal constant WALLET_PK = 0xA11CE2;

    AvairaComplianceGate internal complianceGate;
    AvairaCVA internal cva;
    GatedCVAExecutor internal executor;

    address internal issuer = vm.addr(ISSUER_PK);
    /// @dev Verified CVA custodian: lets the tests isolate who the *unverified* party is.
    address internal cvaHolder = makeAddr("verifiedCvaHolder");
    /// @dev Verified CVA beneficiary: the Travel-Rule counterparty in the settle tests.
    address internal cvaRecipient = makeAddr("verifiedCvaRecipient");

    uint256 internal agentId;
    bytes32 internal intentHash = keccak256("intent:cva-settlement:1");

    function setUp() public override {
        super.setUp();

        complianceGate = new AvairaComplianceGate(owner, issuer, DEFAULT_VALIDITY);
        cva = new AvairaCVA(address(complianceGate), owner);
        executor = new GatedCVAExecutor(vault, cva);

        vm.prank(owner);
        vault.setComplianceGate(address(complianceGate));

        agentId = _activeAgent(alice, MIN_STAKE, 78);

        _verify(cvaHolder, keccak256("ccp:custodian"));
        _verify(cvaRecipient, keccak256("ccp:beneficiary"));
        vm.prank(owner);
        cva.mint(cvaHolder, 1_000e18);
        vm.prank(cvaHolder);
        cva.approve(address(executor), type(uint256).max);
    }

    /* --------------------------------- helpers -------------------------------- */

    function _signCVIClaim(address wallet, bytes32 credentialHash, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ISSUER_PK, complianceGate.hashCVIClaim(wallet, credentialHash, nonce));
        return abi.encodePacked(r, s, v);
    }

    function _verify(address wallet, bytes32 credentialHash) internal {
        complianceGate.verifyCVI(wallet, _signCVIClaim(wallet, credentialHash, complianceGate.credentialNonce(wallet)), credentialHash);
    }

    function _verifyUntil(address wallet, bytes32 credentialHash, uint64 expiry) internal {
        uint256 nonce = complianceGate.credentialNonce(wallet);
        bytes32 digest = complianceGate.hashCVIClaimWithExpiry(wallet, credentialHash, expiry, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ISSUER_PK, digest);
        complianceGate.verifyCVIWithExpiry(wallet, abi.encodePacked(r, s, v), credentialHash, expiry, nonce);
    }

    function _verifyAlice() internal {
        _verify(alice, keccak256("ccp:alice"));
    }

    function _commit(RiskEnvelope memory envelope) internal {
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);
    }

    /// @dev The envelope the SDK would build for a CVA settlement cycle.
    function _cvaEnvelope(uint256 maxSpendUsd) internal view returns (RiskEnvelope memory) {
        string[] memory actions = new string[](3);
        actions[0] = "cva.transfer";
        actions[1] = "cva.settle";
        actions[2] = "web.search";
        return RiskEnvelope({maxSpendUsd: maxSpendUsd, allowedActions: actions, deadline: uint64(block.timestamp + 1 hours)});
    }

    function _gateAllows() internal view returns (bool allowed) {
        (allowed,,) = vault.checkGate(agentId, intentHash);
    }

    /* ------------------------------- the CVI hook ------------------------------ */

    function test_CheckGate_BlocksCVAIntentWithoutCVI() public {
        _commit(_cvaEnvelope(500e6));

        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertFalse(allowed);
        assertEq(score, 78);
        assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));

        (bool allowed2,, GateReason reason2, address blocker) = vault.checkGateWithCVI(agentId, intentHash);
        assertFalse(allowed2);
        assertEq(uint256(reason2), uint256(GateReason.CVI_UNVERIFIED));
        assertEq(blocker, alice, "the originator is the wallet needing a CVI credential");

        assertTrue(vault.requiresCVI(agentId, intentHash));
        assertEq(vault.cviBlocker(agentId, intentHash), alice);

        string[] memory matching = vault.cvaActionsOf(agentId, intentHash);
        assertEq(matching.length, 2);
        assertEq(matching[0], "cva.transfer");
        assertEq(matching[1], "cva.settle");
    }

    function test_ExecuteFnNeverRuns_WhileCVIMissing() public {
        _commit(_cvaEnvelope(500e6));

        // The agent runtime re-checks the gate, exactly like avaira.run() does.
        vm.expectRevert(abi.encodeWithSelector(GatedCVAExecutor.GateClosed.selector, GateReason.CVI_UNVERIFIED));
        executor.execute(agentId, intentHash, cvaHolder, cvaRecipient, 10e18);

        assertEq(cva.balanceOf(cvaRecipient), 0, "no asset moved");
        assertFalse(vault.getIntent(agentId, intentHash).executed);

        // Even bypassing the gate entirely, the token itself refuses the unverified recipient.
        vm.prank(cvaHolder);
        vm.expectRevert();
        cva.transfer(bob, 10e18);
    }

    function test_CheckGate_BlocksOperatorWithNoCredentialAtAll() public {
        uint256 carolAgent = _activeAgent(carol, MIN_STAKE, 78);
        vm.prank(carol);
        vault.commitIntent(carolAgent, intentHash, _cvaEnvelope(500e6));

        (, , GateReason reason, address blocker) = vault.checkGateWithCVI(carolAgent, intentHash);
        assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));
        assertEq(blocker, carol);
        assertEq(uint256(complianceGate.credentialStatusOf(carol)), uint256(CVIStatus.NONE));

        _verify(carol, keccak256("ccp:carol"));
        (, , reason,) = vault.checkGateWithCVI(carolAgent, intentHash);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));
    }

    function test_CheckGate_AllowsCVAIntentOnceOriginatorVerified() public {
        _commit(_cvaEnvelope(500e6));
        _verifyAlice();

        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertTrue(allowed);
        assertEq(score, 78);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));

        executor.execute(agentId, intentHash, cvaHolder, cvaRecipient, 10e18);
        assertEq(cva.balanceOf(cvaRecipient), 10e18);
    }

    function test_CheckGate_BlocksAfterRevocation() public {
        _commit(_cvaEnvelope(500e6));
        _verifyAlice();
        assertTrue(_gateAllows());

        vm.prank(issuer);
        complianceGate.revokeCVI(alice);

        (, , GateReason reason, address blocker) = vault.checkGateWithCVI(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));
        assertEq(blocker, alice);

        vm.expectRevert(abi.encodeWithSelector(GatedCVAExecutor.GateClosed.selector, GateReason.CVI_UNVERIFIED));
        executor.execute(agentId, intentHash, cvaHolder, cvaRecipient, 10e18);
    }

    function test_CheckGate_BlocksAfterExpiry() public {
        // A credential valid for five minutes against a one-hour envelope window.
        uint64 expiry = uint64(block.timestamp + 5 minutes);
        _verifyUntil(alice, keccak256("ccp:alice:short"), expiry);
        _commit(_cvaEnvelope(500e6));
        assertTrue(_gateAllows());

        vm.warp(expiry);
        (, , GateReason reason, address blocker) = vault.checkGateWithCVI(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));
        assertEq(blocker, alice);
        assertEq(uint256(complianceGate.credentialStatusOf(alice)), uint256(CVIStatus.EXPIRED));

        // Refreshing the credential clears the gate again.
        _verifyUntil(alice, keccak256("ccp:alice:renewed"), uint64(block.timestamp + 1 days));
        (, , reason,) = vault.checkGateWithCVI(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));
    }

    /// @dev The agent's bound execution wallet is the second Travel-Rule party: verifying the
    ///      operator alone is not enough once a dedicated execution wallet is bound.
    function test_CheckGate_RequiresCVIForBoundAgentWalletToo() public {
        address executionWallet = vm.addr(WALLET_PK);
        uint256 nonce = identity.agentWalletNonce(agentId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = identity.hashAgentWalletSet(agentId, executionWallet, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);

        vm.prank(alice);
        identity.setAgentWallet(agentId, executionWallet, deadline, abi.encodePacked(r, s, v));

        _verifyAlice();
        _commit(_cvaEnvelope(500e6));

        (, , GateReason reason, address blocker) = vault.checkGateWithCVI(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));
        assertEq(blocker, executionWallet, "the bound execution wallet must hold its own credential");

        _verify(executionWallet, keccak256("ccp:execution-wallet"));
        assertTrue(_gateAllows());
    }

    function test_CheckGate_DoesNotTouchNonCVAY_Intents() public {
        RiskEnvelope memory envelope =
            _envelope2(50e6, "perpl.place_order", "perpl.cancel_order", uint64(block.timestamp + 1 hours));
        _commit(envelope);

        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED), "perpl.* intents are unaffected by the CVI hook");
        assertFalse(vault.requiresCVI(agentId, intentHash));
    }

    function test_ComplianceHook_BackwardsCompatibleWhenGateUnset() public {
        vm.prank(owner);
        vault.setComplianceGate(address(0));
        _commit(_cvaEnvelope(500e6));

        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));
    }

    function test_SetComplianceGate_AdminOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setComplianceGate(address(complianceGate));
    }

    function test_RecordCVIRequirement_TracesTheWallet() public {
        _commit(_cvaEnvelope(500e6));

        vm.expectEmit(true, true, false, true, address(vault));
        emit IAvairaIntentVault.CVIRequirementChecked(agentId, intentHash, alice, false);
        vm.prank(alice);
        vault.recordCVIRequirement(agentId, intentHash);

        _verifyAlice();
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAvairaIntentVault.CVIRequirementChecked(agentId, intentHash, alice, true);
        vm.prank(alice);
        vault.recordCVIRequirement(agentId, intentHash);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.NotAgentOperator.selector, agentId, bob));
        vault.recordCVIRequirement(agentId, intentHash);
    }

    function test_CheckGate_UncommittedCVAIntentStillReportsNotCommitted() public {
        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.INTENT_NOT_COMMITTED));
    }

    /* ----------------------------------- fuzz ---------------------------------- */

    /// @dev For any spend limit and any non-CVI action list, the hook stays out of the way;
    ///      the moment a `cva.*` action appears the intent is blocked until verified.
    function testFuzz_CVAIntentsAlwaysRequireCVI(uint96 spend, bool includeCVA) public {
        string[] memory actions = new string[](2);
        actions[0] = "web.search";
        actions[1] = includeCVA ? "cva.transfer" : "mcp.call";

        RiskEnvelope memory envelope =
            RiskEnvelope({maxSpendUsd: uint256(spend), allowedActions: actions, deadline: uint64(block.timestamp + 1 hours)});
        _commit(envelope);

        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        if (includeCVA) {
            assertEq(uint256(reason), uint256(GateReason.CVI_UNVERIFIED));
        } else {
            assertEq(uint256(reason), uint256(GateReason.ALLOWED));
        }
    }

    /// @dev Verified operators can settle any amount that fits the committed envelope.
    function testFuzz_VerifiedOperatorSettles(uint128 amount) public {
        uint256 bounded = bound(uint256(amount), 1, 1_000e18);
        _verifyAlice();
        _commit(_cvaEnvelope(1_000e18));

        executor.execute(agentId, intentHash, cvaHolder, cvaRecipient, bounded);
        assertEq(cva.balanceOf(cvaRecipient), bounded);
    }
}
