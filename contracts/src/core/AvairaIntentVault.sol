// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaIntentVault, IAvairaStakeRegistry, GateReason, DeviationLeaf} from "../interfaces/IAvaira.sol";
import {IAvairaComplianceGate} from "../interfaces/IAvairaCompliance.sol";
import {AgentStatus, SlashLevel, RiskEnvelope, RiskEnvelopeLib} from "../lib/AvairaTypes.sol";
import {MerkleLib} from "../lib/MerkleLib.sol";

/// @title AvairaIntentVault — Proof-of-Intent + the pre-execution gate
/// @notice The primitive that neither Assay Protocol (Base, post-hoc stake+score) nor
///         Yelden's `AIAgentRegistry` (`isEligible()` lookups, Chainlink DON scoring)
///         has: an agent must **commit the hash of its full plan and risk envelope
///         before it acts**, the gate is evaluated **before execution**, and the
///         outcome is anchored afterwards so any deviation is provable by anyone.
///
/// @dev Latency is the whole point. `checkGate` is a `view` function: it needs no
///      transaction, no block, and no confirmation — it is a single `eth_call`
///      against Monad's latest state. Commit is fire-and-forget, so the only thing
///      the agent waits for is one RPC round trip. Ethereum's 12s blocks make this
///      gate a 12-second product; on Monad (400ms blocks, 800ms finality) it costs
///      a few hundred milliseconds of client time — the SDK measures and publishes
///      the real number.
///
///      Deviation is provable, not asserted: `attestOutcome` anchors a Merkle root of
///      the agent's own hash-chained audit trail. Anyone holding a leaf that leaves
///      the committed envelope (spend > maxSpendUsd, or an action outside
///      allowedActions) can prove it against that root and trigger a slash, as long
///      as they do it inside the challenge window.
contract AvairaIntentVault is AccessControl, ReentrancyGuard, IAvairaIntentVault {
    using RiskEnvelopeLib for RiskEnvelope;
    using SafeERC20 for IERC20;

    /* --------------------------------- errors -------------------------------- */

    error AgentIsBanned(uint256 agentId);
    error NotAgentOperator(uint256 agentId, address caller);
    error IntentAlreadyCommitted(uint256 agentId, bytes32 intentHash);
    error EnvelopeExpired(uint64 deadline);
    error TooManyActions(uint256 count);
    error ActionTooLong(uint256 index);
    error UnknownIntent(uint256 agentId, bytes32 intentHash);
    error OutcomeAlreadyAttested(uint256 agentId, bytes32 intentHash);
    error OutcomeNotAttested(uint256 agentId, bytes32 intentHash);
    error ChallengeWindowClosed(uint64 closedAt);
    error ChallengeWindowOpen(uint64 closesAt);
    error AlreadyChallenged(uint256 agentId, bytes32 intentHash);
    error LeafMismatch();
    error InvalidMerkleProof();
    error NoDeviation();
    error EnvelopeMismatch(bytes32 expected, bytes32 provided);
    error ZeroAddress();

    /* -------------------------------- constants ------------------------------- */

    uint256 private constant MAX_ALLOWED_ACTIONS = 32;
    uint256 private constant MAX_ACTION_LENGTH = 96;
    bytes32 private constant DEVIATION_EVIDENCE_DOMAIN = keccak256("Avaira.DeviationEvidence.v1");

    /* ---------------------------------- state -------------------------------- */

    IERC721 public immutable identityRegistry;
    IAvairaStakeRegistry public stakeRegistry;
    /// @notice Token used for challenger bonds (same asset as staking).
    IERC20 public immutable stakeToken;
    address public treasury;
    /// @notice Optional Cleanverse CVI compliance gate (Workstream: CVI/CVA gating).
    /// @dev When set, intents whose allowed actions include any `cva.*` action also
    ///      require valid CVI credentials for the agent's involved wallets.
    IAvairaComplianceGate public complianceGate;

    /// @notice How long a challenged outcome stays open to deviation proofs.
    uint64 public challengeWindow;
    /// @notice Anti-spam bond required from a challenger; forfeited when the proof is bad.
    uint256 public challengerBond;
    /// @notice Treasury share of upheld-deviation slashes is handled by the stake registry.

    struct Intent {
        uint256 agentId;
        bytes32 envelopeHash;
        uint256 maxSpendUsd;
        uint64 deadline;
        uint64 committedAt;
        uint64 challengeEndsAt;
        bytes32 outcomeHash;
        bytes32 outcomeRoot;
        bool executed;
        bool challenged;
        bool deviationUpheld;
        address committer;
    }

    mapping(uint256 agentId => mapping(bytes32 intentHash => Intent)) private _intents;
    mapping(uint256 agentId => mapping(bytes32 intentHash => string[] actions)) private _allowedActions;

    /* --------------------------------- events -------------------------------- */

    event ChallengeWindowUpdated(uint64 previousWindow, uint64 newWindow);
    event ChallengerBondUpdated(uint256 previousBond, uint256 newBond);
    event TreasuryUpdated(address previousTreasury, address newTreasury);
    event ComplianceGateUpdated(address previousGate, address newGate);

    /* ------------------------------- constructor ------------------------------ */

    constructor(address identityRegistry_, address stakeRegistry_, address stakeToken_, uint64 challengeWindow_, address admin)
        AccessControl()
    {
        if (identityRegistry_ == address(0) || stakeRegistry_ == address(0) || stakeToken_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        identityRegistry = IERC721(identityRegistry_);
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
        stakeToken = IERC20(stakeToken_);
        challengeWindow = challengeWindow_;
        treasury = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit ChallengeWindowUpdated(0, challengeWindow_);
        emit TreasuryUpdated(address(0), admin);
    }

    /* ------------------------------ proof of intent --------------------------- */

    /// @inheritdoc IAvairaIntentVault
    /// @dev `intentHash` MUST commit to the full plan *and* the envelope, and MUST be
    ///      unique per attempt (include a nonce), because one intent = one execution.
    function commitIntent(uint256 agentId, bytes32 intentHash, RiskEnvelope calldata envelope) external override {
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        if (_isIdentityBanned(agentId)) revert AgentIsBanned(agentId);
        if (envelope.deadline <= block.timestamp) revert EnvelopeExpired(envelope.deadline);

        Intent storage existing = _intents[agentId][intentHash];
        if (existing.committedAt != 0) revert IntentAlreadyCommitted(agentId, intentHash);

        uint256 actionCount = envelope.allowedActions.length;
        if (actionCount > MAX_ALLOWED_ACTIONS) revert TooManyActions(actionCount);

        string[] storage actions = _allowedActions[agentId][intentHash];
        for (uint256 i; i < actionCount; ++i) {
            string calldata action = envelope.allowedActions[i];
            if (bytes(action).length > MAX_ACTION_LENGTH) revert ActionTooLong(i);
            actions.push(action);
        }

        bytes32 envelopeHash = envelope.hash();
        _intents[agentId][intentHash] = Intent({
            agentId: agentId,
            envelopeHash: envelopeHash,
            maxSpendUsd: envelope.maxSpendUsd,
            deadline: envelope.deadline,
            committedAt: uint64(block.timestamp),
            challengeEndsAt: 0,
            outcomeHash: bytes32(0),
            outcomeRoot: bytes32(0),
            executed: false,
            challenged: false,
            deviationUpheld: false,
            committer: msg.sender
        });

        emit IntentCommitted(agentId, intentHash, envelopeHash, envelope.deadline, envelope.maxSpendUsd);
    }

    /// @inheritdoc IAvairaIntentVault
    function attestOutcome(uint256 agentId, bytes32 intentHash, bytes32 outcomeHash, bytes32 merkleRoot)
        external
        override
    {
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        Intent storage intent = _intents[agentId][intentHash];
        if (intent.committedAt == 0) revert UnknownIntent(agentId, intentHash);
        if (intent.executed) revert OutcomeAlreadyAttested(agentId, intentHash);

        intent.executed = true;
        intent.outcomeHash = outcomeHash;
        intent.outcomeRoot = merkleRoot;
        intent.challengeEndsAt = uint64(block.timestamp) + challengeWindow;

        emit OutcomeAttested(agentId, intentHash, outcomeHash, merkleRoot, intent.challengeEndsAt);
    }

    /* ----------------------------------- gate --------------------------------- */

    /// @inheritdoc IAvairaIntentVault
    /// @dev Free `view` call — the SDK never waits for a transaction to gate an action.
    function checkGate(uint256 agentId) public view override returns (bool allowed, uint8 score, GateReason reason) {
        AgentStatus status = stakeRegistry.statusOf(agentId);
        score = stakeRegistry.scoreOf(agentId);

        if (status == AgentStatus.NONE) return (false, score, GateReason.UNKNOWN_AGENT);
        if (status == AgentStatus.BANNED) return (false, score, GateReason.BANNED);
        if (status == AgentStatus.SUSPENDED) return (false, score, GateReason.SUSPENDED);
        if (stakeRegistry.stakeOf(agentId) < stakeRegistry.minStake()) {
            return (false, score, GateReason.STAKE_TOO_LOW);
        }
        if (score < stakeRegistry.minScore()) return (false, score, GateReason.SCORE_TOO_LOW);
        return (true, score, GateReason.ALLOWED);
    }

    /// @inheritdoc IAvairaIntentVault
    function checkGate(uint256 agentId, bytes32 intentHash)
        public
        view
        override
        returns (bool allowed, uint8 score, GateReason reason)
    {
        (allowed, score, reason) = checkGate(agentId);
        if (!allowed) return (allowed, score, reason);

        Intent storage intent = _intents[agentId][intentHash];
        if (intent.committedAt == 0) return (false, score, GateReason.INTENT_NOT_COMMITTED);
        if (intent.executed) return (false, score, GateReason.INTENT_ALREADY_EXECUTED);
        if (intent.deadline <= block.timestamp) return (false, score, GateReason.INTENT_EXPIRED);

        // Cleanverse CVI hook: an intent whose allowed actions include any `cva.*`
        // action (e.g. cva.transfer / cva.settle) additionally requires that every
        // wallet the agent can act through holds a valid CVI credential.
        if (_requiresCVI(agentId, intentHash) && !_cviPartiesVerified(agentId)) {
            return (false, score, GateReason.CVI_UNVERIFIED);
        }
        return (true, score, GateReason.ALLOWED);
    }

    /// @notice Gate check that also verifies the caller's local envelope matches the commitment.
    function checkGate(uint256 agentId, bytes32 intentHash, bytes32 envelopeHash)
        external
        view
        returns (bool allowed, uint8 score, GateReason reason)
    {
        (allowed, score, reason) = checkGate(agentId, intentHash);
        if (!allowed) return (allowed, score, reason);
        bytes32 expected = _intents[agentId][intentHash].envelopeHash;
        if (expected != envelopeHash) return (false, score, GateReason.ENVELOPE_MISMATCH);
        return (true, score, GateReason.ALLOWED);
    }

    /// @notice Optional onchain trace of a gate decision (the view path stays free).
    /// @dev Only the agent's own operator may record, so the audit trail cannot be poisoned.
    function recordGateDecision(uint256 agentId, bytes32 intentHash, bool allowed, GateReason reason, uint32 latencyMs)
        external
    {
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        emit GateDecisionRecorded(agentId, intentHash, allowed, reason, latencyMs);
    }

    /* ---------------------------- deviation challenge ------------------------- */

    /// @inheritdoc IAvairaIntentVault
    /// @dev Flow: verify the leaf against the root the agent itself anchored, then check the
    ///      leaf against the envelope the agent itself committed. A valid proof slashes the
    ///      agent (SUSPENSION by default) and pays the challenger half of the slashed stake.
    function challengeDeviation(
        uint256 agentId,
        bytes32 intentHash,
        DeviationLeaf calldata leaf,
        bytes32[] calldata merkleProof
    ) external override nonReentrant {
        Intent storage intent = _intents[agentId][intentHash];
        if (intent.committedAt == 0) revert UnknownIntent(agentId, intentHash);
        if (!intent.executed) revert OutcomeNotAttested(agentId, intentHash);
        if (block.timestamp > intent.challengeEndsAt) revert ChallengeWindowClosed(intent.challengeEndsAt);
        if (intent.challenged) revert AlreadyChallenged(agentId, intentHash);

        if (leaf.agentId != agentId || leaf.intentHash != intentHash) revert LeafMismatch();

        uint256 bond = challengerBond;
        if (bond > 0) stakeToken.safeTransferFrom(msg.sender, address(this), bond);

        bool proven = MerkleLib.verify(merkleProof, intent.outcomeRoot, MerkleLib.hashDeviationLeaf(leaf));
        if (!proven) {
            _rejectChallenge(agentId, intentHash, bond);
            return;
        }

        bool overSpend = intent.maxSpendUsd > 0 && leaf.spendUsd > intent.maxSpendUsd;
        bool actionOutsideEnvelope = !_isActionAllowed(agentId, intentHash, leaf.action);
        if (!overSpend && !actionOutsideEnvelope) {
            _rejectChallenge(agentId, intentHash, bond);
            return;
        }

        intent.challenged = true;
        intent.deviationUpheld = true;

        bytes32 evidenceHash = keccak256(
            abi.encode(DEVIATION_EVIDENCE_DOMAIN, agentId, intentHash, MerkleLib.hashDeviationLeaf(leaf), intent.outcomeRoot)
        );
        uint256 slashed = stakeRegistry.slashAgent(
            agentId, SlashLevel.SUSPENSION, msg.sender, evidenceHash, "Avaira: outcome left committed risk envelope"
        );

        // Refund the challenger's bond; the bounty was paid directly by the stake registry.
        if (bond > 0) stakeToken.safeTransfer(msg.sender, bond);

        emit DeviationUpheld(agentId, intentHash, msg.sender, bond, slashed);
    }

    function _rejectChallenge(uint256 agentId, bytes32 intentHash, uint256 bond) private {
        if (bond > 0) stakeToken.safeTransfer(treasury, bond);
        emit ChallengeRejected(agentId, intentHash, msg.sender, bond);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @notice Full intent record.
    function getIntent(uint256 agentId, bytes32 intentHash) external view returns (Intent memory) {
        return _intents[agentId][intentHash];
    }

    /// @notice Actions the agent committed to for `intentHash`.
    function allowedActionsOf(uint256 agentId, bytes32 intentHash) external view returns (string[] memory) {
        return _allowedActions[agentId][intentHash];
    }

    /// @notice True when an outcome can still be challenged.
    function isChallengeOpen(uint256 agentId, bytes32 intentHash) external view returns (bool) {
        Intent storage intent = _intents[agentId][intentHash];
        return intent.executed && !intent.challenged && block.timestamp <= intent.challengeEndsAt;
    }

    /* ---------------------------------- admin --------------------------------- */

    function setStakeRegistry(address newStakeRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newStakeRegistry == address(0)) revert ZeroAddress();
        stakeRegistry = IAvairaStakeRegistry(newStakeRegistry);
    }

    function setChallengeWindow(uint64 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit ChallengeWindowUpdated(challengeWindow, newWindow);
        challengeWindow = newWindow;
    }

    function setChallengerBond(uint256 newBond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit ChallengerBondUpdated(challengerBond, newBond);
        challengerBond = newBond;
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Wires the Cleanverse CVI compliance gate (or disables it with address(0)).
    /// @dev Backwards compatible: with no gate set, `checkGate` behaves exactly as before.
    function setComplianceGate(address newGate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit ComplianceGateUpdated(address(complianceGate), newGate);
        complianceGate = IAvairaComplianceGate(newGate);
    }

    /* -------------------------------- internals ------------------------------- */

    /// @dev True when the committed action list contains any `cva.*` action and a
    ///      compliance gate is configured. Prefix match keeps the check agnostic to
    ///      the exact CVA action vocabulary (cva.transfer, cva.settle, cva.*).
    function _requiresCVI(uint256 agentId, bytes32 intentHash) private view returns (bool) {
        if (address(complianceGate) == address(0)) return false;
        string[] storage actions = _allowedActions[agentId][intentHash];
        uint256 len = actions.length;
        for (uint256 i; i < len; ++i) {
            bytes memory action = bytes(actions[i]);
            if (action.length >= 4 && action[0] == "c" && action[1] == "v" && action[2] == "a" && action[3] == ".") {
                return true;
            }
        }
        return false;
    }

    /// @dev Every wallet the agent can act through — the identity owner and the
    ///      bound agent execution wallet (when set) — must hold a valid CVI credential.
    function _cviPartiesVerified(uint256 agentId) private view returns (bool) {
        address owner;
        try identityRegistry.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            return false;
        }
        if (!complianceGate.isWalletVerified(owner)) return false;
        address agentWallet = _agentWallet(agentId);
        if (agentWallet != address(0) && !complianceGate.isWalletVerified(agentWallet)) return false;
        return true;
    }

    function _isActionAllowed(uint256 agentId, bytes32 intentHash, string calldata action) private view returns (bool) {
        string[] storage actions = _allowedActions[agentId][intentHash];
        bytes32 actionHash = keccak256(bytes(action));
        uint256 len = actions.length;
        for (uint256 i; i < len; ++i) {
            if (keccak256(bytes(actions[i])) == actionHash) return true;
        }
        return false;
    }

    function _isAgentOperator(uint256 agentId, address account) private view returns (bool) {
        address owner;
        try identityRegistry.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            return false;
        }
        if (account == owner) return true;
        if (identityRegistry.getApproved(agentId) == account) return true;
        if (identityRegistry.isApprovedForAll(owner, account)) return true;
        return account == _agentWallet(agentId);
    }

    function _agentWallet(uint256 agentId) private view returns (address wallet) {
        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("getAgentWallet(uint256)", agentId));
        if (ok && data.length >= 32) wallet = abi.decode(data, (address));
    }

    function _isIdentityBanned(uint256 agentId) private view returns (bool) {
        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("isBanned(uint256)", agentId));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }
}
