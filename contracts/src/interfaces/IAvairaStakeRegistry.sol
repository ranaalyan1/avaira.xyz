// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentStatus, SlashLevel, DeviationProof} from "./IAvairaTypes.sol";

/// @title IAvairaStakeRegistry — staking, slashing and eligibility.
/// @notice This is the contract any Monad protocol integrates against. Three calls:
///
///             registry.isEligible(agentAddress)   // may this agent act / borrow / swap?
///             registry.score(agentId)            // 0–100 Avaira Score
///             registry.statusOf(agentId)         // NONE/PENDING/ACTIVE/SUSPENDED/BANNED
interface IAvairaStakeRegistry {
    event Staked(uint256 indexed agentId, address indexed staker, uint256 amount, uint256 totalStake);
    event UnstakeRequested(uint256 indexed agentId, uint256 amount, uint64 readyAt);
    event UnstakeWithdrawn(uint256 indexed agentId, uint256 amount);
    event Slashed(
        uint256 indexed agentId,
        SlashLevel level,
        uint256 amount,
        uint256 remainingStake,
        address indexed challenger,
        uint256 bounty,
        bytes32 evidenceHash
    );
    event StatusChanged(uint256 indexed agentId, AgentStatus previous, AgentStatus current);
    event ChallengeSettled(
        uint256 indexed agentId, bytes32 indexed intentHash, bool upheld, address indexed challenger, uint256 payout
    );
    event VoluntarilyExited(uint256 indexed agentId, uint256 refunded);
    event ParamsUpdated(string name, uint256 value);

    /// @notice Stake USDC behind an agent. Caller must own the agent identity.
    function stake(uint256 agentId, uint256 amount) external;

    /// @notice Request withdrawal of `amount`, subject to the unstake cooldown.
    function requestUnstake(uint256 agentId, uint256 amount) external;

    /// @notice Withdraw a matured unstake request.
    function withdrawStake(uint256 agentId) external;

    /// @notice Withdraw all stake after the cooldown, burn the identity, refund the bond.
    function voluntaryExit(uint256 agentId) external;

    /// @notice Slash an agent. Restricted to protocol slashers (intent vault / governance).
    function slash(uint256 agentId, SlashLevel level, bytes32 evidenceHash) external returns (uint256 slashed);

    /// @notice Challenge an attested intent with a Merkle proof of envelope deviation.
    ///         A valid proof slashes the agent (bounty to the challenger); an invalid
    ///         proof burns the challenger's bond, which is what makes griefing costly.
    function challengeDeviation(uint256 agentId, bytes32 intentHash, DeviationProof calldata proof) external;

    /// @notice The 3-line composability interface — by agent id.
    function isEligible(uint256 agentId) external view returns (bool);

    /// @notice The 3-line composability interface — by agent address (latest staked agent).
    function isEligible(address agent) external view returns (bool);

    /// @notice Latest Avaira Score posted by the scorer service (0 when never scored).
    function score(uint256 agentId) external view returns (uint8);

    /// @notice Derived lifecycle status.
    function statusOf(uint256 agentId) external view returns (AgentStatus);

    /// @notice USDC currently staked behind `agentId` (includes unfinalised unstake requests).
    function stakeOf(uint256 agentId) external view returns (uint256);

    /// @notice True when `reviewer` owns a staked, active agent and may post feedback.
    function isStakedReviewer(address reviewer) external view returns (bool);

    /// @notice Window (seconds) after an outcome attestation during which a Merkle proof
    ///         of envelope deviation can still be challenged.
    function challengeWindow() external view returns (uint64);

    /// @notice USDC bond a challenger must post; burned to the treasury on a failed proof.
    function challengerBond() external view returns (uint256);
}
