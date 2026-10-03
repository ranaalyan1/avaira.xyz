// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IERC8004ReputationRegistry} from "../interfaces/IERC8004.sol";
import {IAvairaStakeRegistry, IAvairaScoreReader, IEIP3009} from "../interfaces/IAvaira.sol";

/// @title AvairaReputationRegistry
/// @notice ERC-8004 Reputation Registry whose feedback is *grounded*.
/// @dev The June 2026 Imperial College study "Can Trustless Agents Be Trusted?"
///      (arXiv 2606.26028) crawled every live ERC-8004 deployment and found the
///      reputation layer unusable as a trust signal: 59–90.6% of reviewers show
///      coordinated Sybil behaviour, feedback is rarely tied to a verifiable
///      interaction, and values are not commensurable.
///
///      This contract fixes each of the three documented flaws at the protocol level:
///
///      1. **Sybil reviewers** — `giveFeedback` reverts unless the submitter is a
///         staked reviewer (`isStakedReviewer`) with skin in the game.
///      2. **Ungrounded feedback** — the alternative path, `giveFeedbackWithPayment`,
///         settles an EIP-3009 USDC payment *inside the same transaction* that records
///         the feedback. A reviewer cannot post without either capital at risk or a
///         real x402-style payment to the agent.
///      3. **Incommensurable values** — `tag1` must be one of the ERC-8004 standard
///         tags, so values mean the same thing across every submission.
///
///      On top of that, `postAvairaScore` publishes the weighted Avaira Score
///      (0–100) computed offchain from objective settlement/validation data — never
///      from raw feedback — and readable by any contract on Monad.
contract AvairaReputationRegistry is AccessControl, ReentrancyGuard, IERC8004ReputationRegistry, IAvairaScoreReader {
    /* --------------------------------- errors -------------------------------- */

    error UnsupportedTag(string tag1);
    error NotAGroundedReviewer(address reviewer);
    error ReviewerIsAgentOperator(address reviewer, uint256 agentId);
    error NotAgentOperator(address caller, uint256 agentId);
    error UnsupportedSettlementToken(address token);
    error PaymentTooSmall(uint256 required, uint256 provided);
    error PaymentPayeeMismatch(address expected, address provided);
    error NotRegisteredAgent(uint256 agentId);
    error AgentIsBanned(uint256 agentId);
    error UnknownFeedback(uint256 agentId, address reviewer, uint64 feedbackIndex);
    error AlreadyRevoked();
    error NotReviewer();
    error ValueDecimalsTooLarge(uint8 valueDecimals);
    error NoReviewersSupplied();
    error InvalidScore(uint8 score);
    error LengthMismatch();

    /* --------------------------------- roles --------------------------------- */

    /// @notice Role allowed to publish the offchain-computed Avaira Score.
    bytes32 public constant SCORER_ROLE = keccak256("AVAIRA_SCORER_ROLE");

    /* -------------------------------- constants ------------------------------- */

    /// @notice ERC-8004 standard feedback tags. Values are only comparable within a tag.
    bytes32 private constant TAG_STARRED = keccak256("starred");
    bytes32 private constant TAG_REACHABLE = keccak256("reachable");
    bytes32 private constant TAG_OWNER_VERIFIED = keccak256("ownerVerified");
    bytes32 private constant TAG_UPTIME = keccak256("uptime");
    bytes32 private constant TAG_SUCCESS_RATE = keccak256("successRate");
    bytes32 private constant TAG_RESPONSE_TIME = keccak256("responseTime");
    bytes32 private constant TAG_BLOCKTIME_FRESHNESS = keccak256("blocktimeFreshness");
    bytes32 private constant TAG_REVENUES = keccak256("revenues");

    /* ---------------------------------- types --------------------------------- */

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        uint64 createdAt;
        bool revoked;
        uint8 grounding; // 0 = staked reviewer, 1 = settled payment
        uint256 paymentValue;
    }

    struct Response {
        address responder;
        string responseURI;
        bytes32 responseHash;
        uint64 createdAt;
    }

    /// @notice Feedback payload, grouped to keep the compiler off the stack limit.
    struct FeedbackInput {
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    /// @notice x402-style settlement proof accompanying grounded feedback.
    /// @dev `token` must be the configured settlement token; `payer` must be the reviewer;
    ///      `payee` must be the agent's wallet or owner. Settlement happens atomically.
    struct PaymentProof {
        address token;
        address payer;
        address payee;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    /* ---------------------------------- state --------------------------------- */

    IERC721 public immutable identityRegistry;
    IAvairaStakeRegistry public stakeRegistry;

    /// @notice USDC (native on Monad) used for settlement-grounded feedback.
    IERC20 public settlementToken;

    /// @notice Minimum settled payment that qualifies as grounding.
    uint256 public minGroundedPayment;

    /// @notice Address authorised to rescue mis-sent tokens.
    address public treasury;

    mapping(uint256 agentId => mapping(address reviewer => Feedback[])) private _feedback;
    mapping(uint256 agentId => mapping(address reviewer => Response[])) private _responses;
    mapping(uint256 agentId => uint8) private _score;
    mapping(uint256 agentId => uint64) private _scoreUpdatedAt;
    mapping(uint256 agentId => bytes32) public scoreBreakdownHash;
    mapping(uint256 agentId => string) public scoreEvidenceURI;

    /* ---------------------------------- events -------------------------------- */

    /// @notice Emitted when the offchain scorer publishes a new Avaira Score.
    event ScorePosted(uint256 indexed agentId, uint8 score, string grade, uint64 updatedAt, bytes32 breakdownHash);
    event ScorerConfigUpdated(address indexed stakeRegistry, address indexed settlementToken, uint256 minGroundedPayment);
    event TreasuryUpdated(address previousTreasury, address newTreasury);

    /* ------------------------------- constructor ------------------------------ */

    constructor(address identityRegistry_, address stakeRegistry_, address settlementToken_, address admin)
        AccessControl()
    {
        identityRegistry = IERC721(identityRegistry_);
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
        settlementToken = IERC20(settlementToken_);
        treasury = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCORER_ROLE, admin);
        emit ScorerConfigUpdated(stakeRegistry_, settlementToken_, 0);
    }

    /* -------------------------------- feedback -------------------------------- */

    /// @inheritdoc IERC8004ReputationRegistry
    /// @dev Grounding path A: the reviewer must have stake locked in `AvairaStakeRegistry`.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external override {
        FeedbackInput memory input = FeedbackInput({
            agentId: agentId,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash
        });
        _requireGroundingPreconditions(input);
        if (!stakeRegistry.isStakedReviewer(msg.sender)) revert NotAGroundedReviewer(msg.sender);

        uint64 index = _writeFeedback(input, msg.sender, 0, 0);
        _emitFeedback(input, msg.sender, index);
    }

    /// @notice Grounding path B: settle a real x402-style payment to the agent, then record feedback.
    /// @dev The EIP-3009 authorisation is settled in this transaction, so the payment and the
    ///      feedback are atomic — the agent cannot be reviewed by someone who never paid it.
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
    ) external nonReentrant {
        FeedbackInput memory input = FeedbackInput({
            agentId: agentId,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash
        });
        _requireGroundingPreconditions(input);

        if (proof.payer != msg.sender) revert NotAGroundedReviewer(msg.sender);
        address token = proof.token == address(0) ? address(settlementToken) : proof.token;
        if (token != address(settlementToken)) revert UnsupportedSettlementToken(token);
        if (proof.value < minGroundedPayment) revert PaymentTooSmall(minGroundedPayment, proof.value);

        address expectedPayee = _agentPayee(input.agentId);
        if (proof.payee != expectedPayee) revert PaymentPayeeMismatch(expectedPayee, proof.payee);

        IEIP3009(address(settlementToken)).transferWithAuthorization(
            proof.payer, proof.payee, proof.value, proof.validAfter, proof.validBefore, proof.nonce, proof.signature
        );

        uint64 index = _writeFeedback(input, msg.sender, 1, proof.value);
        _emitFeedback(input, msg.sender, index);
    }

    /// @inheritdoc IERC8004ReputationRegistry
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external override {
        Feedback[] storage records = _feedback[agentId][msg.sender];
        if (feedbackIndex >= records.length) revert UnknownFeedback(agentId, msg.sender, feedbackIndex);
        Feedback storage record = records[feedbackIndex];
        if (record.revoked) revert AlreadyRevoked();
        record.revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @inheritdoc IERC8004ReputationRegistry
    /// @dev Only the agent's owner or an approved operator may respond.
    function appendResponse(
        uint256 agentId,
        address reviewer,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external override {
        if (!_isAgentOperator(agentId, msg.sender)) revert NotAgentOperator(msg.sender, agentId);
        if (feedbackIndex >= _feedback[agentId][reviewer].length) {
            revert UnknownFeedback(agentId, reviewer, feedbackIndex);
        }
        _responses[agentId][reviewer].push(
            Response({responder: msg.sender, responseURI: responseURI, responseHash: responseHash, createdAt: uint64(block.timestamp)})
        );
        emit ResponseAppended(agentId, reviewer, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @inheritdoc IERC8004ReputationRegistry
    function readFeedback(uint256 agentId, address reviewer, uint64 feedbackIndex)
        external
        view
        override
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool revoked)
    {
        Feedback[] storage records = _feedback[agentId][reviewer];
        if (feedbackIndex >= records.length) return (0, 0, "", "", false);
        Feedback storage record = records[feedbackIndex];
        return (record.value, record.valueDecimals, record.tag1, record.tag2, record.revoked);
    }

    /// @notice Full feedback record including grounding metadata.
    function readFeedbackFull(uint256 agentId, address reviewer, uint64 feedbackIndex)
        external
        view
        returns (Feedback memory)
    {
        Feedback[] storage records = _feedback[agentId][reviewer];
        if (feedbackIndex >= records.length) return Feedback(0, 0, "", "", "", "", bytes32(0), 0, false, 0, 0);
        return records[feedbackIndex];
    }

    /// @notice Number of feedback records written by `reviewer` for `agentId`.
    function feedbackCount(uint256 agentId, address reviewer) external view returns (uint256) {
        return _feedback[agentId][reviewer].length;
    }

    /// @notice Responses appended to `reviewer`'s feedback on `agentId`.
    function readResponses(uint256 agentId, address reviewer) external view returns (Response[] memory) {
        return _responses[agentId][reviewer];
    }

    /// @inheritdoc IERC8004ReputationRegistry
    /// @dev Averages only non-revoked records with a matching `tag` across the *caller-supplied*
    ///      reviewer set. That set is the anti-Sybil control: clients choose whose word counts.
    function getSummary(uint256 agentId, address[] calldata reviewers, string calldata tag)
        external
        view
        override
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        if (reviewers.length == 0) revert NoReviewersSupplied();
        bytes32 tagHash = keccak256(bytes(tag));
        uint8 maxDecimals;
        int256 total;

        for (uint256 r; r < reviewers.length; ++r) {
            Feedback[] storage records = _feedback[agentId][reviewers[r]];
            for (uint256 i; i < records.length; ++i) {
                Feedback storage record = records[i];
                if (record.revoked) continue;
                if (bytes(tag).length > 0 && keccak256(bytes(record.tag1)) != tagHash) continue;
                if (record.valueDecimals > maxDecimals) maxDecimals = record.valueDecimals;
                total += record.value;
                count++;
            }
        }

        if (count == 0) return (0, 0, 0);
        // Scale every value to the largest decimal count seen before averaging.
        int256 scaled;
        for (uint256 r; r < reviewers.length; ++r) {
            Feedback[] storage records = _feedback[agentId][reviewers[r]];
            for (uint256 i; i < records.length; ++i) {
                Feedback storage record = records[i];
                if (record.revoked) continue;
                if (bytes(tag).length > 0 && keccak256(bytes(record.tag1)) != tagHash) continue;
                scaled += int256(record.value) * int256(10 ** (maxDecimals - record.valueDecimals));
            }
        }
        summaryValue = int128(scaled / int256(uint256(count)));
        summaryValueDecimals = maxDecimals;
    }

    /// @inheritdoc IAvairaScoreReader
    function scoreOf(uint256 agentId) external view returns (uint8) {
        return _score[agentId];
    }

    /// @inheritdoc IAvairaScoreReader
    function scoreUpdatedAt(uint256 agentId) external view returns (uint64) {
        return _scoreUpdatedAt[agentId];
    }

    /// @notice Letter grade for `agentId`: A+ 90–100, A 85–89, B+ 80–84, B 70–79, C 60–69, D <60.
    function gradeOf(uint256 agentId) public view returns (string memory) {
        return gradeOfScore(_score[agentId]);
    }

    /// @notice Pure grade mapping so consumers can grade any score value.
    /// @notice Bands preserved from the offchain Avaira OS scorer (`backend/core/reputation.py`):
    ///         A+ ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60, D below. `C` is the gate's eligibility floor,
    ///         so "grade C or better" is exactly "the pre-execution gate will let you act".
    function gradeOfScore(uint8 score) public pure returns (string memory) {
        if (score >= 90) return "A+";
        if (score >= 80) return "A";
        if (score >= 70) return "B";
        if (score >= 60) return "C";
        return "D";
    }

    /// @notice True when `tag1` is an ERC-8004 standard tag.
    function isStandardTag(string calldata tag1) external pure returns (bool) {
        return _isStandardTag(keccak256(bytes(tag1)));
    }

    /* --------------------------------- scoring -------------------------------- */

    /// @notice Publishes the offchain-computed Avaira Score (0–100) for `agentId`.
    /// @dev Only the AvairaScorer service may publish scores. Stake buys entry, never score:
    ///      the value is computed offchain from settlement/validation data and anchored here.
    function postAvairaScore(uint256 agentId, uint8 score) external onlyRole(SCORER_ROLE) {
        _postScore(agentId, score, bytes32(0), "");
    }

    /// @notice Score + evidence anchor: `breakdownHash` commits to the scorer's input data.
    function postAvairaScore(uint256 agentId, uint8 score, bytes32 breakdownHash, string calldata evidenceURI)
        external
        onlyRole(SCORER_ROLE)
    {
        _postScore(agentId, score, breakdownHash, evidenceURI);
    }

    function _postScore(uint256 agentId, uint8 score, bytes32 breakdownHash, string memory evidenceURI) private {
        if (score > 100) revert InvalidScore(score);
        if (!_agentExists(agentId)) revert NotRegisteredAgent(agentId);

        _score[agentId] = score;
        _scoreUpdatedAt[agentId] = uint64(block.timestamp);
        if (breakdownHash != bytes32(0)) scoreBreakdownHash[agentId] = breakdownHash;
        if (bytes(evidenceURI).length > 0) scoreEvidenceURI[agentId] = evidenceURI;

        emit ScorePosted(agentId, score, gradeOfScore(score), uint64(block.timestamp), breakdownHash);
    }

    /* --------------------------------- admin ---------------------------------- */

    function setScorerConfig(address stakeRegistry_, address settlementToken_, uint256 minGroundedPayment_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        stakeRegistry = IAvairaStakeRegistry(stakeRegistry_);
        settlementToken = IERC20(settlementToken_);
        minGroundedPayment = minGroundedPayment_;
        emit ScorerConfigUpdated(stakeRegistry_, settlementToken_, minGroundedPayment_);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "treasury=0");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Recovers tokens accidentally sent to this contract.
    function rescue(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).transfer(treasury, amount);
    }

    /* -------------------------------- internals ------------------------------- */

    function _requireGroundingPreconditions(FeedbackInput memory input) private view {
        if (!_isStandardTag(keccak256(bytes(input.tag1)))) revert UnsupportedTag(input.tag1);
        if (input.valueDecimals > 18) revert ValueDecimalsTooLarge(input.valueDecimals);
        if (!_agentExists(input.agentId)) revert NotRegisteredAgent(input.agentId);
        if (_isAgentOperator(input.agentId, msg.sender)) revert ReviewerIsAgentOperator(msg.sender, input.agentId);
    }

    function _writeFeedback(FeedbackInput memory input, address reviewer, uint8 grounding, uint256 paymentValue)
        private
        returns (uint64 index)
    {
        Feedback[] storage records = _feedback[input.agentId][reviewer];
        index = uint64(records.length);
        Feedback storage record = records.push();
        record.value = input.value;
        record.valueDecimals = input.valueDecimals;
        record.tag1 = input.tag1;
        record.tag2 = input.tag2;
        record.endpoint = input.endpoint;
        record.feedbackURI = input.feedbackURI;
        record.feedbackHash = input.feedbackHash;
        record.createdAt = uint64(block.timestamp);
        record.grounding = grounding;
        record.paymentValue = paymentValue;
    }

    function _emitFeedback(FeedbackInput memory input, address reviewer, uint64 index) private {
        emit NewFeedback(
            input.agentId,
            reviewer,
            index,
            input.value,
            input.valueDecimals,
            input.tag1,
            input.tag1,
            input.tag2,
            input.endpoint,
            input.feedbackURI,
            input.feedbackHash
        );
    }

    /// @dev The payee that grounds a payment review: the agent's bound wallet if set, else its owner.
    function _agentPayee(uint256 agentId) private view returns (address payee) {
        payee = _agentWallet(agentId);
        if (payee == address(0)) {
            if (!_agentExists(agentId)) revert NotRegisteredAgent(agentId);
            payee = identityRegistry.ownerOf(agentId);
        }
    }

    function _agentExists(uint256 agentId) private view returns (bool exists) {
        try identityRegistry.ownerOf(agentId) returns (address holder) {
            exists = holder != address(0);
        } catch {
            exists = false;
        }
    }

    function _agentWallet(uint256 agentId) private view returns (address wallet) {
        // `getAgentWallet` is optional on the identity registry; degrade gracefully.
        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("getAgentWallet(uint256)", agentId));
        if (ok && data.length >= 32) wallet = abi.decode(data, (address));
    }

    function _isAgentOperator(uint256 agentId, address account) private view returns (bool) {
        if (!_agentExists(agentId)) return false;
        address owner = identityRegistry.ownerOf(agentId);
        if (account == owner) return true;
        if (identityRegistry.getApproved(agentId) == account) return true;
        if (identityRegistry.isApprovedForAll(owner, account)) return true;
        return account == _agentWallet(agentId);
    }

    function _isStandardTag(bytes32 tagHash) private pure returns (bool) {
        return tagHash == TAG_STARRED || tagHash == TAG_REACHABLE || tagHash == TAG_OWNER_VERIFIED
            || tagHash == TAG_UPTIME || tagHash == TAG_SUCCESS_RATE || tagHash == TAG_RESPONSE_TIME
            || tagHash == TAG_BLOCKTIME_FRESHNESS || tagHash == TAG_REVENUES;
    }
}
