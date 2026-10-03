// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaCreditMarket, IAvairaStakeRegistry} from "../interfaces/IAvaira.sol";

/// @title AvairaCreditMarket — reputation becomes capital access
/// @notice Mini money-market where the collateral requirement is a function of the
///         onchain Avaira Score. This is the bridge between the accountability layer
///         and undercollateralised agent lending:
///
///           score >= 80  ->  110% collateral   (A-grade agent)
///           score 60–79  ->  125% collateral
///           score < 60 or ungraded  ->  150% collateral
///
/// @dev Deliberately minimal (single asset, no interest curve, full-close liquidation):
///      the point being proven is that a *verifiable, slash-backed* reputation number
///      prices credit. The score is read live from the reputation registry, so a slash
///      immediately tightens the agent's line — and a breach becomes liquidatable.
contract AvairaCreditMarket is AccessControl, ReentrancyGuard, IAvairaCreditMarket {
    using SafeERC20 for IERC20;

    /* --------------------------------- errors -------------------------------- */

    error NotAgentOperator(uint256 agentId, address caller);
    error AgentIsBanned(uint256 agentId);
    error InsufficientCollateral(uint256 required, uint256 provided);
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error NotLiquidatable(uint256 agentId, uint256 currentRatioBps, uint256 requiredRatioBps);
    error RepayTooMuch(uint256 debt, uint256 requested);
    error ZeroAddress();
    error ZeroAmount();

    /* -------------------------------- constants ------------------------------- */

    uint16 public constant BPS = 10_000;
    uint16 public constant TIER_A_RATIO_BPS = 11_000; // score >= 80
    uint16 public constant TIER_B_RATIO_BPS = 12_500; // score 60–79
    uint16 public constant TIER_C_RATIO_BPS = 15_000; // score < 60 or ungraded
    uint8 public constant TIER_A_MIN_SCORE = 80;
    uint8 public constant TIER_B_MIN_SCORE = 60;
    /// @notice Paid to whoever liquidates a breached position, out of the posted collateral.
    uint16 public constant LIQUIDATION_INCENTIVE_BPS = 500;

    /* ---------------------------------- state -------------------------------- */

    IERC20 public immutable asset;
    IAvairaStakeRegistry public stakeRegistry;
    IERC721 public immutable identityRegistry;

    mapping(uint256 agentId => uint256) public collateral;
    mapping(uint256 agentId => uint256) public debt;
    mapping(uint256 agentId => address) public borrower;
    uint256 public totalLiquidity;
    uint256 public totalOutstanding;

    /* ------------------------------- constructor ------------------------------ */

    constructor(address asset_, address stakeRegistry_, address identityRegistry_, address admin) AccessControl() {
        if (asset_ == address(0) || stakeRegistry_ == address(0) || identityRegistry_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        asset = IERC20(asset_);
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
        identityRegistry = IERC721(identityRegistry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /* --------------------------------- liquidity ------------------------------- */

    /// @notice Supplies lendable liquidity to the pool (mock market: no interest accounting).
    function fundLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        totalLiquidity += amount;
    }

    /// @notice Liquidity currently available to borrow.
    function availableLiquidity() public view returns (uint256) {
        return totalLiquidity - totalOutstanding;
    }

    /* ---------------------------------- credit -------------------------------- */

    /// @inheritdoc IAvairaCreditMarket
    /// @dev 110% for A-grade agents, 125% for B, 150% for C/ungraded — read live from the score.
    function collateralRatioBps(uint256 agentId) public view override returns (uint256) {
        uint8 score = stakeRegistry.scoreOf(agentId);
        if (score >= TIER_A_MIN_SCORE) return TIER_A_RATIO_BPS;
        if (score >= TIER_B_MIN_SCORE) return TIER_B_RATIO_BPS;
        return TIER_C_RATIO_BPS;
    }

    /// @notice Maximum additional debt `agentId` can currently support.
    function borrowCapacity(uint256 agentId) public view returns (uint256) {
        uint256 ratio = collateralRatioBps(agentId);
        uint256 maxDebt = (collateral[agentId] * BPS) / ratio;
        return maxDebt > debt[agentId] ? maxDebt - debt[agentId] : 0;
    }

    /// @inheritdoc IAvairaCreditMarket
    function depositCollateral(uint256 agentId, uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        if (_isBanned(agentId)) revert AgentIsBanned(agentId);

        asset.safeTransferFrom(msg.sender, address(this), amount);
        collateral[agentId] += amount;
        if (borrower[agentId] == address(0)) borrower[agentId] = msg.sender;
        emit CollateralDeposited(agentId, msg.sender, amount);
    }

    /// @inheritdoc IAvairaCreditMarket
    function borrow(uint256 agentId, uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        if (_isBanned(agentId)) revert AgentIsBanned(agentId);

        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(available, amount);

        uint256 ratio = collateralRatioBps(agentId);
        uint256 newDebt = debt[agentId] + amount;
        uint256 required = (newDebt * ratio) / BPS;
        if (required > collateral[agentId]) revert InsufficientCollateral(required, collateral[agentId]);

        debt[agentId] = newDebt;
        totalOutstanding += amount;
        if (borrower[agentId] == address(0)) borrower[agentId] = msg.sender;

        asset.safeTransfer(msg.sender, amount);
        emit Borrowed(agentId, msg.sender, amount, ratio, stakeRegistry.scoreOf(agentId));
    }

    /// @inheritdoc IAvairaCreditMarket
    function repay(uint256 agentId, uint256 amount) external override nonReentrant {
        uint256 owed = debt[agentId];
        if (amount > owed) revert RepayTooMuch(owed, amount);

        asset.safeTransferFrom(msg.sender, address(this), amount);
        debt[agentId] = owed - amount;
        totalOutstanding -= amount;
        emit Repaid(agentId, msg.sender, amount, owed - amount);
    }

    /// @inheritdoc IAvairaCreditMarket
    /// @dev Triggered by a score downgrade or a slash, not by price moves: the agent's own
    ///      accountability record tightens its line. The liquidator closes the position by
    ///      repaying the debt and taking the debt plus a 5% incentive from the collateral;
    ///      any remainder is returned to the borrower.
    function liquidate(uint256 agentId) external override nonReentrant {
        uint256 owed = debt[agentId];
        uint256 posted = collateral[agentId];
        uint256 ratio = collateralRatioBps(agentId);
        if (owed == 0 || (owed * ratio) / BPS <= posted) {
            revert NotLiquidatable(agentId, posted == 0 ? type(uint256).max : (posted * BPS) / owed, ratio);
        }

        // The liquidator repays the debt and is paid the debt plus a 5% incentive out of the
        // posted collateral; whatever is left over goes back to the borrower. Zeroing both
        // mappings is mandatory: the position is fully disposed of in this call.
        uint256 maxSeize = (owed * (BPS + LIQUIDATION_INCENTIVE_BPS)) / BPS;
        uint256 seized = posted < maxSeize ? posted : maxSeize;
        uint256 surplus = posted - seized;
        collateral[agentId] = 0;
        debt[agentId] = 0;
        totalOutstanding -= owed;

        asset.safeTransferFrom(msg.sender, address(this), owed);
        asset.safeTransfer(msg.sender, seized);
        if (surplus > 0) asset.safeTransfer(borrower[agentId], surplus);

        emit Liquidated(agentId, msg.sender, owed, seized);
    }

    /* ----------------------------------- views -------------------------------- */

    /// @notice True when the position breaches its score-implied collateral requirement.
    function isLiquidatable(uint256 agentId) external view returns (bool) {
        uint256 owed = debt[agentId];
        if (owed == 0) return false;
        return (owed * collateralRatioBps(agentId)) / BPS > collateral[agentId];
    }

    /* ---------------------------------- admin --------------------------------- */

    function setStakeRegistry(address newStakeRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newStakeRegistry == address(0)) revert ZeroAddress();
        stakeRegistry = IAvairaStakeRegistry(newStakeRegistry);
    }

    /* -------------------------------- internals ------------------------------- */

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
        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("getAgentWallet(uint256)", agentId));
        return ok && data.length >= 32 && abi.decode(data, (address)) == account;
    }

    function _isBanned(uint256 agentId) private view returns (bool) {
        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("isBanned(uint256)", agentId));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }
}
