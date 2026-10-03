// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAgentRegistry {
    enum Status {
        Unregistered,
        Active,
        Frozen
    }

    struct RiskEnvelope {
        uint256 maxTxValue;
        uint8 maxSlippage;
        string allowedActions;
    }

    struct Agent {
        address wallet;
        string name;
        uint256 collateral;
        Status status;
        int256 reputationScore;
        uint256 registeredAt;
        uint256 nonce;
        RiskEnvelope envelope;
    }

    function registerFor(address agent, string calldata name, RiskEnvelope calldata envelope) external payable;
    function freeze(address agent, string calldata reason) external;
    function slash(address agent, uint256 amount, string calldata reason) external returns (uint256);
    function updateReputation(address agent, int256 delta, string calldata reason) external;
    function incrementNonce(address agent) external returns (uint256);
    function recordExecution(address agent, bool success, uint256 complexityBps) external;
    function getAgent(address agent) external view returns (Agent memory);
}
