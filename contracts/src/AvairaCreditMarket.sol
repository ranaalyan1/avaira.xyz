// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Component 6 of 6: AvairaCreditMarket — reputation becomes capital
        ------------------------------------------------------------------
        The money shot, and the point of the whole stack: an onchain credit desk where
        the collateral requirement is a function of the Avaira Score.

            score >= 80 (A+ / A)  → 110% collateral
            score 60–79 (B / C)   → 125% collateral
            score < 60 or ungraded → 150% collateral

        Deliberately minimal — a mock money market with real score-gating. The claim
        being demonstrated is not "we built Aave"; it is "onchain reputation, grounded in
        settled performance and enforced by a slashable stake, prices credit". Every
        loan here is priced off a number that a Sybil ring cannot buy, because posting
        the score requires the scorer role and the inputs come from settlement data.

        Downside protection: SUSPENDED or BANNED agents are frozen out of new credit,
        and existing positions can be liquidated.
//////////////////////////////////////////////////////////////////////////////*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAvairaStakeRegistry} from "./interfaces/IAvairaStakeRegistry.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";
import {AgentStatus} from "./interfaces/IAvairaTypes.sol";

contract AvairaCreditMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    IERC20 public immutable usdc;
    IAvairaStakeRegistry public stakeRegistry;
    IAvairaIdentityRegistry public identity;

    uint16 public constant BPS = 10_000;
    uint16 public constant RATIO_HIGH = 11_000; // 110% — score ≥ 80
    uint16 public constant RATIO_MID = 12_500; // 125% — score 60–79
    uint16 public constant RATIO_UNRATED = 15_000; // 150% — score < 60 or ungraded

    uint8 public highScoreThreshold = 80;
    uint8 public midScoreThreshold = 60;

    /// @notice Simple linear APR charged on outstanding principal (bps).
    uint16 public aprBps = 800; // 8.00%

    /// @notice Protocol reserve factor on interest (bps).
    uint16 public reserveFactorBps = 1_000; // 10% of interest to the treasury

    address public treasury;

    // -------------------------------------------------------------------------
    // Liquidity pool
    //
    // Principal must come from somewhere. Without a pool the market would pay out the
    // borrower's own collateral, and liquidation would find an empty contract — the exact
    // failure mode this design avoids: collateral stays locked, principal is lent by
    // liquidity providers, and interest accrues to them (net of the protocol reserve).
    // -------------------------------------------------------------------------

    /// @notice Pool assets under management (idle liquidity + outstanding principal).
    uint256 public totalLiquidity;

    /// @notice Cumulative shortfall the pool had to absorb on liquidations.
    uint256 public totalBadDebt;

    /// @notice Liquidation bonus paid to the keeper, in bps of principal.
    uint16 public constant LIQUIDATION_BONUS_BPS = 500; // 5%

    mapping(address provider => uint256 amount) public liquidityOf;

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    struct Loan {
        uint256 principal;
        uint256 collateral;
        uint64 openedAt;
        uint256 interestPaid;
    }

    mapping(uint256 agentId => Loan) private _loans;
    mapping(uint256 agentId => uint8) private _scoreAtOrigination;

    uint256 public totalPrincipalOutstanding;
    uint256 public totalInterestEarned;

    // -------------------------------------------------------------------------
    // Events / errors
    // -------------------------------------------------------------------------

    event Borrowed(
        uint256 indexed agentId,
        address indexed borrower,
        uint256 principal,
        uint256 collateral,
        uint8 score,
        uint16 collateralRatioBps
    );
    event Repaid(uint256 indexed agentId, uint256 principal, uint256 interest);
    event CollateralWithdrawn(uint256 indexed agentId, uint256 amount);
    event Liquidated(uint256 indexed agentId, address indexed liquidator, uint256 debt, uint256 collateralSeized);
    event LiquidityDeposited(address indexed provider, uint256 amount, uint256 totalLiquidity);
    event LiquidityWithdrawn(address indexed provider, uint256 amount, uint256 totalLiquidity);
    event BadDebtRecorded(uint256 indexed agentId, uint256 shortfall);

    error NotAgentOwner(uint256 agentId, address caller);
    error AgentNotEligibleForCredit(uint256 agentId, AgentStatus status);
    error LoanAlreadyOpen(uint256 agentId);
    error NoOpenLoan(uint256 agentId);
    error InsufficientCollateral(uint256 required, uint256 provided);
    error LoanStillOpen(uint256 agentId, uint256 debt);
    error Healthy(uint256 agentId, uint256 healthBps);
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientLiquidity(uint256 available, uint256 requested);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address usdc_, address identity_, address stakeRegistry_, address treasury_)
        Ownable(initialOwner)
    {
        if (usdc_ == address(0) || identity_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        identity = IAvairaIdentityRegistry(identity_);
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
        treasury = treasury_;
    }

    // -------------------------------------------------------------------------
    // Pricing — the score gate, in one pure view
    // -------------------------------------------------------------------------

    /// @notice Collateral ratio (bps of principal) required for `agentId` right now.
    function collateralRatioBps(uint256 agentId) public view returns (uint16 ratio) {
        uint8 score = stakeRegistry.score(agentId);
        bool graded = score != 0 || _loans[agentId].openedAt != 0 || _scoreAtOrigination[agentId] != 0;
        if (!graded) return RATIO_UNRATED;
        if (score >= highScoreThreshold) return RATIO_HIGH;
        if (score >= midScoreThreshold) return RATIO_MID;
        return RATIO_UNRATED;
    }

    /// @notice Human-readable tier label for dashboards.
    function tierOf(uint256 agentId) public view returns (string memory) {
        uint16 ratio = collateralRatioBps(agentId);
        if (ratio == RATIO_HIGH) return "A";
        if (ratio == RATIO_MID) return "B";
        return "UNRATED";
    }

    /// @notice Quote a loan before borrowing: enough for the demo overlay.
    function quote(uint256 agentId, uint256 amount)
        external
        view
        returns (uint256 collateralRequired, uint16 ratioBps, uint8 score, string memory tier)
    {
        ratioBps = collateralRatioBps(agentId);
        collateralRequired = (amount * ratioBps) / BPS;
        score = stakeRegistry.score(agentId);
        tier = tierOf(agentId);
    }

    /// @notice Outstanding debt including accrued interest.
    function debtOf(uint256 agentId) public view returns (uint256) {
        Loan storage loan = _loans[agentId];
        if (loan.principal == 0) return 0;
        return loan.principal + _accruedInterest(loan);
    }

    /// @notice Health in bps: collateral / required-collateral-for-current-debt.
    ///         < 10_000 means liquidatable.
    function healthBps(uint256 agentId) public view returns (uint256) {
        Loan storage loan = _loans[agentId];
        if (loan.principal == 0) return type(uint256).max;
        uint256 required = (debtOf(agentId) * collateralRatioBps(agentId)) / BPS;
        if (required == 0) return type(uint256).max;
        return (loan.collateral * BPS) / required;
    }

    // -------------------------------------------------------------------------
    // Liquidity
    // -------------------------------------------------------------------------

    /// @notice Idle liquidity that can be borrowed right now.
    function availableLiquidity() public view returns (uint256) {
        return totalLiquidity - totalPrincipalOutstanding;
    }

    /// @notice Provide USDC to the pool. Interest earned later accrues to the pool.
    function depositLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        liquidityOf[msg.sender] += amount;
        totalLiquidity += amount;
        emit LiquidityDeposited(msg.sender, amount, totalLiquidity);
    }

    /// @notice Withdraw idle liquidity. Funds lent out must be repaid first.
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > liquidityOf[msg.sender]) revert InsufficientLiquidity(liquidityOf[msg.sender], amount);
        uint256 idle = availableLiquidity();
        if (amount > idle) revert InsufficientLiquidity(idle, amount);
        liquidityOf[msg.sender] -= amount;
        totalLiquidity -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount, totalLiquidity);
    }

    // -------------------------------------------------------------------------
    // Borrow / repay
    // -------------------------------------------------------------------------

    /// @notice Borrow USDC against score-priced collateral. Caller must own the agent.
    function borrow(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);

        AgentStatus status = stakeRegistry.statusOf(agentId);
        if (status == AgentStatus.BANNED || status == AgentStatus.SUSPENDED) {
            revert AgentNotEligibleForCredit(agentId, status);
        }
        if (_loans[agentId].principal != 0) revert LoanAlreadyOpen(agentId);

        uint256 idle = availableLiquidity();
        if (amount > idle) revert InsufficientLiquidity(idle, amount);

        uint16 ratio = collateralRatioBps(agentId);
        uint256 collateralRequired = (amount * ratio) / BPS;

        usdc.safeTransferFrom(msg.sender, address(this), collateralRequired);
        usdc.safeTransfer(msg.sender, amount);

        _loans[agentId] = Loan({
            principal: amount,
            collateral: collateralRequired,
            openedAt: uint64(block.timestamp),
            interestPaid: 0
        });
        _scoreAtOrigination[agentId] = stakeRegistry.score(agentId);
        totalPrincipalOutstanding += amount;

        emit Borrowed(agentId, msg.sender, amount, collateralRequired, stakeRegistry.score(agentId), ratio);
    }

    /// @notice Repay principal + accrued interest. Collateral stays until withdrawn.
    function repay(uint256 agentId) external nonReentrant returns (uint256 interest) {
        Loan storage loan = _loans[agentId];
        if (loan.principal == 0) revert NoOpenLoan(agentId);

        interest = _accruedInterest(loan);
        uint256 total = loan.principal + interest;

        usdc.safeTransferFrom(msg.sender, address(this), total);

        uint256 reserve = (interest * reserveFactorBps) / BPS;
        if (reserve != 0) usdc.safeTransfer(treasury, reserve);

        totalPrincipalOutstanding -= loan.principal;
        // The pool earns the interest net of the protocol reserve.
        totalLiquidity += interest - reserve;
        totalInterestEarned += interest;
        loan.interestPaid += interest;
        loan.principal = 0;
        loan.openedAt = uint64(block.timestamp);

        emit Repaid(agentId, total - interest, interest);
    }

    /// @notice Withdraw collateral once the loan is closed.
    function withdrawCollateral(uint256 agentId) external nonReentrant returns (uint256 amount) {
        Loan storage loan = _loans[agentId];
        if (loan.principal != 0) revert LoanStillOpen(agentId, debtOf(agentId));
        if (identity.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);

        amount = loan.collateral;
        if (amount == 0) revert ZeroAmount();
        loan.collateral = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(agentId, amount);
    }

    /// @notice Liquidate an unhealthy or banned/suspended position. Anyone may call.
    function liquidate(uint256 agentId) external nonReentrant returns (uint256 seized) {
        Loan storage loan = _loans[agentId];
        if (loan.principal == 0) revert NoOpenLoan(agentId);

        AgentStatus status = stakeRegistry.statusOf(agentId);
        uint256 health = healthBps(agentId);
        bool bannedButDodging = loan.collateral > 0 && loan.principal > 0 && loan.collateral <= loan.principal;
        if (status != AgentStatus.BANNED && status != AgentStatus.SUSPENDED && health >= BPS && !bannedButDodging) {
            revert Healthy(agentId, health);
        }

        uint256 debt = debtOf(agentId);
        seized = loan.collateral;
        uint256 payout = seized > debt ? debt : seized;

        // Waterfall: the pool is repaid its principal first, then the keeper is paid the
        // accrued interest plus a bonus, and any excess collateral goes back to the owner.
        uint256 toPool = payout < loan.principal ? payout : loan.principal;
        uint256 toKeeper = payout - toPool;
        uint256 remainder = seized - payout;

        if (remainder != 0) {
            uint256 bonus = (loan.principal * LIQUIDATION_BONUS_BPS) / BPS;
            if (bonus > remainder) bonus = remainder;
            toKeeper += bonus;
            remainder -= bonus;
        }

        totalPrincipalOutstanding -= loan.principal;
        if (toPool < loan.principal) {
            // The pool absorbs the shortfall: its claim on the borrower was not covered.
            uint256 shortfall = loan.principal - toPool;
            totalLiquidity -= shortfall;
            totalBadDebt += shortfall;
            emit BadDebtRecorded(agentId, shortfall);
        }

        address owner_ = identity.ownerOf(agentId);
        loan.principal = 0;
        loan.collateral = 0;

        if (toKeeper != 0) usdc.safeTransfer(msg.sender, toKeeper);
        if (remainder != 0 && owner_ != address(0)) usdc.safeTransfer(owner_, remainder);

        emit Liquidated(agentId, msg.sender, debt, seized);
    }

    function loanOf(uint256 agentId) external view returns (Loan memory) {
        return _loans[agentId];
    }

    /// @notice Score at the moment the loan was opened (rate-lock evidence).
    function scoreAtOrigination(uint256 agentId) external view returns (uint8) {
        return _scoreAtOrigination[agentId];
    }

    // -------------------------------------------------------------------------
    // Internals / admin
    // -------------------------------------------------------------------------

    function _accruedInterest(Loan storage loan) private view returns (uint256) {
        if (loan.principal == 0 || loan.openedAt == 0) return 0;
        uint256 elapsed = block.timestamp - loan.openedAt;
        return (loan.principal * aprBps * elapsed) / (uint256(BPS) * 365 days);
    }

    function setParams(uint8 high_, uint8 mid_, uint16 apr_, uint16 reserveFactor_) external onlyOwner {
        require(high_ > mid_, "high must exceed mid");
        highScoreThreshold = high_;
        midScoreThreshold = mid_;
        aprBps = apr_;
        reserveFactorBps = reserveFactor_;
    }

    function setContracts(address identity_, address stakeRegistry_) external onlyOwner {
        if (identity_ != address(0)) identity = IAvairaIdentityRegistry(identity_);
        if (stakeRegistry_ != address(0)) stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }
}
