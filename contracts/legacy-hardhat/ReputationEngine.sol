// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistry.sol";

/// @title AVAIRA Reputation Engine
/// @notice Computes composite Avaira scores directly from AgentRegistry state.
contract ReputationEngine is Ownable {
    AgentRegistry public immutable registry;
    uint256 public constant INITIAL_SCORE = 50;
    uint256 public constant SUCCESS_DELTA = 2;
    uint256 public constant FAILURE_DELTA = 5;
    uint256 public constant FREEZE_DELTA = 20;

    mapping(address => uint256) private scores;
    mapping(address => bool) public protocolAuthorized;

    event ScoreUpdated(address indexed agent, uint256 previousScore, uint256 newScore, string reason);
    event ProtocolAuthorizationUpdated(address indexed actor, bool authorized);

    modifier onlyProtocolAuthorized() {
        require(protocolAuthorized[msg.sender] || msg.sender == owner(), "ReputationEngine: unauthorized");
        _;
    }

    constructor(address registryAddress) Ownable(msg.sender) {
        registry = AgentRegistry(registryAddress);
    }

    function setProtocolAuthorized(address actor, bool authorized) external onlyOwner {
        protocolAuthorized[actor] = authorized;
        emit ProtocolAuthorizationUpdated(actor, authorized);
    }

    function scoreOf(address agent) external view returns (uint256) {
        uint256 current = scores[agent];
        return current == 0 ? INITIAL_SCORE : current;
    }

    function recordSuccess(address agent) external onlyProtocolAuthorized {
        _applyDelta(agent, int256(uint256(SUCCESS_DELTA)), "success");
    }

    function recordFailure(address agent) external onlyProtocolAuthorized {
        _applyDelta(agent, -int256(uint256(FAILURE_DELTA)), "failure");
    }

    function recordFreeze(address agent) external onlyProtocolAuthorized {
        _applyDelta(agent, -int256(uint256(FREEZE_DELTA)), "freeze");
    }

    /// @notice Computes the composite Avaira score and grade for an agent.
    /// @param agent The agent wallet address.
    /// @return score The weighted score from 0 to 100.
    /// @return grade The human-readable grade bucket.
    function computeAvairaScore(address agent) external view returns (uint256 score, string memory grade) {
        AgentRegistry.Agent memory agentData = registry.getAgent(agent);
        if (agentData.wallet == address(0) || agentData.status == AgentRegistry.Status.Unregistered) {
            return (0, "D");
        }

        (uint256 successCount, uint256 failureCount, uint256 freezes, uint256 slashes, uint256 complexityBps, uint256 peakCollateral) =
            registry.getAgentMetrics(agent);

        uint256 successRate = _successRate(successCount, failureCount);
        uint256 behaviorConsistency = _behaviorConsistency(agentData.reputationScore, freezes, slashes);
        uint256 collateralRatio = _collateralRatio(agentData.collateral, peakCollateral);
        uint256 missionComplexity = _missionComplexity(complexityBps, bytes(agentData.envelope.allowedActions).length);
        uint256 timeOnNetwork = _timeOnNetwork(agentData.registeredAt);
        uint256 deviationPenalty = _deviationPenalty(freezes, slashes);

        uint256 weightedScore = (
            (successRate * 30)
                + (behaviorConsistency * 20)
                + (collateralRatio * 15)
                + (missionComplexity * 15)
                + (timeOnNetwork * 10)
                + (deviationPenalty * 10)
        ) / 100;
        uint256 trackedScore = scores[agent] == 0 ? INITIAL_SCORE : scores[agent];
        score = ((weightedScore * 70) + (trackedScore * 30)) / 100;
        grade = _grade(score);
    }

    /// @notice Returns the detailed component breakdown used for scoring.
    /// @param agent The agent wallet address.
    function scoreBreakdown(address agent)
        external
        view
        returns (
            uint256 successRate,
            uint256 behaviorConsistency,
            uint256 collateralRatio,
            uint256 missionComplexity,
            uint256 timeOnNetwork,
            uint256 deviationPenalty
        )
    {
        AgentRegistry.Agent memory agentData = registry.getAgent(agent);
        (uint256 successCount, uint256 failureCount, uint256 freezes, uint256 slashes, uint256 complexityBps, uint256 peakCollateral) =
            registry.getAgentMetrics(agent);

        successRate = _successRate(successCount, failureCount);
        behaviorConsistency = _behaviorConsistency(agentData.reputationScore, freezes, slashes);
        collateralRatio = _collateralRatio(agentData.collateral, peakCollateral);
        missionComplexity = _missionComplexity(complexityBps, bytes(agentData.envelope.allowedActions).length);
        timeOnNetwork = _timeOnNetwork(agentData.registeredAt);
        deviationPenalty = _deviationPenalty(freezes, slashes);
    }

    function _successRate(uint256 successCount, uint256 failureCount) internal pure returns (uint256) {
        uint256 total = successCount + failureCount;
        if (total == 0) {
            return 50;
        }
        return (successCount * 100) / total;
    }

    function _behaviorConsistency(int256 reputationScore, uint256 freezes, uint256 slashes) internal pure returns (uint256) {
        int256 base = 70 + reputationScore;
        base -= int256((freezes * 8) + (slashes * 12));
        if (base < 0) {
            return 0;
        }
        if (base > 100) {
            return 100;
        }
        return uint256(base);
    }

    function _collateralRatio(uint256 collateral, uint256 peakCollateral) internal pure returns (uint256) {
        if (peakCollateral == 0) {
            return collateral > 0 ? 100 : 0;
        }
        uint256 ratio = (collateral * 100) / peakCollateral;
        return ratio > 100 ? 100 : ratio;
    }

    function _missionComplexity(uint256 complexityBps, uint256 actionTextLength) internal pure returns (uint256) {
        uint256 normalized = complexityBps / 100;
        uint256 diversityBoost = actionTextLength > 24 ? 10 : actionTextLength > 12 ? 5 : 0;
        uint256 score = normalized + diversityBoost;
        return score > 100 ? 100 : score;
    }

    function _timeOnNetwork(uint256 registeredAt) internal view returns (uint256) {
        if (registeredAt == 0 || block.timestamp <= registeredAt) {
            return 0;
        }
        uint256 elapsedDays = (block.timestamp - registeredAt) / 1 days;
        uint256 capped = elapsedDays > 365 ? 365 : elapsedDays;
        return (capped * 100) / 365;
    }

    function _deviationPenalty(uint256 freezes, uint256 slashes) internal pure returns (uint256) {
        uint256 penalty = (freezes * 20) + (slashes * 25);
        if (penalty >= 100) {
            return 0;
        }
        return 100 - penalty;
    }

    function _grade(uint256 score) internal pure returns (string memory) {
        if (score >= 90) {
            return "A+";
        }
        if (score >= 80) {
            return "A";
        }
        if (score >= 70) {
            return "B";
        }
        if (score >= 60) {
            return "C";
        }
        return "D";
    }

    function _applyDelta(address agent, int256 delta, string memory reason) internal {
        uint256 previous = scores[agent] == 0 ? INITIAL_SCORE : scores[agent];
        uint256 next;
        if (delta >= 0) {
            next = previous + uint256(delta);
            if (next > 100) {
                next = 100;
            }
        } else {
            uint256 absDelta = uint256(-delta);
            next = absDelta > previous ? 0 : previous - absDelta;
        }
        scores[agent] = next;
        emit ScoreUpdated(agent, previous, next, reason);
    }
}
