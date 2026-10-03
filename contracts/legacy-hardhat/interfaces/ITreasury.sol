// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITreasury {
    function setExecutionWallet(address executionWallet) external;
    function setSplitWallets(address trustPoolWallet, address protocolRevenueWallet) external;
    function getStats() external view returns (uint256, uint256, uint256);
}
