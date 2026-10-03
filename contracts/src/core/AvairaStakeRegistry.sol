// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaStakeRegistry, IAvairaScoreReader} from "../interfaces/IAvaira.sol";
import {AgentStatus, SlashLevel} from "../lib/AvairaTypes.sol";

/// @title AvairaStakeRegistry
/// @notice Staking, slashing and the composability interface any Monad protocol can gate on.
/// @dev Capital is what makes accountability real. An agent locks USDC (native on Monad)
///      against its ERC-8004 identity; reputation alone never buys eligibility, because
///      `isEligible` requires stake **and** score **and** an un-slashed status.
///
///      Slash ladder:
///        WARNING     10% of stake — escrowed/burned, status unchanged unless it drops below `minStake`
///        SUSPENSION  50% of stake — status becomes SUSPENDED and a cooldown starts
///        BAN        100% of stake — terminal, propagates to the identity registry as a permanent ban
///
///      Half of every slash goes to the party that surfaced the deviation (challenger bounty),
///      half to the protocol treasury. Reputation is never purchasable: staking only buys
///      *entry*, the score comes from validated performance.
contract AvairaStakeRegistry is AccessControl, ReentrancyGuard, IAvairaStakeRegistry {
    using SafeERC20 for IERC20;

    /* --------------------------------- errors -------------------------------- */

    error AgentIsBanned(uint256 agentId);
    error AgentIsNotRegistered(uint256 agentId);
    error NotAgentOperator(uint256 agentId, address caller);
    error StakeAlreadyOpenedBy(address staker, address caller);
    error NotStaker(uint256 agentId, address caller);
    error AgentIsSuspended(uint256 agentId);
    error SuspensionCooldownActive(uint64 until);
    error SlashOutOfRange(SlashLevel level);
    error NotSlasher(address caller);
    error InsufficientStake(uint256 available, uint256 requested);
    error ZeroAmount();
    error ZeroAddress();

    /* --------------------------------- roles --------------------------------- */

    /// @notice Role allowed to slash (the intent vault and the protocol operator).
    bytes32 public constant SLASHER_ROLE = keccak256("AVAIRA_SLASHER_ROLE");

    /* -------------------------------- constants ------------------------------- */

    uint16 private constant BPS_DENOMINATOR = 10_000;
    /// @notice Share of a slash paid to the challenger that surfaced the deviation.
    uint16 private constant CHALLENGER_SHARE_BPS = 5_000;
    uint8 private constant WARNING_PCT = 10;
    uint8 private constant SUSPENSION_PCT = 50;
    uint8 private constant BAN_PCT = 100;

    /* ---------------------------------- state -------------------------------- */

    IERC20 public immutable stakeToken;
    /// @notice Avaira identity registry (ERC-721 with `banAgent`).
    address public immutable identityRegistry;
    /// @notice Contract exposing `isBanned(uint256)` on the identity registry.
    IAvairaScoreReader public scoreReader;

    uint256 public minStake;
    uint8 public minScore;
    uint64 public suspensionCooldown;
    address public treasury;

    mapping(uint256 agentId => uint256) private _stakeOf;
    mapping(uint256 agentId => AgentStatus) private _status;
    mapping(uint256 agentId => address) public stakerOf;
    mapping(uint256 agentId => uint64) public suspendedUntil;
    mapping(uint256 agentId => uint256) public slashCount;
    mapping(uint256 agentId => uint256) public slashedTotal;
    mapping(address account => uint256) public accountStake;
    mapping(address account => uint256) public primaryAgentOf;

    /* ------------------------------- constructor ------------------------------ */

    constructor(
        address stakeToken_,
        address identityRegistry_,
        address scoreReader_,
        uint256 minStake_,
        uint8 minScore_,
        address admin
    ) AccessControl() {
        if (
            stakeToken_ == address(0) || identityRegistry_ == address(0) || scoreReader_ == address(0)
                || admin == address(0)
        ) revert ZeroAddress();
        stakeToken = IERC20(stakeToken_);
        identityRegistry = identityRegistry_;
        scoreReader = IAvairaScoreReader(scoreReader_);
        minStake = minStake_;
        minScore = minScore_;
        suspensionCooldown = 24 hours;
        treasury = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);
        emit MinStakeUpdated(0, minStake_);
        emit MinScoreUpdated(0, minScore_);
        emit TreasuryUpdated(address(0), admin);
    }

    /* --------------------------------- staking -------------------------------- */

    /// @inheritdoc IAvairaStakeRegistry
    function stake(uint256 agentId, uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        AgentStatus status = _statusOf(agentId);
        if (status == AgentStatus.BANNED) revert AgentIsBanned(agentId);
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);

        address staker = stakerOf[agentId];
        if (staker == address(0)) {
            stakerOf[agentId] = msg.sender;
            staker = msg.sender;
        } else if (staker != msg.sender) {
            revert StakeAlreadyOpenedBy(staker, msg.sender);
        }

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 total = _stakeOf[agentId] + amount;
        _stakeOf[agentId] = total;
        accountStake[staker] += amount;
        if (primaryAgentOf[staker] == 0) primaryAgentOf[staker] = agentId;

        // Re-collateralising a suspended agent clears the suspension automatically.
        if (status == AgentStatus.SUSPENDED && total >= minStake && block.timestamp >= suspendedUntil[agentId]) {
            _status[agentId] = AgentStatus.ACTIVE;
            emit AgentReactivated(agentId);
        } else if (status == AgentStatus.NONE || status == AgentStatus.PENDING) {
            _status[agentId] = total >= minStake ? AgentStatus.ACTIVE : AgentStatus.PENDING;
        }

        emit Staked(agentId, staker, amount, total);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function unstake(uint256 agentId, uint256 amount) external override nonReentrant {
        AgentStatus status = _statusOf(agentId);
        if (status == AgentStatus.BANNED) revert AgentIsBanned(agentId);
        if (status == AgentStatus.SUSPENDED) revert AgentIsSuspended(agentId);
        if (stakerOf[agentId] != msg.sender) revert NotStaker(agentId, msg.sender);

        uint256 available = _stakeOf[agentId];
        if (amount > available) revert InsufficientStake(available, amount);

        _stakeOf[agentId] = available - amount;
        accountStake[msg.sender] -= amount;

        _refreshStatus(agentId);
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(agentId, msg.sender, amount, available - amount);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function voluntaryExit(uint256 agentId) external override nonReentrant {
        AgentStatus status = _statusOf(agentId);
        if (status == AgentStatus.BANNED) revert AgentIsBanned(agentId);
        if (status == AgentStatus.SUSPENDED) revert AgentIsSuspended(agentId);
        if (stakerOf[agentId] != msg.sender) revert NotStaker(agentId, msg.sender);

        uint256 refund = _stakeOf[agentId];
        _stakeOf[agentId] = 0;
        accountStake[msg.sender] -= refund;
        _status[agentId] = AgentStatus.NONE;
        stakerOf[agentId] = address(0);
        if (primaryAgentOf[msg.sender] == agentId) primaryAgentOf[msg.sender] = 0;

        if (refund > 0) stakeToken.safeTransfer(msg.sender, refund);
        emit AgentVoluntaryExit(agentId, refund);
    }

    /* -------------------------------- slashing -------------------------------- */

    /// @inheritdoc IAvairaStakeRegistry
    /// @dev Half the slashed amount goes to `beneficiary` (the challenger), half to the treasury.
    function slashAgent(uint256 agentId, SlashLevel level, address beneficiary, bytes32 evidenceHash, string calldata reason)
        external
        override
        nonReentrant
        returns (uint256 amountSlashed)
    {
        if (!hasRole(SLASHER_ROLE, msg.sender)) revert NotSlasher(msg.sender);
        if (level == SlashLevel.NONE) revert SlashOutOfRange(level);

        uint256 stake_ = _stakeOf[agentId];
        uint8 pct = level == SlashLevel.WARNING ? WARNING_PCT : level == SlashLevel.SUSPENSION ? SUSPENSION_PCT : BAN_PCT;
        amountSlashed = (stake_ * pct) / 100;

        _stakeOf[agentId] = stake_ - amountSlashed;
        slashCount[agentId] += 1;
        slashedTotal[agentId] += amountSlashed;
        address staker = stakerOf[agentId];
        if (staker != address(0)) accountStake[staker] -= amountSlashed;

        uint256 bounty;
        if (amountSlashed > 0) {
            if (beneficiary != address(0)) {
                bounty = (amountSlashed * CHALLENGER_SHARE_BPS) / BPS_DENOMINATOR;
                stakeToken.safeTransfer(beneficiary, bounty);
            }
            uint256 protocolShare = amountSlashed - bounty;
            if (protocolShare > 0) stakeToken.safeTransfer(treasury, protocolShare);
        }

        if (level == SlashLevel.BAN) {
            _status[agentId] = AgentStatus.BANNED;
            if (_stakeOf[agentId] > 0) {
                // Any residual dust is forfeited too — a BAN leaves no capital behind.
                stakeToken.safeTransfer(treasury, _stakeOf[agentId]);
                _stakeOf[agentId] = 0;
            }
            // Propagate the terminal state to the identity registry.
            (bool ok,) = identityRegistry.call(abi.encodeWithSignature("banAgent(uint256,string)", agentId, reason));
            ok; // a registry that refuses to ban must not block the slash
        } else if (level == SlashLevel.SUSPENSION) {
            uint64 until = uint64(block.timestamp) + suspensionCooldown;
            suspendedUntil[agentId] = until;
            _status[agentId] = AgentStatus.SUSPENDED;
            emit AgentSuspended(agentId, until);
        }

        _refreshStatus(agentId);
        emit AgentSlashed(agentId, level, amountSlashed, beneficiary, bounty, evidenceHash, reason);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function reactivate(uint256 agentId) external override {
        if (_statusOf(agentId) != AgentStatus.SUSPENDED) revert AgentIsSuspended(agentId);
        uint64 until = suspendedUntil[agentId];
        if (block.timestamp < until) revert SuspensionCooldownActive(until);
        if (_stakeOf[agentId] < minStake) revert InsufficientStake(_stakeOf[agentId], minStake);
        _status[agentId] = AgentStatus.ACTIVE;
        emit AgentReactivated(agentId);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @inheritdoc IAvairaStakeRegistry
    function isEligible(uint256 agentId) public view override returns (bool) {
        return _statusOf(agentId) == AgentStatus.ACTIVE && _stakeOf[agentId] >= minStake
            && scoreReader.scoreOf(agentId) >= minScore;
    }

    /// @inheritdoc IAvairaStakeRegistry
    function isEligible(address account) external view override returns (bool) {
        uint256 agentId = primaryAgentOf[account];
        if (agentId == 0) return false;
        return isEligible(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function scoreOf(uint256 agentId) external view override returns (uint8) {
        return scoreReader.scoreOf(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function statusOf(uint256 agentId) external view override returns (AgentStatus) {
        return _statusOf(agentId);
    }

    /// @inheritdoc IAvairaStakeRegistry
    function stakeOf(uint256 agentId) external view override returns (uint256) {
        return _stakeOf[agentId];
    }

    /// @inheritdoc IAvairaStakeRegistry
    function isStakedReviewer(address account) external view override returns (bool) {
        return accountStake[account] >= minStake && minStake > 0;
    }

    /// @notice Age of the agent's identity, in seconds since registration is not tracked here;
    ///         callers read the identity registry for that.
    function statusOfBatch(uint256[] calldata agentIds) external view returns (AgentStatus[] memory statuses) {
        statuses = new AgentStatus[](agentIds.length);
        for (uint256 i; i < agentIds.length; ++i) {
            statuses[i] = _statusOf(agentIds[i]);
        }
    }

    /* --------------------------------- admin ---------------------------------- */

    function setMinStake(uint256 newMinStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinStakeUpdated(minStake, newMinStake);
        minStake = newMinStake;
    }

    function setMinScore(uint8 newMinScore) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newMinScore <= 100, "minScore>100");
        emit MinScoreUpdated(minScore, newMinScore);
        minScore = newMinScore;
    }

    function setSuspensionCooldown(uint64 newCooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        suspensionCooldown = newCooldown;
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setSlasher(address slasher, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (allowed) {
            _grantRole(SLASHER_ROLE, slasher);
        } else {
            _revokeRole(SLASHER_ROLE, slasher);
        }
        emit SlasherUpdated(slasher, allowed);
    }

    function setScoreReader(address newScoreReader) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newScoreReader == address(0)) revert ZeroAddress();
        scoreReader = IAvairaScoreReader(newScoreReader);
    }

    /* -------------------------------- internals ------------------------------- */

    function _statusOf(uint256 agentId) private view returns (AgentStatus) {
        return _status[agentId];
    }

    /// @dev Keeps stored status aligned with the capital actually behind the agent.
    function _refreshStatus(uint256 agentId) private {
        AgentStatus current = _status[agentId];
        if (current == AgentStatus.BANNED || current == AgentStatus.SUSPENDED) return;
        if (stakerOf[agentId] == address(0) || _stakeOf[agentId] == 0) {
            _status[agentId] = AgentStatus.NONE;
            address staker = stakerOf[agentId];
            stakerOf[agentId] = address(0);
            if (staker != address(0) && primaryAgentOf[staker] == agentId) primaryAgentOf[staker] = 0;
        } else if (_stakeOf[agentId] >= minStake) {
            _status[agentId] = AgentStatus.ACTIVE;
        } else {
            _status[agentId] = AgentStatus.PENDING;
        }
    }

    function _isAgentOperator(uint256 agentId, address account) private view returns (bool) {
        IERC721 identity = IERC721(identityRegistry);
        address owner;
        try identity.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            revert AgentIsNotRegistered(agentId);
        }
        if (account == owner) return true;
        if (identity.getApproved(agentId) == account) return true;
        return identity.isApprovedForAll(owner, account);
    }
}
