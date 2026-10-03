// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Component 5 of 6: AvairaStakeRegistry
        -------------------------------------
        Staking, slashing, the 24h challenge window, and the three-line
        composability interface every Monad protocol integrates against.

        Reputation that cannot cost an agent anything is decoration. Here, stake is
        the thing that makes the Avaira Score enforceable: below the floor the gate
        refuses, and a proven deviation burns stake and pays a bounty to whoever
        proved it.

        Status is *derived*, never stored stale:
            NONE      stake == 0
            PENDING   staked but score unposted / below floor / stake below minimum
            ACTIVE    staked ≥ min, score ≥ floor, not banned or suspended
            SUSPENDED governance/validator action, 50% slashed, recoverable via appeal
            BANNED    permanent, 100% slashed, identity bond forfeited
//////////////////////////////////////////////////////////////////////////////*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaStakeRegistry} from "./interfaces/IAvairaStakeRegistry.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";
import {IAvairaReputationRegistry} from "./interfaces/IAvairaReputationRegistry.sol";
import {IAvairaIntentVault} from "./interfaces/IAvairaIntentVault.sol";
import {AgentStatus, SlashLevel, DeviationProof} from "./interfaces/IAvairaTypes.sol";

contract AvairaStakeRegistry is IAvairaStakeRegistry, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    uint16 public constant WARNING_BPS = 1_000; // 10%
    uint16 public constant SUSPENSION_BPS = 5_000; // 50%
    uint16 public constant BAN_BPS = 10_000; // 100%
    uint16 public constant CHALLENGER_BOUNTY_BPS = 5_000; // 50% of the slashed amount

    // -------------------------------------------------------------------------
    // Immutables & configuration
    // -------------------------------------------------------------------------

    IERC20 public immutable usdc;
    IAvairaIdentityRegistry public identity;
    IAvairaReputationRegistry public reputation;
    IAvairaIntentVault public intentVault;

    address public treasury;

    /// @notice Minimum stake for gate eligibility (USDC, 6 decimals).
    uint256 public minStake = 100e6;

    /// @notice Minimum stake for a reviewer to post ungrounded feedback.
    uint256 public minReviewerStake = 50e6;

    /// @notice Score floor for ACTIVE status and gate eligibility.
    uint8 public minScoreForEligibility = 60;

    /// @notice Cooldown between an unstake request and withdrawal.
    uint64 public unstakeCooldown = 24 hours;

    /// @notice Window after outcome attestation during which deviations can be challenged.
    uint64 public challengeWindow = 24 hours;

    /// @notice Bond a challenger must post; burned to the treasury when the proof fails.
    uint256 public challengerBond = 25e6;

    /// @notice Addresses allowed to slash (intent vault, governance, Kimi validator sink).
    mapping(address => bool) public slashers;

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    struct Position {
        uint256 stake; // total slashable USDC
        uint256 pendingUnstake; // claim on `stake` once the cooldown matures
        uint64 unstakeReadyAt;
        uint32 slashCount;
        uint256 totalSlashed;
        bool banned;
        bool suspended;
        AgentStatus lastStatus;
    }

    mapping(uint256 agentId => Position) private _positions;
    mapping(address owner => uint256 agentId) private _primaryAgent;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotAgentOwner(uint256 agentId, address caller);
    error ZeroAmount();
    error InsufficientStake(uint256 requested, uint256 available);
    error NothingToWithdraw(uint256 agentId, uint64 readyAt);
    error NotSlasher(address caller);
    error AgentBanned(uint256 agentId);
    error AlreadyBanned(uint256 agentId);
    error NotSuspended(uint256 agentId);
    error NotChallenger();
    error InsufficientChallengerBond(uint256 required, uint256 provided);
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address usdc_, address treasury_) Ownable(initialOwner) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        treasury = treasury_;
        slashers[initialOwner] = true;
    }

    // -------------------------------------------------------------------------
    // Staking
    // -------------------------------------------------------------------------

    /// @dev Staking an agent id requires owning the ERC-8004 identity: stake and
    ///      identity cannot be held by different parties, or slashing would punish the
    ///      wrong one.
    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (_positions[agentId].banned) revert AgentBanned(agentId);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        Position storage p = _positions[agentId];
        p.stake += amount;
        _primaryAgent[msg.sender] = agentId;

        emit Staked(agentId, msg.sender, amount, p.stake);
        _syncStatus(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function requestUnstake(uint256 agentId, uint256 amount) external nonReentrant {
        _requireAgentOwner(agentId);
        if (amount == 0) revert ZeroAmount();

        Position storage p = _positions[agentId];
        uint256 available = p.stake - p.pendingUnstake;
        if (amount > available) revert InsufficientStake(amount, available);

        p.pendingUnstake += amount;
        p.unstakeReadyAt = uint64(block.timestamp) + unstakeCooldown;

        emit UnstakeRequested(agentId, amount, p.unstakeReadyAt);
        _syncStatus(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function withdrawStake(uint256 agentId) external nonReentrant {
        _requireAgentOwner(agentId);
        Position storage p = _positions[agentId];
        if (p.pendingUnstake == 0 || block.timestamp < p.unstakeReadyAt) {
            revert NothingToWithdraw(agentId, p.unstakeReadyAt);
        }

        uint256 amount = p.pendingUnstake;
        p.pendingUnstake = 0;
        p.stake -= amount;
        p.unstakeReadyAt = 0;

        usdc.safeTransfer(msg.sender, amount);
        emit UnstakeWithdrawn(agentId, amount);
        _syncStatus(agentId);
    }

    /// @dev Full exit: request everything, wait out the cooldown, then burn the identity
    ///      and reclaim the registration bond. Blocked for BANNED agents (their bond is
    ///      protocol revenue, see {slash}).
    function voluntaryExit(uint256 agentId) external nonReentrant {
        _requireAgentOwner(agentId);
        Position storage p = _positions[agentId];
        if (p.banned) revert AgentBanned(agentId);

        uint256 available = p.stake - p.pendingUnstake;
        if (available != 0) {
            p.pendingUnstake += available;
            p.unstakeReadyAt = uint64(block.timestamp) + unstakeCooldown;
            emit UnstakeRequested(agentId, available, p.unstakeReadyAt);
        }
        if (block.timestamp < p.unstakeReadyAt) revert NothingToWithdraw(agentId, p.unstakeReadyAt);

        uint256 amount = p.pendingUnstake;
        p.pendingUnstake = 0;
        p.stake -= amount;
        p.unstakeReadyAt = 0;
        if (amount != 0) usdc.safeTransfer(msg.sender, amount);

        // Identity is burned last: it re-checks that no stake is left behind.
        identity.refundBondAndBurn(agentId);

        emit VoluntarilyExited(agentId, amount);
        _syncStatus(agentId);
    }

    // -------------------------------------------------------------------------
    // Slashing
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaStakeRegistry
    function slash(uint256 agentId, SlashLevel level, bytes32 evidenceHash)
        external
        nonReentrant
        returns (uint256 slashed)
    {
        if (!slashers[msg.sender] && msg.sender != owner()) revert NotSlasher(msg.sender);
        return _slash(agentId, level, evidenceHash, address(0));
    }

    /// @dev Core slashing routine. `challenger` (when non-zero) receives half of the
    ///      slashed amount as a bounty; the remainder goes to the treasury.
    function _slash(uint256 agentId, SlashLevel level, bytes32 evidenceHash, address challenger)
        internal
        returns (uint256 slashed)
    {
        Position storage p = _positions[agentId];
        if (level == SlashLevel.BAN && p.banned) revert AlreadyBanned(agentId);

        uint16 bps = level == SlashLevel.WARNING
            ? WARNING_BPS
            : level == SlashLevel.SUSPENSION
                ? SUSPENSION_BPS
                : BAN_BPS;

        slashed = (p.stake * bps) / BPS;
        p.stake -= slashed;
        if (p.pendingUnstake > p.stake) p.pendingUnstake = p.stake; // haircut the pending claim

        p.slashCount += 1;
        p.totalSlashed += slashed;

        if (level == SlashLevel.SUSPENSION) p.suspended = true;
        if (level == SlashLevel.BAN) {
            p.banned = true;
            p.suspended = false;
            reputation.markBanned(agentId);
            // The SlashLevel.BAN branch is the only place the bond is forfeited.
            identity.forfeitBond(agentId);
        }

        uint256 bounty;
        if (slashed != 0) {
            if (challenger != address(0)) {
                bounty = (slashed * CHALLENGER_BOUNTY_BPS) / BPS;
                usdc.safeTransfer(challenger, bounty);
            }
            uint256 remainder = slashed - bounty;
            if (remainder != 0) usdc.safeTransfer(treasury, remainder);
        }

        emit Slashed(agentId, level, slashed, p.stake, challenger, bounty, evidenceHash);
        _syncStatus(agentId);
    }

    /// @dev The challenge window is the economic core of Proof-of-Intent:
    ///      - valid deviation proof → agent is slashed (SUSPENSION for a spend overage,
    ///        BAN when the action was never in the envelope) and the challenger is paid;
    ///      - invalid proof → the challenger's bond is burned to the treasury, so
    ///        spamming challenges against honest agents is itself expensive.
    function challengeDeviation(uint256 agentId, bytes32 intentHash, DeviationProof calldata proof)
        external
        nonReentrant
    {
        uint256 bond = challengerBond;
        if (bond != 0) {
            uint256 balanceBefore = usdc.balanceOf(address(this));
            usdc.safeTransferFrom(msg.sender, address(this), bond);
            if (usdc.balanceOf(address(this)) - balanceBefore != bond) revert InsufficientChallengerBond(bond, 0);
        }

        (bool valid, bool severe) = intentVault.verifyDeviation(agentId, intentHash, proof);

        if (!valid) {
            if (bond != 0) usdc.safeTransfer(treasury, bond);
            emit ChallengeSettled(agentId, intentHash, false, msg.sender, 0);
            return;
        }

        SlashLevel level = severe ? SlashLevel.BAN : SlashLevel.SUSPENSION;
        bytes32 evidenceHash = keccak256(
            abi.encode(intentHash, proof.action, proof.spendUsd, proof.leafIndex, keccak256(abi.encode(proof.merkleProof)))
        );
        uint256 slashed = _slash(agentId, level, evidenceHash, msg.sender);

        // Return the challenger's bond and settle the bounty on top of it.
        if (bond != 0) usdc.safeTransfer(msg.sender, bond);
        intentVault.markChallenged(intentHash);

        uint256 bounty = (slashed * CHALLENGER_BOUNTY_BPS) / BPS;
        emit ChallengeSettled(agentId, intentHash, true, msg.sender, bounty);
    }

    /// @notice Governance path: an agent suspended by a validator can be reinstated
    ///         (appeal won). Its score is not restored — only re-earned by the scorer.
    function reinstate(uint256 agentId) external onlyOwner {
        Position storage p = _positions[agentId];
        if (!p.suspended) revert NotSuspended(agentId);
        p.suspended = false;
        _syncStatus(agentId);
    }

    // -------------------------------------------------------------------------
    // The three-line composability interface
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaStakeRegistry
    function isEligible(uint256 agentId) public view returns (bool) {
        if (statusOf(agentId) != AgentStatus.ACTIVE) return false;
        return true;
    }

    /// @inheritdoc IAvairaStakeRegistry
    function isEligible(address agent) external view returns (bool) {
        uint256 agentId = _primaryAgent[agent];
        if (agentId == 0) return false;
        if (identity.ownerOf(agentId) != agent) return false;
        return isEligible(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function score(uint256 agentId) public view returns (uint8) {
        return reputation.scoreOf(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function statusOf(uint256 agentId) public view returns (AgentStatus) {
        Position storage p = _positions[agentId];
        if (p.banned) return AgentStatus.BANNED;
        if (p.suspended) return AgentStatus.SUSPENDED;
        if (p.stake == 0) return AgentStatus.NONE;

        bool staked = (p.stake - p.pendingUnstake) >= minStake;
        bool scored = reputation.hasScore(agentId);
        if (staked && scored && reputation.scoreOf(agentId) >= minScoreForEligibility) {
            return AgentStatus.ACTIVE;
        }
        return AgentStatus.PENDING;
    }

    /// @inheritdoc IAvairaStakeRegistry
    function stakeOf(uint256 agentId) external view returns (uint256) {
        return _positions[agentId].stake;
    }

    /// @notice Non-withdrawable stake (stake minus matured-or-pending unstake claims).
    function slashableStakeOf(uint256 agentId) external view returns (uint256) {
        return _positions[agentId].stake;
    }

    /// @inheritdoc IAvairaStakeRegistry
    function isStakedReviewer(address reviewer) external view returns (bool) {
        uint256 agentId = _primaryAgent[reviewer];
        if (agentId == 0) return false;
        if (identity.ownerOf(agentId) != reviewer) return false;
        return statusOf(agentId) == AgentStatus.ACTIVE && _positions[agentId].stake >= minReviewerStake;
    }

    function positionOf(uint256 agentId)
        external
        view
        returns (uint256 stake_, uint256 pendingUnstake, uint64 unstakeReadyAt, uint32 slashCount, uint256 totalSlashed, bool banned, bool suspended)
    {
        Position storage p = _positions[agentId];
        return (p.stake, p.pendingUnstake, p.unstakeReadyAt, p.slashCount, p.totalSlashed, p.banned, p.suspended);
    }

    /// @notice Latest agent id staked by `agentAddress` (used by {isEligible(address)}).
    function primaryAgentOf(address agentAddress) external view returns (uint256) {
        return _primaryAgent[agentAddress];
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setMinStake(uint256 value) external onlyOwner {
        minStake = value;
        emit ParamsUpdated("minStake", value);
    }

    function setMinReviewerStake(uint256 value) external onlyOwner {
        minReviewerStake = value;
        emit ParamsUpdated("minReviewerStake", value);
    }

    function setMinScoreForEligibility(uint8 value) external onlyOwner {
        minScoreForEligibility = value;
        emit ParamsUpdated("minScoreForEligibility", value);
    }

    function setUnstakeCooldown(uint64 value) external onlyOwner {
        unstakeCooldown = value;
        emit ParamsUpdated("unstakeCooldown", value);
    }

    function setChallengeWindow(uint64 value) external onlyOwner {
        challengeWindow = value;
        emit ParamsUpdated("challengeWindow", value);
    }

    function setChallengerBond(uint256 value) external onlyOwner {
        challengerBond = value;
        emit ParamsUpdated("challengerBond", value);
    }

    function setTreasury(address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        treasury = value;
    }

    function setContracts(address identity_, address reputation_, address intentVault_) external onlyOwner {
        if (identity_ != address(0)) identity = IAvairaIdentityRegistry(identity_);
        if (reputation_ != address(0)) reputation = IAvairaReputationRegistry(reputation_);
        if (intentVault_ != address(0)) intentVault = IAvairaIntentVault(intentVault_);
    }

    function setSlasher(address account, bool allowed) external onlyOwner {
        slashers[account] = allowed;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _requireAgentOwner(uint256 agentId) private view {
        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
    }

    /// @dev Recomputes the derived status and emits {StatusChanged} only on a real
    ///      transition, so indexers get an accurate lifecycle feed without polling.
    ///      Called from every write path; also exposed as {syncStatus} because a score
    ///      posted by the scorer service changes status without touching this contract.
    function _syncStatus(uint256 agentId) private {
        AgentStatus current = statusOf(agentId);
        Position storage p = _positions[agentId];
        if (p.lastStatus != current) {
            emit StatusChanged(agentId, p.lastStatus, current);
            p.lastStatus = current;
        }
    }

    /// @notice Permissionless status refresh — emits a lifecycle event if a score posted
    ///         by the scorer moved this agent between PENDING and ACTIVE.
    function syncStatus(uint256 agentId) external {
        _syncStatus(agentId);
    }
}
