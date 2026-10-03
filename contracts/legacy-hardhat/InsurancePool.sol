// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AVAIRA Insurance Pool
/// @notice Holds compensation capital and pays mission backers when agent executions fail.
contract InsurancePool is Ownable, ReentrancyGuard {
    mapping(address => uint256) public backerClaimable;
    mapping(address => bool) public protocolAuthorized;

    uint256 public totalFunded;
    uint256 public totalCompensated;

    event ProtocolAuthorizationUpdated(address indexed actor, bool authorized);
    event PoolFunded(address indexed from, uint256 amount);
    event CompensationAllocated(address indexed backer, uint256 amount, bytes32 indexed missionId, string reason);
    event CompensationClaimed(address indexed backer, uint256 amount);

    modifier onlyProtocolAuthorized() {
        require(protocolAuthorized[msg.sender] || msg.sender == owner(), "InsurancePool: unauthorized");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setProtocolAuthorized(address actor, bool authorized) external onlyOwner {
        protocolAuthorized[actor] = authorized;
        emit ProtocolAuthorizationUpdated(actor, authorized);
    }

    function fundPool() external payable {
        require(msg.value > 0, "InsurancePool: amount is zero");
        totalFunded += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    function allocateCompensation(address backer, uint256 amount, bytes32 missionId, string calldata reason)
        external
        onlyProtocolAuthorized
    {
        require(backer != address(0), "InsurancePool: invalid backer");
        require(amount > 0, "InsurancePool: amount is zero");
        require(address(this).balance >= amount, "InsurancePool: insufficient pool balance");

        backerClaimable[backer] += amount;
        totalCompensated += amount;
        emit CompensationAllocated(backer, amount, missionId, reason);
    }

    function claimCompensation() external nonReentrant {
        uint256 amount = backerClaimable[msg.sender];
        require(amount > 0, "InsurancePool: no claimable balance");

        backerClaimable[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "InsurancePool: transfer failed");

        emit CompensationClaimed(msg.sender, amount);
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
