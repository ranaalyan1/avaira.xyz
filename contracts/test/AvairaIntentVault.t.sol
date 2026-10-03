// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";
import {GateReason, DeviationLeaf, IAvairaIntentVault} from "avaira/interfaces/IAvaira.sol";
import {AgentStatus, SlashLevel, RiskEnvelope, RiskEnvelopeLib} from "avaira/lib/AvairaTypes.sol";
import {MerkleLib} from "avaira/lib/MerkleLib.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaIntentVaultTest — Component 4 (Proof-of-Intent + pre-execution gate)
/// @dev This is the primitive the whole submission rests on: commit the plan, gate
///      before acting, anchor the outcome, and let anyone prove a deviation.
contract AvairaIntentVaultTest is AvairaFixture {
    uint256 internal agentId;
    bytes32 internal intentHash = keccak256("intent:research-task:1");

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(alice, MIN_STAKE, 78);
    }

    /* ------------------------------ proof of intent --------------------------- */

    function test_CommitIntent_StoresEnvelopeAndEmits() public {
        RiskEnvelope memory envelope = _envelope2(50e6, "web.search", "mcp.call", uint64(block.timestamp + 1 hours));
        bytes32 expectedEnvelopeHash = RiskEnvelopeLib.hash(envelope);

        vm.expectEmit(true, true, false, true, address(vault));
        emit IAvairaIntentVault.IntentCommitted(agentId, intentHash, expectedEnvelopeHash, envelope.deadline, 50e6);

        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        AvairaIntentVault.Intent memory intent = vault.getIntent(agentId, intentHash);
        assertEq(intent.agentId, agentId);
        assertEq(intent.maxSpendUsd, 50e6);
        assertEq(intent.envelopeHash, expectedEnvelopeHash);
        assertEq(intent.committedAt, uint64(block.timestamp));
        assertFalse(intent.executed);
        assertEq(intent.committer, alice);

        string[] memory actions = vault.allowedActionsOf(agentId, intentHash);
        assertEq(actions.length, 2);
        assertEq(actions[0], "web.search");
        assertEq(actions[1], "mcp.call");
    }

    function test_CommitIntent_RejectsDuplicatesExpiredEnvelopesAndStrangers() public {
        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.NotAgentOperator.selector, agentId, bob));
        vault.commitIntent(agentId, intentHash, envelope);

        RiskEnvelope memory expired = _envelope(10e6, "web.search", uint64(block.timestamp));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.EnvelopeExpired.selector, uint64(block.timestamp)));
        vault.commitIntent(agentId, intentHash, expired);

        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.IntentAlreadyCommitted.selector, agentId, intentHash));
        vault.commitIntent(agentId, intentHash, envelope);
    }

    function test_CommitIntent_RejectsUnboundedActionLists() public {
        string[] memory many = new string[](33);
        for (uint256 i; i < 33; ++i) {
            many[i] = "action";
        }
        RiskEnvelope memory envelope =
            RiskEnvelope({maxSpendUsd: 1e6, allowedActions: many, deadline: uint64(block.timestamp + 1 hours)});

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.TooManyActions.selector, 33));
        vault.commitIntent(agentId, intentHash, envelope);
    }

    /* ----------------------------------- gate --------------------------------- */

    function test_CheckGate_AllowsHealthyAgent() public {
        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(agentId);
        assertTrue(allowed);
        assertEq(score, 78);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));
    }

    function test_CheckGate_ReasonCodes() public {
        // Unknown agent
        (bool allowed,, GateReason reason) = vault.checkGate(4242);
        assertFalse(allowed);
        assertEq(uint256(reason), uint256(GateReason.UNKNOWN_AGENT));

        // Stake too low
        vm.prank(alice);
        stakeRegistry.unstake(agentId, 1);
        (, , reason) = vault.checkGate(agentId);
        assertEq(uint256(reason), uint256(GateReason.STAKE_TOO_LOW));

        vm.prank(alice);
        stakeRegistry.stake(agentId, 1);

        // Score too low
        _setScore(agentId, MIN_SCORE - 1);
        (, , reason) = vault.checkGate(agentId);
        assertEq(uint256(reason), uint256(GateReason.SCORE_TOO_LOW));

        // Suspended
        _setScore(agentId, 80);
        vm.prank(owner);
        stakeRegistry.slashAgent(agentId, SlashLevel.SUSPENSION, address(0), bytes32(0), "test");
        (, , reason) = vault.checkGate(agentId);
        assertEq(uint256(reason), uint256(GateReason.SUSPENDED));

        // Banned
        vm.prank(owner);
        stakeRegistry.slashAgent(agentId, SlashLevel.BAN, address(0), bytes32(0), "test");
        (, , reason) = vault.checkGate(agentId);
        assertEq(uint256(reason), uint256(GateReason.BANNED));
    }

    function test_CheckGate_BoundToIntent() public {
        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.INTENT_NOT_COMMITTED));

        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);
        bool allowed;
        (allowed, , reason) = vault.checkGate(agentId, intentHash);
        assertTrue(allowed);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));

        // Expired
        vm.warp(block.timestamp + 2 hours);
        (, , reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.INTENT_EXPIRED));
    }

    function test_CheckGate_DetectsEnvelopeMismatch() public {
        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        bytes32 onchainHash = RiskEnvelopeLib.hash(envelope);
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash, onchainHash);
        assertTrue(allowed);
        assertEq(uint256(reason), uint256(GateReason.ALLOWED));

        // What the SDK would compute from a *different* local envelope.
        RiskEnvelope memory tampered = _envelope(500e6, "web.search", uint64(block.timestamp + 1 hours));
        (allowed,, reason) = vault.checkGate(agentId, intentHash, RiskEnvelopeLib.hash(tampered));
        assertFalse(allowed);
        assertEq(uint256(reason), uint256(GateReason.ENVELOPE_MISMATCH));
    }

    function test_CheckGate_IntentAlreadyExecuted() public {
        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);
        vm.prank(alice);
        vault.attestOutcome(agentId, intentHash, keccak256("outcome"), bytes32(0));

        (, , GateReason reason) = vault.checkGate(agentId, intentHash);
        assertEq(uint256(reason), uint256(GateReason.INTENT_ALREADY_EXECUTED));
    }

    function test_RecordGateDecision_OnlyAgentOperator() public {
        vm.prank(alice);
        vault.recordGateDecision(agentId, intentHash, false, GateReason.SCORE_TOO_LOW, 412);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.NotAgentOperator.selector, agentId, bob));
        vault.recordGateDecision(agentId, intentHash, true, GateReason.ALLOWED, 1);
    }

    /* ------------------------------ outcome anchoring ------------------------- */

    function test_AttestOutcome_AnchorsRootAndOpensChallengeWindow() public {
        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        bytes32 outcomeHash = keccak256("outcome");
        bytes32 root = keccak256("root");
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAvairaIntentVault.OutcomeAttested(
            agentId, intentHash, outcomeHash, root, uint64(block.timestamp + CHALLENGE_WINDOW)
        );
        vm.prank(alice);
        vault.attestOutcome(agentId, intentHash, outcomeHash, root);

        AvairaIntentVault.Intent memory intent = vault.getIntent(agentId, intentHash);
        assertTrue(intent.executed);
        assertEq(intent.outcomeRoot, root);
        assertEq(intent.challengeEndsAt, uint64(block.timestamp + CHALLENGE_WINDOW));
        assertTrue(vault.isChallengeOpen(agentId, intentHash));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.OutcomeAlreadyAttested.selector, agentId, intentHash));
        vault.attestOutcome(agentId, intentHash, outcomeHash, root);
    }

    function test_AttestOutcome_RequiresCommitmentAndOperator() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.UnknownIntent.selector, agentId, intentHash));
        vault.attestOutcome(agentId, intentHash, keccak256("o"), bytes32(0));

        RiskEnvelope memory envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.NotAgentOperator.selector, agentId, bob));
        vault.attestOutcome(agentId, intentHash, keccak256("o"), bytes32(0));
    }

    /* --------------------------- deviation challenges ------------------------- */

    function test_Challenge_UpheldOnOverspend() public {
        // Envelope allows up to 50 USDC of spend on web.search.
        (bytes32 root, bytes32[] memory proofs) = _commitAttestAndBuildTree(alice, 50e6, "web.search");

        // The agent actually spent 900 USDC — 18x its committed ceiling.
        DeviationLeaf memory leaf = _leaf("web.search", 900e6, 0);
        uint256 stakeBefore = stakeRegistry.stakeOf(agentId);
        uint256 challengerBefore = usdc.balanceOf(carol);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAvairaIntentVault.DeviationUpheld(agentId, intentHash, carol, CHALLENGER_BOND, stakeBefore / 2);
        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, leaf, proofs);

        AvairaIntentVault.Intent memory intent = vault.getIntent(agentId, intentHash);
        assertTrue(intent.deviationUpheld);
        assertEq(stakeRegistry.stakeOf(agentId), stakeBefore / 2, "SUSPENSION halves the stake");
        assertEq(uint256(stakeRegistry.statusOf(agentId)), uint256(AgentStatus.SUSPENDED));

        // Challenger: bond refunded + half of the slashed stake as bounty.
        assertEq(usdc.balanceOf(carol), challengerBefore + (stakeBefore / 2) / 2, "bounty only, bond returned");
        assertEq(root, keccak256(abi.encode("sanity")) == bytes32(0) ? bytes32(0) : root);
    }

    function test_Challenge_UpheldOnActionOutsideEnvelope() public {
        _commitAttestAndBuildTree(alice, 50e6, "web.search");

        // Spend is fine, but the action was never allowed (leaf index 2 of the tree).
        DeviationLeaf memory leaf = _leaf("wallet.transfer", 1e6, 2);
        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, leaf, _proofForHashed(_threeHashedLeaves(), 2));
        assertTrue(vault.getIntent(agentId, intentHash).deviationUpheld);
    }

    function test_Challenge_RejectedWhenOutcomeStayedInsideEnvelope() public {
        (bytes32 root, bytes32[] memory proofs) = _commitAttestAndBuildTree(alice, 50e6, "web.search");
        assertTrue(root != bytes32(0));

        DeviationLeaf memory leaf = _leaf("web.search", 12e6, 0); // within budget, allowed action
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAvairaIntentVault.ChallengeRejected(agentId, intentHash, carol, CHALLENGER_BOND);
        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, leaf, proofs);

        assertFalse(vault.getIntent(agentId, intentHash).deviationUpheld);
        assertEq(stakeRegistry.stakeOf(agentId), MIN_STAKE, "no slash for a compliant outcome");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + CHALLENGER_BOND, "griefer bond is forfeited");
    }

    function test_Challenge_RejectedOnForgedProof() public {
        _commitAttestAndBuildTree(alice, 50e6, "web.search");

        // A leaf the agent never published: correct shape, wrong tree.
        DeviationLeaf memory fake = _leaf("web.search", 9_000e6, 42);
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = keccak256("nope");
        proof[1] = keccak256("nope2");

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, fake, proof);

        assertFalse(vault.getIntent(agentId, intentHash).deviationUpheld);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + CHALLENGER_BOND, "forged proof costs the bond");
    }

    function test_Challenge_RevertsOutsideWindowAndOnMismatchedLeaf() public {
        (, bytes32[] memory proofs) = _commitAttestAndBuildTree(alice, 50e6, "web.search");
        DeviationLeaf memory leaf = _leaf("web.search", 900e6, 0);

        // Wrong intent hash in the leaf
        DeviationLeaf memory wrong = leaf;
        wrong.intentHash = keccak256("other");
        vm.prank(carol);
        vm.expectRevert(AvairaIntentVault.LeafMismatch.selector);
        vault.challengeDeviation(agentId, intentHash, wrong, proofs);

        // Wrong agent id in the leaf
        wrong = leaf;
        wrong.agentId = 999;
        vm.prank(carol);
        vm.expectRevert(AvairaIntentVault.LeafMismatch.selector);
        vault.challengeDeviation(agentId, intentHash, wrong, proofs);

        // Window closed
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaIntentVault.ChallengeWindowClosed.selector, uint64(block.timestamp - 1))
        );
        vault.challengeDeviation(agentId, intentHash, leaf, proofs);
    }

    function test_Challenge_RevertsBeforeAttestationAndWhenAlreadyChallenged() public {
        // A second, committed-but-not-yet-executed intent: challenging it must fail.
        bytes32 pendingHash = keccak256("intent:research-task:2");
        RiskEnvelope memory envelope = _envelope(50e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, pendingHash, envelope);

        DeviationLeaf memory pendingLeaf =
            DeviationLeaf({agentId: agentId, intentHash: pendingHash, action: "web.search", spendUsd: 900e6, nonce: 0});
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.OutcomeNotAttested.selector, agentId, pendingHash));
        vault.challengeDeviation(agentId, pendingHash, pendingLeaf, empty);

        (, bytes32[] memory proofs) = _commitAttestAndBuildTree(alice, 50e6, "web.search");
        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, _leaf("web.search", 900e6, 0), proofs);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaIntentVault.AlreadyChallenged.selector, agentId, intentHash));
        vault.challengeDeviation(agentId, intentHash, _leaf("web.search", 800e6, 1), proofs);
    }

    function test_Challenge_ZeroBondConfigurationStillWorks() public {
        vm.prank(owner);
        vault.setChallengerBond(0);
        (, bytes32[] memory proofs) = _commitAttestAndBuildTree(alice, 50e6, "web.search");

        vm.prank(carol);
        vault.challengeDeviation(agentId, intentHash, _leaf("web.search", 900e6, 0), proofs);
        assertTrue(vault.getIntent(agentId, intentHash).deviationUpheld);
    }

    /* ---------------------------------- admin --------------------------------- */

    function test_Admin_Configuration() public {
        vm.prank(owner);
        vault.setChallengeWindow(1 hours);
        assertEq(vault.challengeWindow(), 1 hours);

        vm.prank(owner);
        vault.setChallengerBond(1e6);
        assertEq(vault.challengerBond(), 1e6);

        vm.prank(bob);
        vm.expectRevert();
        vault.setChallengeWindow(2 hours);
    }

    /* --------------------------------- helpers -------------------------------- */

    /// @dev The three leaves anchored by `_commitAttestAndBuildTree`.
    function _threeHashedLeaves() internal view returns (bytes32[] memory hashed) {
        hashed = new bytes32[](3);
        hashed[0] = MerkleLib.hashDeviationLeaf(_leaf("web.search", 900e6, 0));
        hashed[1] = MerkleLib.hashDeviationLeaf(_leaf("web.search", 1e6, 1));
        hashed[2] = MerkleLib.hashDeviationLeaf(_leaf("wallet.transfer", 1e6, 2));
    }

    function _proofForHashed(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        return _proof(leaves, index);
    }

    function _leaf(string memory action, uint256 spendUsd, uint256 nonce)
        internal
        view
        returns (DeviationLeaf memory)
    {
        return DeviationLeaf({agentId: agentId, intentHash: intentHash, action: action, spendUsd: spendUsd, nonce: nonce});
    }

    /// @dev Commits an intent, executes it, and anchors a Merkle root over three leaves.
    ///      Returns a proof for leaf index 0; use `_proofForLeaves` for other indices.
    function _commitAttestAndBuildTree(address who, uint256 maxSpendUsd, string memory allowedAction)
        internal
        returns (bytes32 root, bytes32[] memory proofsForFirstLeaf)
    {
        RiskEnvelope memory envelope = _envelope(maxSpendUsd, allowedAction, uint64(block.timestamp + 1 hours));
        vm.prank(who);
        vault.commitIntent(agentId, intentHash, envelope);

        DeviationLeaf[] memory leaves = new DeviationLeaf[](3);
        leaves[0] = _leaf("web.search", 900e6, 0);
        leaves[1] = _leaf("web.search", 1e6, 1);
        leaves[2] = _leaf("wallet.transfer", 1e6, 2);

        bytes32[] memory hashed = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            hashed[i] = MerkleLib.hashDeviationLeaf(leaves[i]);
        }
        root = MerkleLib.root(hashed);
        proofsForFirstLeaf = _proof(hashed, 0);

        vm.prank(who);
        vault.attestOutcome(agentId, intentHash, keccak256("outcome"), root);
    }

    /// @dev Sorted-pair proof generator mirroring MerkleLib.root (odd nodes promoted).
    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        uint256 len = leaves.length;
        bytes32[] memory level = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            level[i] = MerkleLib.hashLeaf(leaves[i]);
        }
        bytes32[] memory buffer = new bytes32[](64);
        uint256 depth;

        while (len > 1) {
            uint256 next = (len + 1) / 2;
            bool promoted = len % 2 == 1 && index == len - 1;
            if (!promoted) {
                uint256 sibling = index % 2 == 0 ? index + 1 : index - 1;
                buffer[depth++] = level[sibling];
            }

            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i; i < next; ++i) {
                uint256 left = 2 * i;
                uint256 right = left + 1;
                parents[i] = right < len ? MerkleLib.hashPair(level[left], level[right]) : level[left];
            }
            level = parents;
            len = next;
            index /= 2;
        }

        proof = new bytes32[](depth);
        for (uint256 i; i < depth; ++i) {
            proof[i] = buffer[i];
        }
    }
}
