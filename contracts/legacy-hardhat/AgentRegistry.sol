// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AVAIRA Agent Registry
/// @notice Stores agent registration state, risk envelopes, and protocol-side execution metrics.
contract AgentRegistry is Ownable, ReentrancyGuard {
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

    struct WithdrawalRequest {
        uint256 amount;
        uint256 availableAt;
    }

    uint256 public constant MIN_COLLATERAL = 0.1 ether;
    uint256 public constant WITHDRAWAL_COOLDOWN = 1 days;

    mapping(address => Agent) private agents;
    mapping(address => bool) public protocolAuthorized;
    mapping(address => WithdrawalRequest) public withdrawalRequests;
    mapping(address => uint256) public successfulExecutions;
    mapping(address => uint256) public failedExecutions;
    mapping(address => uint256) public freezeCounts;
    mapping(address => uint256) public slashCounts;
    mapping(address => uint256) public missionComplexityBps;
    mapping(address => uint256) public maxCollateralObserved;

    event AgentRegistered(address indexed agent, string name, uint256 collateral, uint256 registeredAt);
    event AgentFrozen(address indexed agent, address indexed actor, string reason, uint256 timestamp);
    event AgentSlashed(address indexed agent, address indexed actor, uint256 amount, string reason, uint256 timestamp);
    event ReputationUpdated(address indexed agent, int256 oldScore, int256 newScore, string reason);
    event ProtocolAuthorizationUpdated(address indexed actor, bool authorized);
    event WithdrawalRequested(address indexed agent, uint256 amount, uint256 availableAt);
    event WithdrawalCompleted(address indexed agent, uint256 amount);
    event NonceIncremented(address indexed agent, uint256 newNonce);
    event ExecutionRecorded(address indexed agent, bool success, uint256 missionComplexity, uint256 totalSuccesses, uint256 totalFailures);
    event AgentStatusUpdated(address indexed agent, Status previousStatus, Status newStatus, string reason);

    error AgentRegistry__AgentAlreadyRegistered();
    error AgentRegistry__AgentNotRegistered();
    error AgentRegistry__InsufficientCollateral();
    error AgentRegistry__NotProtocolAuthorized();
    error AgentRegistry__InvalidEnvelope();
    error AgentRegistry__InvalidAmount();
    error AgentRegistry__CooldownActive(uint256 availableAt);
    error AgentRegistry__NoPendingWithdrawal();
    error AgentRegistry__FrozenAgent();
    error AgentRegistry__InvalidAgent();

    modifier onlyProtocol() {
        if (!(protocolAuthorized[msg.sender] || msg.sender == owner())) {
            revert AgentRegistry__NotProtocolAuthorized();
        }
        _;
    }

    constructor() Ownable(msg.sender) {}

    /// @notice Adds or removes a protocol-authorized caller.
    /// @param actor The address to authorize or revoke.
    /// @param authorized Whether the address should be authorized.
    function setProtocol(address actor, bool authorized) external onlyOwner {
        protocolAuthorized[actor] = authorized;
        emit ProtocolAuthorizationUpdated(actor, authorized);
    }

    /// @notice Registers the caller as an AVAIRA agent by staking collateral.
    /// @param name The display name of the agent.
    /// @param envelope The registered risk envelope.
    function register(string calldata name, RiskEnvelope calldata envelope) external payable nonReentrant {
        _register(msg.sender, name, envelope, msg.value);
    }

    /// @notice Registers an agent from a protocol-authorized actor.
    /// @param agent The target agent wallet.
    /// @param name The display name of the agent.
    /// @param envelope The registered risk envelope.
    function registerFor(address agent, string calldata name, RiskEnvelope calldata envelope)
        external
        payable
        onlyProtocol
        nonReentrant
    {
        _register(agent, name, envelope, msg.value);
    }

    /// @notice Sets an explicit status value for an agent.
    /// @param agent The target agent wallet.
    /// @param newStatus The new status to set.
    /// @param reason Human-readable status transition reason.
    function setStatus(address agent, Status newStatus, string calldata reason) external onlyProtocol {
        Agent storage target = _requireRegisteredAgent(agent);
        Status oldStatus = target.status;
        target.status = newStatus;
        emit AgentStatusUpdated(agent, oldStatus, newStatus, reason);
    }

    function _register(address agent, string calldata name, RiskEnvelope calldata envelope, uint256 collateral) internal {
        if (agent == address(0)) {
            revert AgentRegistry__InvalidAgent();
        }
        Agent storage existing = agents[agent];
        if (existing.status != Status.Unregistered) {
            revert AgentRegistry__AgentAlreadyRegistered();
        }
        if (collateral < MIN_COLLATERAL) {
            revert AgentRegistry__InsufficientCollateral();
        }
        if (bytes(name).length == 0 || bytes(envelope.allowedActions).length == 0 || envelope.maxTxValue == 0) {
            revert AgentRegistry__InvalidEnvelope();
        }

        agents[agent] = Agent({
            wallet: agent,
            name: name,
            collateral: collateral,
            status: Status.Active,
            reputationScore: 0,
            registeredAt: block.timestamp,
            nonce: 0,
            envelope: envelope
        });
        maxCollateralObserved[agent] = collateral;

        emit AgentRegistered(agent, name, collateral, block.timestamp);
    }

    /// @notice Freezes an agent and prevents further execution.
    /// @param agent The agent wallet address.
    /// @param reason Human-readable reason for the freeze.
    function freeze(address agent, string calldata reason) external onlyProtocol {
        Agent storage target = _requireRegisteredAgent(agent);
        target.status = Status.Frozen;
        freezeCounts[agent] += 1;
        emit AgentFrozen(agent, msg.sender, reason, block.timestamp);
    }

    /// @notice Slashes collateral from an agent.
    /// @param agent The agent wallet address.
    /// @param amount Amount of collateral to slash.
    /// @param reason Human-readable reason for the slash.
    /// @return slashed The actual amount slashed.
    function slash(address agent, uint256 amount, string calldata reason) external onlyProtocol nonReentrant returns (uint256 slashed) {
        Agent storage target = _requireRegisteredAgent(agent);
        if (amount == 0) {
            revert AgentRegistry__InvalidAmount();
        }
        slashed = amount > target.collateral ? target.collateral : amount;
        target.collateral -= slashed;
        slashCounts[agent] += 1;
        if (target.collateral < MIN_COLLATERAL) {
            target.status = Status.Frozen;
        }
        emit AgentSlashed(agent, msg.sender, slashed, reason, block.timestamp);
    }

    /// @notice Applies a signed delta to an agent reputation score.
    /// @param agent The agent wallet address.
    /// @param delta Signed score delta to apply.
    /// @param reason Human-readable reason for the update.
    function updateReputation(address agent, int256 delta, string calldata reason) external onlyProtocol {
        Agent storage target = _requireRegisteredAgent(agent);
        int256 oldScore = target.reputationScore;
        target.reputationScore = oldScore + delta;
        emit ReputationUpdated(agent, oldScore, target.reputationScore, reason);
    }

    /// @notice Increments the agent nonce used in permit replay protection.
    /// @param agent The agent wallet address.
    /// @return newNonce The incremented nonce value.
    function incrementNonce(address agent) external onlyProtocol returns (uint256 newNonce) {
        Agent storage target = _requireRegisteredAgent(agent);
        target.nonce += 1;
        newNonce = target.nonce;
        emit NonceIncremented(agent, newNonce);
    }

    /// @notice Records a protocol-side execution outcome and mission complexity.
    /// @param agent The agent wallet address.
    /// @param success Whether the execution succeeded.
    /// @param complexityBps Mission complexity in basis points.
    function recordExecution(address agent, bool success, uint256 complexityBps) external onlyProtocol {
        _requireRegisteredAgent(agent);
        require(complexityBps <= 10_000, "AgentRegistry: complexity too high");
        missionComplexityBps[agent] = complexityBps;
        if (success) {
            successfulExecutions[agent] += 1;
        } else {
            failedExecutions[agent] += 1;
        }
        emit ExecutionRecorded(agent, success, complexityBps, successfulExecutions[agent], failedExecutions[agent]);
    }

    /// @notice Schedules collateral withdrawal after a cooldown.
    /// @param amount Amount of collateral requested for withdrawal.
    function requestWithdrawal(uint256 amount) external {
        Agent storage target = _requireRegisteredAgent(msg.sender);
        if (target.status == Status.Frozen) {
            revert AgentRegistry__FrozenAgent();
        }
        if (amount == 0 || amount > target.collateral) {
            revert AgentRegistry__InvalidAmount();
        }
        uint256 availableAt = block.timestamp + WITHDRAWAL_COOLDOWN;
        withdrawalRequests[msg.sender] = WithdrawalRequest({amount: amount, availableAt: availableAt});
        emit WithdrawalRequested(msg.sender, amount, availableAt);
    }

    /// @notice Completes a pending collateral withdrawal once cooldown has elapsed.
    function withdrawCollateral() external nonReentrant {
        Agent storage target = _requireRegisteredAgent(msg.sender);
        WithdrawalRequest memory request = withdrawalRequests[msg.sender];
        if (request.amount == 0) {
            revert AgentRegistry__NoPendingWithdrawal();
        }
        if (block.timestamp < request.availableAt) {
            revert AgentRegistry__CooldownActive(request.availableAt);
        }
        if (request.amount > target.collateral) {
            revert AgentRegistry__InvalidAmount();
        }
        delete withdrawalRequests[msg.sender];
        target.collateral -= request.amount;
        (bool sent, ) = payable(msg.sender).call{value: request.amount}("");
        require(sent, "AgentRegistry: withdrawal failed");
        if (target.collateral == 0) {
            target.status = Status.Unregistered;
        }
        emit WithdrawalCompleted(msg.sender, request.amount);
    }

    /// @notice Reads the full agent struct.
    /// @param agent The agent wallet address.
    /// @return The agent metadata and registration state.
    function getAgent(address agent) external view returns (Agent memory) {
        return agents[agent];
    }

    /// @notice Returns whether an agent is active.
    /// @param agent The agent wallet address.
    function isActive(address agent) external view returns (bool) {
        return agents[agent].status == Status.Active;
    }

    /// @notice Returns execution and deviation counters used by the score engine.
    /// @param agent The agent wallet address.
    function getAgentMetrics(address agent)
        external
        view
        returns (
            uint256 successCount,
            uint256 failureCount,
            uint256 freezes,
            uint256 slashes,
            uint256 complexity,
            uint256 peakCollateral
        )
    {
        successCount = successfulExecutions[agent];
        failureCount = failedExecutions[agent];
        freezes = freezeCounts[agent];
        slashes = slashCounts[agent];
        complexity = missionComplexityBps[agent];
        peakCollateral = maxCollateralObserved[agent];
    }

    function _requireRegisteredAgent(address agent) internal view returns (Agent storage target) {
        target = agents[agent];
        if (target.wallet == address(0) || target.status == Status.Unregistered) {
            revert AgentRegistry__AgentNotRegistered();
        }
    }
}
