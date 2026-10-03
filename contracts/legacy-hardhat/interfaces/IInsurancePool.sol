// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IInsurancePool {
    function fundPool() external payable;
    function allocateCompensation(address backer, uint256 amount, bytes32 missionId, string calldata reason) external;
    function claimCompensation() external;
    function poolBalance() external view returns (uint256);
}
