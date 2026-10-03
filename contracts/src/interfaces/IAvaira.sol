// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentStatus, SlashLevel, RiskEnvelope} from "../lib/AvairaTypes.sol";

/// @notice Why a gate decision was made. The SDK maps codes to human strings.
enum GateReason {
    ALLOWED, // 0 — agent cleared to execute
    UNKNOWN_AGENT, // 1 — no such identity
    BANNED, // 2 — terminal ban
    SUSPENDED, // 3 — slashed into suspension, awaiting re-collateralisation
    STAKE_TOO_LOW, // 4 — below `minStake`
    SCORE_TOO_LOW, // 5 — below `minScore`
    INTENT_NOT_COMMITTED, // 6 — no matching commitment for the given hash
    INTENT_EXPIRED, // 7 — envelope deadline passed
    INTENT_ALREADY_EXECUTED, // 8 — single-use intent already attested
    ENVELOPE_MISMATCH // 9 — the stored envelope does not match the committed hash
}

/// @notice Minimal EIP-3009 surface (native USDC on Monad exposes this).
/// @dev Used as onchain, in-transaction proof that a reviewer actually paid the agent.
interface IEIP3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @notice Minimal score reader implemented by the reputation registry.
/// @dev Kept separate so gating contracts never depend on the full ERC-8004 surface.
interface IAvairaScoreReader {
    /// @notice Avaira Score of `agentId`, 0–100 (0 when never graded).
    function scoreOf(uint256 agentId) external view returns (uint8);
    /// @notice Unix timestamp of the last score post (0 when never graded).
    function scoreUpdatedAt(uint256 agentId) external view returns (uint64);
}

/// @notice Avaira staking, slashing and eligibility surface (Component 5).
/// @dev This is the composability interface: any Monad protocol can gate on
///      `isEligible` / `scoreOf` / `statusOf` in three lines.
interface IAvairaStakeRegistry {
    event Staked(uint256 indexed agentId, address indexed staker, uint256 amount, uint256 totalStake);
    event Unstaked(uint256 indexed agentId, address indexed staker, uint256 amount, uint256 totalStake);
    event AgentSlashed(
        uint256 indexed agentId,
        SlashLevel level,
        uint256 amountSlashed,
        address indexed beneficiary,
        uint256 bounty,
        bytes32 evidenceHash,
        string reason
    );
    event AgentSuspended(uint256 indexed agentId, uint64 suspendedUntil);
    event AgentReactivated(uint256 indexed agentId);
    event AgentVoluntaryExit(uint256 indexed agentId, uint256 refunded);
    event MinStakeUpdated(uint256 previousMinStake, uint256 newMinStake);
    event MinScoreUpdated(uint8 previousMinScore, uint8 newMinScore);
    event SlasherUpdated(address indexed slasher, bool allowed);
    event TreasuryUpdated(address previousTreasury, address newTreasury);

    /// @notice Deposits `amount` of the stake token against `agentId`.
    function stake(uint256 agentId, uint256 amount) external;

    /// @notice Withdraws `amount` of the caller's stake from `agentId`.
    function unstake(uint256 agentId, uint256 amount) external;

    /// @notice Withdraws the full stake and clears the agent's eligibility.
    function voluntaryExit(uint256 agentId) external;

    /// @notice Applies a slash level to `agentId`, optionally routing the bounty to `beneficiary`.
    function slashAgent(uint256 agentId, SlashLevel level, address beneficiary, bytes32 evidenceHash, string calldata reason)
        external
        returns (uint256 amountSlashed);

    /// @notice Re-collateralises a suspended agent once the suspension cooldown has elapsed.
    function reactivate(uint256 agentId) external;

    /// @notice True when the agent is ACTIVE, sufficiently staked and above the score floor.
    function isEligible(uint256 agentId) external view returns (bool);

    /// @notice Address convenience overload: eligibility of the agent a wallet primarily operates.
    function isEligible(address account) external view returns (bool);

    /// @notice Avaira Score (0–100) of `agentId`, read from the reputation registry.
    function scoreOf(uint256 agentId) external view returns (uint8);

    /// @notice Lifecycle status of `agentId`.
    function statusOf(uint256 agentId) external view returns (AgentStatus);

    /// @notice Stake currently backing `agentId`.
    function stakeOf(uint256 agentId) external view returns (uint256);

    /// @notice Minimum stake required for eligibility.
    function minStake() external view returns (uint256);

    /// @notice Minimum Avaira Score required for eligibility.
    function minScore() external view returns (uint8);

    /// @notice True when `account` has at least `minStake` locked — the reviewer grounding rule.
    function isStakedReviewer(address account) external view returns (bool);

    /// @notice Total stake held by `account` across every agent it has staked for.
    function accountStake(address account) external view returns (uint256);

    /// @notice The agent a wallet most recently staked for (0 when none).
    function primaryAgentOf(address account) external view returns (uint256);
}

/// @notice Proof-of-Intent vault and pre-execution gate (Component 4).
interface IAvairaIntentVault {
    event IntentCommitted(
        uint256 indexed agentId, bytes32 indexed intentHash, bytes32 envelopeHash, uint64 deadline, uint256 maxSpendUsd
    );
    event OutcomeAttested(
        uint256 indexed agentId, bytes32 indexed intentHash, bytes32 outcomeHash, bytes32 merkleRoot, uint64 challengeEndsAt
    );
    event GateDecisionRecorded(
        uint256 indexed agentId, bytes32 indexed intentHash, bool allowed, GateReason reason, uint32 latencyMs
    );
    event DeviationChallenged(uint256 indexed agentId, bytes32 indexed intentHash, address indexed challenger, bytes32 leaf);
    event DeviationUpheld(
        uint256 indexed agentId, bytes32 indexed intentHash, address indexed challenger, uint256 bounty, uint256 slashed
    );
    event ChallengeRejected(uint256 indexed agentId, bytes32 indexed intentHash, address indexed challenger, uint256 bondForfeited);

    /// @notice Commits keccak256 of the agent's full plan + parameters before execution.
    function commitIntent(uint256 agentId, bytes32 intentHash, RiskEnvelope calldata envelope) external;

    /// @notice Anchors the outcome hash and the Merkle root of the local hash-chained audit trail.
    function attestOutcome(uint256 agentId, bytes32 intentHash, bytes32 outcomeHash, bytes32 merkleRoot) external;

    /// @notice THE GATE. View-only, so it never blocks on transaction confirmation.
    function checkGate(uint256 agentId) external view returns (bool allowed, uint8 score, GateReason reason);

    /// @notice Gate check bound to a specific commitment.
    function checkGate(uint256 agentId, bytes32 intentHash)
        external
        view
        returns (bool allowed, uint8 score, GateReason reason);

    /// @notice Optional onchain trace of a gate decision. The view path stays free;
    ///         this exists so denials are explorer-visible evidence in the demo.
    function recordGateDecision(uint256 agentId, bytes32 intentHash, bool allowed, GateReason reason, uint32 latencyMs) external;

    /// @notice Proves that an executed action left its committed risk envelope; slashes on success.
    function challengeDeviation(uint256 agentId, bytes32 intentHash, DeviationLeaf calldata leaf, bytes32[] calldata merkleProof)
        external;
}

/// @notice A single executed action, as published by the agent after the fact.
/// @dev Leaves are hashed with `hashDeviationLeaf` and proven against the Merkle root
///      the agent itself anchored in `attestOutcome`, so it cannot repudiate its own trail.
struct DeviationLeaf {
    uint256 agentId;
    bytes32 intentHash;
    string action;
    uint256 spendUsd; // 6-decimals, USDC-style
    uint256 nonce; // disambiguates repeated identical actions
}

/// @notice Score-gated credit market (Component 6). Reputation becomes capital access.
interface IAvairaCreditMarket {
    event CollateralDeposited(uint256 indexed agentId, address indexed depositor, uint256 amount);
    event Borrowed(uint256 indexed agentId, address indexed borrower, uint256 amount, uint256 collateralRatioBps, uint8 score);
    event Repaid(uint256 indexed agentId, address indexed payer, uint256 amount, uint256 remainingDebt);
    event Liquidated(uint256 indexed agentId, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);

    /// @notice Collateralisation requirement (in bps, e.g. 11000 = 110%) for `agentId`.
    function collateralRatioBps(uint256 agentId) external view returns (uint256);

    function depositCollateral(uint256 agentId, uint256 amount) external;
    function borrow(uint256 agentId, uint256 amount) external;
    function repay(uint256 agentId, uint256 amount) external;
    function liquidate(uint256 agentId) external;
}
