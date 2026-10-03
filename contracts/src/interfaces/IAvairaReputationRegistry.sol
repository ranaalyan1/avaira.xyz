// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymentProof} from "./IAvairaTypes.sol";

/// @title IAvairaReputationRegistry — ERC-8004 Reputation Registry, grounded.
/// @notice Spec-compatible feedback API plus the fixes the empirical study demands:
///         every feedback record is *costly* (staked reviewer) or *grounded* (a verified
///         x402/USDC payment), tag values are commensurable (fixed tag whitelist with
///         per-tag decimals and ranges), and the headline reputation number is the
///         Avaira Score derived from settlements and validations — never from raw
///         feedback alone.
interface IAvairaReputationRegistry {
    /// @notice Canonical ERC-8004 event, emitted alongside {FeedbackGiven} so existing
    ///         8004 indexers pick Avaira feedback up without changes.
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackGiven(
        uint256 indexed agentId,
        address indexed reviewer,
        uint64 indexed feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2,
        bool groundedByStake,
        bool groundedByPayment,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed reviewer, uint64 feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed reviewer,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );
    event ScorePosted(uint256 indexed agentId, uint8 score, string grade, bytes32 breakdownHash, address indexed scorer);
    event AgentBannedOnchain(uint256 indexed agentId, uint8 previousScore);
    event ScorerUpdated(address indexed previousScorer, address indexed newScorer);
    event PaymentAttested(bytes32 indexed paymentRef, uint256 indexed agentId, address indexed payer, uint256 amount);
    event TagConfigured(string tag1, uint8 decimals, int128 minValue, int128 maxValue, bool enabled);

    struct FeedbackRecord {
        int128 value;
        uint8 valueDecimals;
        uint64 timestamp;
        bool revoked;
        bool groundedByStake;
        bool groundedByPayment;
        bytes32 feedbackHash;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function giveFeedbackWithPayment(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        PaymentProof calldata proof
    ) external;

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    function appendResponse(
        uint256 agentId,
        address reviewer,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external;

    function readFeedback(uint256 agentId, address reviewer, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool revoked);

    function getSummary(uint256 agentId, address[] calldata reviewers, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    /// @notice Avaira Score 0–100 as posted by the scorer service (0 when never posted).
    function scoreOf(uint256 agentId) external view returns (uint8);

    /// @notice True once a score has been posted for `agentId`.
    function hasScore(uint256 agentId) external view returns (bool);

    /// @notice Timestamp of the latest score posting.
    function scorePostedAt(uint256 agentId) external view returns (uint64);

    /// @notice Letter grade for the posted score ("A+" … "D").
    function gradeOf(uint256 agentId) external view returns (string memory);

    /// @notice Hash of the score breakdown (components) published to IPFS by the scorer.
    function scoreBreakdownOf(uint256 agentId) external view returns (bytes32);

    /// @notice Number of feedback records a reviewer has left for an agent.
    function feedbackCount(uint256 agentId, address reviewer) external view returns (uint64);

    /// @notice Called by the stake registry on BAN: zeroes and freezes the score.
    function markBanned(uint256 agentId) external;
}
