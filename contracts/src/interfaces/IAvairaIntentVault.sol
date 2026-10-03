// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RiskEnvelope, DeviationProof} from "./IAvairaTypes.sol";

/// @title IAvairaIntentVault — Proof-of-Intent: commit before you act, prove after.
/// @notice The novel primitive. An agent hashes its full plan + parameters, commits the
///         hash onchain together with a {RiskEnvelope}, then executes. Afterwards it
///         anchors the outcome hash and the Merkle root of its local hash-chained audit
///         trail. Anyone holding a Merkle proof of a leaf that violates the envelope can
///         challenge inside the challenge window and take the agent's stake.
interface IAvairaIntentVault {
    event IntentCommitted(
        uint256 indexed intentId,
        uint256 indexed agentId,
        bytes32 indexed intentHash,
        uint256 maxSpendUsd,
        uint64 deadline,
        string[] allowedActions
    );
    event OutcomeAttested(
        uint256 indexed intentId,
        uint256 indexed agentId,
        bytes32 intentHash,
        bytes32 outcomeHash,
        bytes32 merkleRoot,
        uint64 attestedAt
    );
    event IntentChallenged(uint256 indexed intentId, bytes32 indexed intentHash, bool upheld);
    event IntentFinalized(uint256 indexed intentId, bytes32 indexed intentHash, uint64 finalizedAt);
    event GateEvaluated(uint256 indexed agentId, bool allowed, uint8 score, string reason);

    struct IntentRecord {
        uint256 agentId;
        bytes32 intentHash;
        uint64 committedAt;
        uint64 deadline;
        uint64 attestedAt;
        uint256 maxSpendUsd;
        bytes32 merkleRoot;
        bytes32 outcomeHash;
        bool attested;
        bool challenged;
        bool finalized;
        string[] allowedActions;
    }

    /// @notice Commit a plan hash + risk envelope before execution.
    function commitIntent(uint256 agentId, bytes32 intentHash, RiskEnvelope calldata envelope)
        external
        returns (uint256 intentId);

    /// @notice Anchor the outcome hash and the Merkle root of the local audit trail.
    function attestOutcome(uint256 agentId, bytes32 intentHash, bytes32 outcomeHash, bytes32 merkleRoot) external;

    /// @notice THE GATE. Returns (allowed, score). Refuses when the agent is not ACTIVE,
    ///         its score is below the floor, or its stake is below the minimum.
    function checkGate(uint256 agentId) external view returns (bool allowed, uint8 score);

    /// @notice Gate with a machine-readable refusal reason (for SDK logs / metrics).
    function checkGateVerbose(uint256 agentId)
        external
        view
        returns (bool allowed, uint8 score, uint8 status, string memory reason);

    /// @notice `(valid, severe)` — validates a deviation proof for `agentId` against the
    ///         anchored Merkle root. `valid` is false when the intent is unknown, not yet
    ///         attested, already challenged, outside its challenge window, or the proof
    ///         does not resolve to the anchored root. Callers MUST treat false as
    ///         "proof rejected" and never as a revert.
    function verifyDeviation(uint256 agentId, bytes32 intentHash, DeviationProof calldata proof)
        external
        view
        returns (bool valid, bool severe);

    /// @notice Called by the stake registry after a challenge is settled, to burn the
    ///         intent so the same deviation cannot be slashed twice.
    function markChallenged(bytes32 intentHash) external;

    /// @notice True when `action` is inside `agentId`'s committed envelope for `intentHash`.
    function isActionCommitted(bytes32 intentHash, string calldata action) external view returns (bool);

    /// @notice Finalise an intent whose challenge window has closed.
    function finalizeIntent(bytes32 intentHash) external;

    function intentOf(bytes32 intentHash) external view returns (IntentRecord memory);
}
