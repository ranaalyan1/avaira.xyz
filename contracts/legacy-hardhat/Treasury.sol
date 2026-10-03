// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Treasury is Ownable, ReentrancyGuard {
    uint256 public constant TRUST_POOL_BPS = 7500;
    uint256 public constant REVENUE_BPS = 2500;

    uint256 public trustPoolBalance;
    uint256 public protocolRevenueBalance;
    uint256 public totalFeesReceived;

    address public executionWallet;
    address public trustPoolWallet;
    address public protocolRevenueWallet;

    event FeeReceived(uint256 total, uint256 trustPool, uint256 revenue);
    event RevenueWithdrawn(address indexed to, uint256 amount);
    event TrustPoolWithdrawn(address indexed to, uint256 amount);
    event SplitWalletsUpdated(address indexed trustPoolWallet, address indexed protocolRevenueWallet);

    modifier onlyExecutionWallet() {
        require(msg.sender == executionWallet || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setExecutionWallet(address _ew) external onlyOwner {
        executionWallet = _ew;
    }

    function setSplitWallets(address _trustPoolWallet, address _protocolRevenueWallet) external onlyOwner {
        trustPoolWallet = _trustPoolWallet;
        protocolRevenueWallet = _protocolRevenueWallet;
        emit SplitWalletsUpdated(_trustPoolWallet, _protocolRevenueWallet);
    }

    receive() external payable onlyExecutionWallet nonReentrant {
        uint256 tp = (msg.value * TRUST_POOL_BPS) / 10000;
        uint256 rev = msg.value - tp;

        trustPoolBalance += tp;
        protocolRevenueBalance += rev;
        totalFeesReceived += msg.value;

        if (trustPoolWallet != address(0) && tp > 0) {
            (bool sentTp, ) = payable(trustPoolWallet).call{value: tp}("");
            if (sentTp) {
                trustPoolBalance -= tp;
            }
        }

        if (protocolRevenueWallet != address(0) && rev > 0) {
            (bool sentRev, ) = payable(protocolRevenueWallet).call{value: rev}("");
            if (sentRev) {
                protocolRevenueBalance -= rev;
            }
        }

        emit FeeReceived(msg.value, tp, rev);
    }

    function withdrawRevenue(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(amount <= protocolRevenueBalance, "Insufficient balance");
        protocolRevenueBalance -= amount;
        to.transfer(amount);
        emit RevenueWithdrawn(to, amount);
    }

    function withdrawTrustPool(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(amount <= trustPoolBalance, "Insufficient balance");
        trustPoolBalance -= amount;
        to.transfer(amount);
        emit TrustPoolWithdrawn(to, amount);
    }

    function getStats() external view returns (uint256, uint256, uint256) {
        return (totalFeesReceived, trustPoolBalance, protocolRevenueBalance);
    }
}
