// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Component 4 of 6: AvairaIntentVault — Proof-of-Intent + the real-time gate
        -------------------------------------------------------------------------
        THE NOVEL PRIMITIVE.

        x402 lets an agent pay. ERC-8004 lets an agent be identified. Neither stops an
        agent from doing something it never promised to do, and neither can refuse an
        action *before* it happens. Post-hoc reputation (Assay Protocol on Base,
        Yelden's isEligible() registry) tells you an agent was bad; Avaira tells it no.

        The protocol is three calls:

          1. commitIntent(agentId, intentHash, RiskEnvelope)   — hash your plan first
          2. checkGate(agentId)                                — a VIEW, sub-second
          3. attestOutcome(agentId, intentHash, outcomeHash, merkleRoot)

        and one consequence:

          verifyDeviation(...) + the stake registry's challenge window — a Merkle proof
          that the executed outcome left the committed envelope burns the agent's stake
          and pays the challenger.

        Why Monad: the gate is the product, and it only works if it is cheap and fast
        enough to sit in the hot path of every single agent action. At 400 ms blocks /
        800 ms finality / ~$0.005 per transaction, a gate that costs a fraction of a cent
        and resolves inside one block is a feature; on a 12-second Ethereum block it is a
        denial of service. Measured gate latency is published in /api/metrics.
//////////////////////////////////////////////////////////////////////////////*/

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaIntentVault} from "./interfaces/IAvairaIntentVault.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";
import {IAvairaStakeRegistry} from "./interfaces/IAvairaStakeRegistry.sol";
import {RiskEnvelope, DeviationProof, AgentStatus, SlashLevel} from "./interfaces/IAvairaTypes.sol";
import {MerkleLib} from "./libraries/MerkleLib.sol";

contract AvairaIntentVault is IAvairaIntentVault, Ownable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    IAvairaStakeRegistry public stakeRegistry;
    IAvairaIdentityRegistry public identity;

    /// @notice Grace period after `envelope.deadline` before an un-attested intent can
    ///         be punished — an agent that commits and then goes silent is not honest.
    uint64 public attestationGrace = 1 hours;

    uint256 public nextIntentId = 1;

    mapping(bytes32 intentHash => IntentRecord) private _intents;
    mapping(bytes32 intentHash => uint256 intentId) private _idCache;
    mapping(uint256 intentId => bytes32 intentHash) private _hashOfId;
    mapping(bytes32 intentHash => bool) public knownIntent;
    mapping(uint256 agentId => bytes32[] hashes) private _agentIntents;
    mapping(uint256 agentId => uint64 count) public intentsOfAgent;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error IntentAlreadyCommitted(bytes32 intentHash);
    error UnknownIntent(bytes32 intentHash);
    error NotAgentOperator(uint256 agentId, address caller);
    error EnvelopeExpired(uint64 deadline, uint256 timestamp);
    error EmptyEnvelope();
    error AlreadyAttested(bytes32 intentHash);
    error NotYetAttested(bytes32 intentHash);
    error ChallengeWindowClosed(bytes32 intentHash, uint64 closedAt);
    error AlreadyChallenged(bytes32 intentHash);
    error IntentNotFinalizable(bytes32 intentHash);
    error NotStakeRegistry(address caller);
    error AttestationNotOverdue(bytes32 intentHash, uint64 deadline);
    error ZeroHash();
    error AgentBannedOnchain(uint256 agentId);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address identity_, address stakeRegistry_) Ownable(initialOwner) {
        identity = IAvairaIdentityRegistry(identity_);
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
    }

    // -------------------------------------------------------------------------
    // 1. Commit — before execution
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIntentVault
    /// @dev Called fire-and-forget by the SDK: the SDK does not block on this transaction
    ///      before running the gate, because the gate is the enforcement point.
    function commitIntent(uint256 agentId, bytes32 intentHash, RiskEnvelope calldata envelope)
        external
        nonReentrant
        returns (uint256 intentId)
    {
        _requireAgentOperator(agentId);
        if (intentHash == bytes32(0)) revert ZeroHash();
        if (knownIntent[intentHash]) revert IntentAlreadyCommitted(intentHash);
        if (envelope.deadline <= block.timestamp) revert EnvelopeExpired(envelope.deadline, block.timestamp);
        if (envelope.allowedActions.length == 0) revert EmptyEnvelope();
        if (identity.isRegistered(agentId) == false) revert NotAgentOperator(agentId, msg.sender);
        if (stakeRegistry.statusOf(agentId) == AgentStatus.BANNED) revert AgentBannedOnchain(agentId);

        intentId = nextIntentId++;
        _hashOfId[intentId] = intentHash;
        _idCache[intentHash] = intentId;

        IntentRecord storage record = _intents[intentHash];
        record.agentId = agentId;
        record.intentHash = intentHash;
        record.committedAt = uint64(block.timestamp);
        record.deadline = envelope.deadline;
        record.maxSpendUsd = envelope.maxSpendUsd;
        record.allowedActions = envelope.allowedActions;

        knownIntent[intentHash] = true;
        _agentIntents[agentId].push(intentHash);
        intentsOfAgent[agentId] += 1;

        emit IntentCommitted(
            intentId, agentId, intentHash, envelope.maxSpendUsd, envelope.deadline, envelope.allowedActions
        );
    }

    // -------------------------------------------------------------------------
    // 2. Gate — the real-time refusal
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIntentVault
    function checkGate(uint256 agentId) external view returns (bool allowed, uint8 score) {
        score = stakeRegistry.score(agentId);
        allowed = stakeRegistry.isEligible(agentId);
    }

    /// @inheritdoc IAvairaIntentVault
    /// @dev Machine-readable refusal reason. The SDK surfaces this verbatim in the
    ///      "blocked" return value so the operator knows *why* nothing executed.
    function checkGateVerbose(uint256 agentId)
        external
        view
        returns (bool allowed, uint8 score, uint8 status, string memory reason)
    {
        AgentStatus agentStatus = stakeRegistry.statusOf(agentId);
        score = stakeRegistry.score(agentId);
        status = uint8(agentStatus);

        if (agentStatus == AgentStatus.ACTIVE) return (true, score, status, "eligible");
        if (agentStatus == AgentStatus.NONE) return (false, score, status, "agent has no stake position");
        if (agentStatus == AgentStatus.PENDING) return (false, score, status, "score below floor or stake below minimum");
        if (agentStatus == AgentStatus.SUSPENDED) return (false, score, status, "agent is suspended");
        return (false, score, status, "agent is banned");
    }

    /// @notice Non-view gate evaluation that emits an onchain event — used by the
    ///         dashboard and the latency harness so every refusal is publicly auditable.
    ///         Normal SDK path uses the free view {checkGate}; this costs gas by design.
    function recordGateCheck(uint256 agentId) external returns (bool allowed, uint8 score) {
        score = stakeRegistry.score(agentId);
        allowed = stakeRegistry.isEligible(agentId);
        string memory reason = allowed ? "eligible" : "refused";
        emit GateEvaluated(agentId, allowed, score, reason);
    }

    // -------------------------------------------------------------------------
    // 3. Attest — after execution
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIntentVault
    function attestOutcome(uint256 agentId, bytes32 intentHash, bytes32 outcomeHash, bytes32 merkleRoot) external {
        _requireAgentOperator(agentId);
        IntentRecord storage record = _intents[intentHash];
        if (!knownIntent[intentHash]) revert UnknownIntent(intentHash);
        if (record.agentId != agentId) revert NotAgentOperator(agentId, msg.sender);
        if (record.attested) revert AlreadyAttested(intentHash);

        record.attested = true;
        record.attestedAt = uint64(block.timestamp);
        record.outcomeHash = outcomeHash;
        record.merkleRoot = merkleRoot;

        emit OutcomeAttested(intentIdOf(intentHash), agentId, intentHash, outcomeHash, merkleRoot, uint64(block.timestamp));
    }

    // -------------------------------------------------------------------------
    // Deviation verification (called by the stake registry during a challenge)
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIntentVault
    function verifyDeviation(uint256 agentId, bytes32 intentHash, DeviationProof calldata proof)
        external
        view
        returns (bool valid, bool severe)
    {
        IntentRecord storage record = _intents[intentHash];
        if (!knownIntent[intentHash]) return (false, false);
        if (record.agentId != agentId) return (false, false);
        if (!record.attested || record.challenged) return (false, false);
        if (block.timestamp > record.attestedAt + stakeRegistry.challengeWindow()) return (false, false);
        if (record.merkleRoot == bytes32(0)) return (false, false);

        // Does the leaf actually exist in the anchored audit trail?
        if (!MerkleLib.verifyDeviation(proof.merkleProof, record.merkleRoot, proof.action, proof.spendUsd)) {
            return (false, false);
        }

        // Yes — now is it inside the envelope the agent committed to?
        bool overspend = proof.spendUsd > record.maxSpendUsd;
        bool unlistedAction = !_actionAllowed(record, proof.action);
        if (!overspend && !unlistedAction) return (false, false); // honest execution

        // Unlisted action → the agent did something it never promised: BAN.
        // Overspend only → the envelope was violated but the action was authorised: SUSPENSION.
        return (true, unlistedAction);
    }

    /// @inheritdoc IAvairaIntentVault
    function isActionCommitted(bytes32 intentHash, string calldata action) external view returns (bool) {
        if (!knownIntent[intentHash]) return false;
        return _actionAllowed(_intents[intentHash], action);
    }

    /// @inheritdoc IAvairaIntentVault
    function markChallenged(bytes32 intentHash) external {
        if (msg.sender != address(stakeRegistry) && msg.sender != owner()) revert NotStakeRegistry(msg.sender);
        IntentRecord storage record = _intents[intentHash];
        if (!knownIntent[intentHash]) revert UnknownIntent(intentHash);
        if (record.challenged) revert AlreadyChallenged(intentHash);
        record.challenged = true;
        emit IntentChallenged(intentIdOf(intentHash), intentHash, true);
    }

    /// @notice Punish a commitment that was never attested: the agent promised to report
    ///         an outcome and went silent. Callable by anyone once the grace period has
    ///         elapsed; the stake registry applies a WARNING-level slash.
    function challengeNonAttestation(uint256 agentId, bytes32 intentHash) external nonReentrant {
        IntentRecord storage record = _intents[intentHash];
        if (!knownIntent[intentHash]) revert UnknownIntent(intentHash);
        if (record.agentId != agentId) revert UnknownIntent(intentHash);
        if (record.attested) revert AlreadyAttested(intentHash);
        if (record.challenged) revert AlreadyChallenged(intentHash);
        if (block.timestamp <= uint256(record.deadline) + attestationGrace) {
            revert AttestationNotOverdue(intentHash, record.deadline);
        }

        record.challenged = true;
        stakeRegistry.slash(
            agentId, SlashLevel.WARNING, keccak256(abi.encode("non-attestation", intentHash))
        );
        emit IntentChallenged(intentIdOf(intentHash), intentHash, true);
    }

    /// @inheritdoc IAvairaIntentVault
    function finalizeIntent(bytes32 intentHash) external {
        IntentRecord storage record = _intents[intentHash];
        if (!knownIntent[intentHash]) revert UnknownIntent(intentHash);
        if (record.finalized) revert IntentNotFinalizable(intentHash);
        if (!record.attested) revert NotYetAttested(intentHash);

        uint64 closesAt = record.attestedAt + stakeRegistry.challengeWindow();
        if (block.timestamp <= closesAt) revert IntentNotFinalizable(intentHash);

        record.finalized = true;
        emit IntentFinalized(intentIdOf(intentHash), intentHash, uint64(block.timestamp));
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaIntentVault
    function intentOf(bytes32 intentHash) external view returns (IntentRecord memory) {
        return _intents[intentHash];
    }

    function intentOfId(uint256 intentId) external view returns (IntentRecord memory) {
        return _intents[_hashOfId[intentId]];
    }

    /// @notice Sequential id assigned when the hash was committed (0 = unknown).
    function intentIdOf(bytes32 intentHash) public view returns (uint256) {
        return _idCache[intentHash];
    }

    function hashOfIntentId(uint256 intentId) external view returns (bytes32) {
        return _hashOfId[intentId];
    }

    /// @notice Intent hashes committed by `agentId`, oldest first.
    function intentsByAgent(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentIntents[agentId];
    }

    /// @notice True when a challenge against `intentHash` can still be submitted.
    function isChallengeOpen(bytes32 intentHash) external view returns (bool) {
        IntentRecord storage record = _intents[intentHash];
        if (!record.attested || record.challenged || record.finalized) return false;
        return block.timestamp <= record.attestedAt + stakeRegistry.challengeWindow();
    }

    /// @notice Recompute a leaf hash exactly as the SDK does (integration helper).
    function leafHash(string calldata action, uint256 spendUsd) external pure returns (bytes32) {
        return MerkleLib.hashLeaf(action, spendUsd);
    }

    /// @notice Recompute a Merkle root from a leaf + proof (audit-trail verifier).
    function computeRoot(bytes32 leaf, bytes32[] calldata proof) external pure returns (bytes32) {
        return MerkleLib.processProof(proof, leaf);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setContracts(address identity_, address stakeRegistry_) external onlyOwner {
        if (identity_ != address(0)) identity = IAvairaIdentityRegistry(identity_);
        if (stakeRegistry_ != address(0)) stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
    }

    function setAttestationGrace(uint64 grace) external onlyOwner {
        attestationGrace = grace;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _actionAllowed(IntentRecord storage record, string calldata action) private view returns (bool) {
        bytes32 want = keccak256(bytes(action));
        for (uint256 i = 0; i < record.allowedActions.length; ++i) {
            if (keccak256(bytes(record.allowedActions[i])) == want) return true;
        }
        return false;
    }

    function _requireAgentOperator(uint256 agentId) private view {
        address owner_ = identity.ownerOf(agentId);
        if (owner_ == address(0)) revert NotAgentOperator(agentId, msg.sender);
        bool ok = msg.sender == owner_ || msg.sender == identity.getAgentWallet(agentId)
            || identity.isApprovedForAll(owner_, msg.sender) || msg.sender == identity.getApproved(agentId);
        if (!ok) revert NotAgentOperator(agentId, msg.sender);
    }
}
