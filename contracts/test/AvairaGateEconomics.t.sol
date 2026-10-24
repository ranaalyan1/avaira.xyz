// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GateReason} from "avaira/interfaces/IAvaira.sol";
import {AgentStatus, SlashLevel} from "avaira/lib/AvairaTypes.sol";
import {RiskEnvelope, RiskEnvelopeLib} from "avaira/lib/AvairaTypes.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaGateEconomicsTest — adversarial coverage for the pre-execution gate
/// @dev STATE.md used to list `checkGate` as "never invoked outside its own definition".
///      This suite exists to close that gap: every branch of all three overloads is
///      exercised at its *boundary*, not just the happy path. If you change the gate's
///      semantics and this suite still passes without edits, you are probably wrong.
contract AvairaGateEconomicsTest is AvairaFixture {
    uint256 internal agentId;
    bytes32 internal intentHash = keccak256("gate-economics:intent:1");
    RiskEnvelope internal envelope;

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(alice, MIN_STAKE, 78);

        envelope = _envelope(10e6, "web.search", uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        vault.commitIntent(agentId, intentHash, envelope);
    }

    /* ------------------------- overload 1: agent-level gate ------------------------- */

    function test_Gate_Open_WhenAtExactBoundaries() public {
        // Score exactly at minScore and stake exactly at minStake must pass — the
        // comparisons are >=, and a > boundary would silently lock out the median agent.
        _setScore(agentId, MIN_SCORE);
        (bool allowed, uint8 score, GateReason reason) = vault.checkGate(agentId);
        assertTrue(allowed, "exact-boundary agent must pass");
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
        assertEq(score, MIN_SCORE);
    }

    function test_Gate_Closed_ScoreOneBelowMinimum() public {
        _setScore(agentId, MIN_SCORE - 1);
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.SCORE_TOO_LOW));
    }

    function test_Gate_Closed_StakeOneBelowMinimum() public {
        // Withdraw exactly 1 wei of stake, taking the agent one wei below minStake.
        // The economic claim "gate enforces skin in the game" dies on an off-by-one.
        vm.prank(alice);
        stakeRegistry.unstake(agentId, 1);
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.STAKE_TOO_LOW));
    }

    function test_Gate_Closed_UnknownAgent() public view {
        (bool allowed,, GateReason reason) = vault.checkGate(999_999);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.UNKNOWN_AGENT));
    }

    function test_Gate_Closed_WhenIdentityBanned_AgainstStakeMirrorDrift() public {
        // Ban applied *directly* at the identity registry while the stake registry
        // still reports ACTIVE — the A3 regression the gate must not lose.
        vm.prank(owner);
        identity.banAgent(agentId, "gate-economics-test");
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed, "identity-level ban must close the gate");
        assertEq(uint8(reason), uint8(GateReason.BANNED));
    }

    function test_Gate_Closed_Suspended() public {
        vm.startPrank(owner);
        stakeRegistry.setSlasher(owner, true);
        stakeRegistry.slashAgent(agentId, SlashLevel.SUSPENSION, treasury, bytes32("econ"), "suspension-test");
        vm.stopPrank();
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.SUSPENDED));
    }

    /* --------------------- overload 2: agent + intent gate --------------------- */

    function test_IntentGate_Open_OnValidCommittedIntent() public {
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_IntentGate_Closed_UnknownIntent() public {
        (bool allowed,, GateReason reason) =
            vault.checkGate(agentId, keccak256("gate-economics:never-committed"));
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.INTENT_NOT_COMMITTED));
    }

    function test_IntentGate_Boundary_DeadlineExactlyNowIsExpired() public {
        // Deadline == now is expired (deadline <= block.timestamp). Pin it: an agent
        // racing the last second must NOT slip through.
        vm.warp(envelope.deadline);
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertFalse(allowed, "deadline == now must be expired");
        assertEq(uint8(reason), uint8(GateReason.INTENT_EXPIRED));
    }

    function test_IntentGate_Open_DeadlineOneSecondBeforeExpiry() public {
        vm.warp(envelope.deadline - 1);
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertTrue(allowed, "deadline - 1 must still be live");
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_IntentGate_Closed_AfterExecution() public {
        (bool okBefore,,) = vault.checkGate(agentId, intentHash);
        assertTrue(okBefore);
        vm.prank(alice);
        vault.attestOutcome(agentId, intentHash, bytes32(uint256(1)), bytes32(uint256(2)));
        (bool allowed,, GateReason reason) = vault.checkGate(agentId, intentHash);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.INTENT_ALREADY_EXECUTED));
    }

    /* -------------------- overload 3: agent + intent + envelope ------------------- */

    function test_EnvelopeGate_Open_WhenEnvelopeHashMatches() public {
        (bool allowed,, GateReason reason) =
            vault.checkGate(agentId, intentHash, RiskEnvelopeLib.hash(envelope));
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(GateReason.ALLOWED));
    }

    function test_EnvelopeGate_Closed_OnEnvelopeMismatch() public {
        // A single flipped bit in the envelope must close the gate — this is the
        // last line of defence against envelope substitution after commitment.
        RiskEnvelope memory tampered = envelope;
        tampered.maxSpendUsd = envelope.maxSpendUsd + 1;
        (bool allowed,, GateReason reason) =
            vault.checkGate(agentId, intentHash, RiskEnvelopeLib.hash(tampered));
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.ENVELOPE_MISMATCH));
    }

    /* --------------------- gate ordering / priority regression --------------------- */

    function test_Gate_ReasonPriority_BannedBeatsEverything() public {
        // A banned agent with a low score and low stake must report BANNED, not the
        // softer reasons — consumers key off the reason enum.
        _setScore(agentId, 0);
        vm.prank(owner);
        identity.banAgent(agentId, "gate-economics-test");
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(GateReason.BANNED), "ban must outrank score/stake");
    }

    function test_Gate_StateTransition_ClosesImmediatelyAfterSlash() public {
        // The window between "slash decided" and "agent notices" is when the gate
        // matters most: it must close on the same tx the slash lands.
        (bool open,,) = vault.checkGate(agentId);
        assertTrue(open);
        vm.startPrank(owner);
        stakeRegistry.setSlasher(owner, true);
        stakeRegistry.slashAgent(agentId, SlashLevel.BAN, treasury, bytes32("econ"), "ban-test");
        vm.stopPrank();
        (bool allowed,, GateReason reason) = vault.checkGate(agentId);
        assertFalse(allowed, "gate must close the moment stake drops");
        assertTrue(
            reason == GateReason.STAKE_TOO_LOW || reason == GateReason.BANNED
                || reason == GateReason.SUSPENDED,
            "some closed reason required"
        );
    }
}
