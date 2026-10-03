// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CollateralVault
 * @notice Yield-bearing AVAX vault for AVAIRA agent collateral.
 *
 * Mechanics:
 *   - Agent deposits AVAX → receives cAVAX (collateral receipt token) at 1:1
 *   - Exchange rate increases over time as yield accrues (like stETH)
 *   - On slash: principal is slashed, accrued yield returned to agent
 *   - Only authorized FreezeSlash contract can call slash()
 *
 * Yield source: simulated at fixed APY on testnet.
 *              Integrate Benqi sAVAX on mainnet for real yield.
 */
contract CollateralVault is ERC20, Ownable, ReentrancyGuard {
    /// @notice Only this address can slash collateral
    address public slasher;

    /// @notice AVAX per cAVAX, scaled by 1e18. Starts at 1e18 (1:1), increases with yield.
    uint256 public exchangeRate = 1e18;

    /// @notice Timestamp of last rate accrual
    uint256 public lastRateUpdate;

    /// @notice Annual yield in basis points (500 = 5% APY)
    uint256 public yieldRateBps = 500;

    /// @notice Protocol fee on yield, in basis points (1000 = 10% of yield)
    uint256 public protocolFeeBps = 1000;

    /// @notice Accumulated protocol fees (AVAX) not yet withdrawn
    uint256 public accumulatedFees;

    event Deposited(address indexed agent, uint256 avaxAmount, uint256 cAvaxMinted);
    event Withdrawn(address indexed agent, uint256 cAvaxBurned, uint256 avaxReturned);
    event Slashed(address indexed agent, address indexed recipient, uint256 avaxSlashed, uint256 yieldReturned);
    event YieldAccrued(uint256 newRate, uint256 timestamp);
    event SlasherUpdated(address oldSlasher, address newSlasher);
    event YieldRateUpdated(uint256 oldBps, uint256 newBps);

    error Unauthorized();
    error ZeroAmount();
    error InsufficientBalance();
    error TransferFailed();
    error ExceedsMaxYieldRate();

    constructor() ERC20("Avaira Collateral AVAX", "cAVAX") Ownable(msg.sender) {
        lastRateUpdate = block.timestamp;
    }

    // ─── AGENT ACTIONS ────────────────────────────────────────────

    /**
     * @notice Deposit AVAX, receive cAVAX at current exchange rate.
     * @return cAvaxAmount Amount of cAVAX minted to msg.sender.
     */
    function deposit() external payable nonReentrant returns (uint256 cAvaxAmount) {
        if (msg.value == 0) revert ZeroAmount();
        _accrueYield();
        cAvaxAmount = (msg.value * 1e18) / exchangeRate;
        _mint(msg.sender, cAvaxAmount);
        emit Deposited(msg.sender, msg.value, cAvaxAmount);
    }

    /**
     * @notice Burn cAVAX and receive AVAX at current exchange rate (principal + yield).
     * @param cAvaxAmount Amount of cAVAX to redeem.
     * @return avaxAmount AVAX returned to msg.sender.
     */
    function withdraw(uint256 cAvaxAmount) external nonReentrant returns (uint256 avaxAmount) {
        if (cAvaxAmount == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < cAvaxAmount) revert InsufficientBalance();
        _accrueYield();
        avaxAmount = (cAvaxAmount * exchangeRate) / 1e18;
        _burn(msg.sender, cAvaxAmount);
        (bool ok,) = msg.sender.call{value: avaxAmount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, cAvaxAmount, avaxAmount);
    }

    // ─── PROTOCOL ACTIONS ─────────────────────────────────────────

    /**
     * @notice Slash an agent's principal collateral.
     *         Only callable by the authorized FreezeSlash contract.
     *         Accrued yield is returned to the agent as partial forgiveness incentive.
     *
     * @param agent       Agent address to slash.
     * @param principalBps Basis points of principal to slash (10000 = 100%).
     * @param recipient   Destination for slashed AVAX (treasury).
     */
    function slash(
        address agent,
        uint256 principalBps,
        address recipient
    ) external nonReentrant {
        if (msg.sender != slasher) revert Unauthorized();
        if (principalBps == 0 || principalBps > 10_000) revert ZeroAmount();

        _accrueYield();

        uint256 cAvaxBalance = balanceOf(agent);
        if (cAvaxBalance == 0) return;

        uint256 totalAvax = (cAvaxBalance * exchangeRate) / 1e18;
        // Original deposit approximation: 1 cAVAX was worth 1 AVAX at deposit time.
        // Yield is totalAvax minus what was originally deposited.
        uint256 principalAvax = cAvaxBalance; // 1:1 at deposit
        if (principalAvax > totalAvax) principalAvax = totalAvax;
        uint256 yieldAvax = totalAvax - principalAvax;

        uint256 avaxToSlash = (principalAvax * principalBps) / 10_000;
        uint256 cAvaxToBurn = (avaxToSlash * 1e18) / exchangeRate;
        if (cAvaxToBurn > cAvaxBalance) cAvaxToBurn = cAvaxBalance;

        _burn(agent, cAvaxToBurn);

        // Return accrued yield to agent (non-reverting — agent may reject ETH)
        if (yieldAvax > 0) {
            (bool yieldSent,) = agent.call{value: yieldAvax}("");
            if (!yieldSent) accumulatedFees += yieldAvax;
        }

        (bool ok,) = recipient.call{value: avaxToSlash}("");
        if (!ok) revert TransferFailed();

        emit Slashed(agent, recipient, avaxToSlash, yieldAvax);
    }

    // ─── VIEW ─────────────────────────────────────────────────────

    /// @notice Total AVAX value of an agent's cAVAX position.
    function getAvaxValue(address agent) external view returns (uint256) {
        return (balanceOf(agent) * exchangeRate) / 1e18;
    }

    /// @notice Yield accrued since deposit (approximate).
    function getYieldAccrued(address agent) external view returns (uint256) {
        uint256 total = (balanceOf(agent) * exchangeRate) / 1e18;
        uint256 principal = balanceOf(agent);
        return total > principal ? total - principal : 0;
    }

    /// @notice Current effective APY in basis points.
    function currentApy() external view returns (uint256) {
        return yieldRateBps;
    }

    // ─── INTERNAL ─────────────────────────────────────────────────

    /**
     * @dev Compound interest accumulation on exchange rate.
     *      Called before every deposit/withdraw/slash to keep rate current.
     */
    function _accrueYield() internal {
        uint256 elapsed = block.timestamp - lastRateUpdate;
        if (elapsed == 0) return;
        uint256 newRate = exchangeRate
            + (exchangeRate * yieldRateBps * elapsed) / (10_000 * 365 days);
        exchangeRate = newRate;
        lastRateUpdate = block.timestamp;
        emit YieldAccrued(newRate, block.timestamp);
    }

    // ─── ADMIN ────────────────────────────────────────────────────

    /// @notice Set the contract authorized to call slash().
    function setSlasher(address _slasher) external onlyOwner {
        emit SlasherUpdated(slasher, _slasher);
        slasher = _slasher;
    }

    /// @notice Update yield rate. Capped at 20% APY for safety.
    function setYieldRate(uint256 _bps) external onlyOwner {
        if (_bps > 2000) revert ExceedsMaxYieldRate();
        emit YieldRateUpdated(yieldRateBps, _bps);
        yieldRateBps = _bps;
    }

    /// @notice Withdraw accumulated protocol fees to owner.
    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        (bool ok,) = owner().call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}
