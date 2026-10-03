// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Component 2 of 6: AvairaReputationRegistry
        ------------------------------------------
        ERC-8004 Reputation Registry — GROUNDED.

        The June 2026 Imperial College study (arXiv:2606.26028) crawled every live
        ERC-8004 deployment and concluded the reputation layer "cannot function as a
        trust signal": 59.2–90.6% of reviewers show coordinated Sybil behaviour, only
        ~1% of feedback records carry any interaction evidence, values are not
        commensurable, and fabricating a rating costs cents.

        This contract fixes all four failure modes at the protocol level:

          C1 COMMENSURABILITY — feedback tags are a fixed, governed set, and each tag
             has an enforced decimal scale and value range. A "5" in `starred` means
             5.00 stars in every client, on every chain, forever.

          C2 GROUNDING — `giveFeedback` is callable only by a staked reviewer, or must
             cite a verified payment. Unstaked, unpriced feedback cannot be written at
             all, so the median cost of a fake rating is no longer $0.01.

          C3 COSTLY MANIPULATION — reviewers need a live, slashable stake; feedback
             records are rate-limited per (agent, reviewer); self-review by the owner,
             an approved operator or the agent wallet is rejected.

          C4 DERIVED SCORE — the headline number is the Avaira Score, computed offchain
             by the scorer service from settlement and validation data and posted by a
             dedicated role. Raw feedback never moves the score, and a BANNED agent can
             never be re-scored.

        Event compatibility: both the canonical ERC-8004 `NewFeedback` event and
        Avaira's richer `FeedbackGiven` (with grounding provenance) are emitted.
//////////////////////////////////////////////////////////////////////////////*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAvairaReputationRegistry} from "./interfaces/IAvairaReputationRegistry.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";
import {IAvairaStakeRegistry} from "./interfaces/IAvairaStakeRegistry.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {PaymentProof, AgentStatus} from "./interfaces/IAvairaTypes.sol";
import {ScoreLib} from "./libraries/ScoreLib.sol";

contract AvairaReputationRegistry is IAvairaReputationRegistry, Ownable {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Constants — the commensurable tag set (the study's C1 recommendation)
    // -------------------------------------------------------------------------

    bytes32 public constant TAG_STARRED = keccak256("starred");
    bytes32 public constant TAG_REACHABLE = keccak256("reachable");
    bytes32 public constant TAG_OWNER_VERIFIED = keccak256("ownerVerified");
    bytes32 public constant TAG_UPTIME = keccak256("uptime");
    bytes32 public constant TAG_SUCCESS_RATE = keccak256("successRate");
    bytes32 public constant TAG_RESPONSE_TIME = keccak256("responseTime");
    bytes32 public constant TAG_BLOCKTIME_FRESHNESS = keccak256("blocktimeFreshness");
    bytes32 public constant TAG_REVENUES = keccak256("revenues");

    uint256 public constant MAX_REVIEWERS_PER_SUMMARY = 100;

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    struct TagSpec {
        bool enabled;
        uint8 decimals;
        int128 minValue;
        int128 maxValue;
    }

    struct Response {
        address responder;
        uint64 timestamp;
        string responseURI;
        bytes32 responseHash;
    }

    /// @dev Feedback payload moved off the stack: the ERC-8004 signature is kept on the
    ///      external functions, internals pass one struct.
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

    struct PaymentAttestation {
        uint256 agentId;
        address payer;
        address token;
        uint256 amount;
        uint64 paidAt;
        bool recorded;
    }

    IERC20 public immutable usdc;
    IAvairaIdentityRegistry public identity;
    IAvairaStakeRegistry public stakeRegistry;

    /// @notice Offchain scorer service authorised to post the Avaira Score.
    address public scorer;

    /// @notice Minimum verified payment (in USDC base units) that grounds feedback.
    uint256 public minPaymentForGrounding = 1e6; // 1.00 USDC

    /// @notice Minimum spacing between two feedback posts by the same reviewer on the
    ///         same agent (Sybil rate limit).
    uint64 public feedbackCooldown = 1 hours;

    /// @notice Maximum age of a cited payment attestation.
    uint64 public paymentProofMaxAge = 30 days;

    mapping(bytes32 tagKey => TagSpec) private _tags;
    mapping(uint256 agentId => mapping(address reviewer => FeedbackRecord[])) private _feedback;
    mapping(uint256 agentId => mapping(address reviewer => mapping(uint64 index => Response[]))) private _responses;
    mapping(bytes32 paymentRef => PaymentAttestation) private _payments;
    mapping(address prover => bool) public paymentProvers;
    mapping(uint256 agentId => mapping(address reviewer => uint64 timestamp)) public lastFeedbackAt;

    mapping(uint256 agentId => uint8) private _score;
    mapping(uint256 agentId => uint64) private _scorePostedAt;
    mapping(uint256 agentId => bytes32) private _breakdown;
    mapping(uint256 agentId => bool) private _hasScore;
    mapping(uint256 agentId => bool) private _banned;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error UnknownAgent(uint256 agentId);
    error SelfReview(uint256 agentId, address reviewer);
    error UngroundedFeedback(address reviewer, string reason);
    error TagNotAllowed(string tag1);
    error ValueOutOfRange(string tag1, int128 value, int128 minValue, int128 maxValue);
    error WrongDecimals(string tag1, uint8 provided, uint8 expected);
    error FeedbackCooldownActive(uint256 agentId, address reviewer, uint64 readyAt);
    error IndexOutOfRange(uint256 agentId, address reviewer, uint64 index);
    error NotFeedbackAuthor(uint256 agentId, address reviewer, address caller);
    error PaymentAlreadyUsed(bytes32 paymentRef);
    error PaymentNotAttested(bytes32 paymentRef);
    error PaymentTooSmall(uint256 amount, uint256 minimum);
    error PaymentTooOld(uint64 paidAt, uint256 maxAge);
    error PaymentAgentMismatch(bytes32 paymentRef, uint256 expected, uint256 actual);
    error NotScorer(address caller);
    error NotStakeRegistry(address caller);
    error ScoreOutOfRange(uint8 score);
    error AgentIsBanned(uint256 agentId);
    error ReviewerListTooLong(uint256 length);
    error EmptyReviewerList();
    error ZeroAddress();
    error InvalidSignatureLength(uint256 length);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address usdc_, address identity_) Ownable(initialOwner) {
        if (usdc_ == address(0) || identity_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        identity = IAvairaIdentityRegistry(identity_);
        _configureSpecTags();
    }

    /// @dev The eight ERC-8004 spec tags, with the decimals and ranges Avaira enforces.
    function _configureSpecTags() private {
        _tags[TAG_STARRED] = TagSpec(true, 2, 0, 500); // 0.00 – 5.00 stars
        _tags[TAG_REACHABLE] = TagSpec(true, 0, 0, 1); // bool
        _tags[TAG_OWNER_VERIFIED] = TagSpec(true, 0, 0, 1); // bool
        _tags[TAG_UPTIME] = TagSpec(true, 2, 0, 10_000); // 0.00 – 100.00 %
        _tags[TAG_SUCCESS_RATE] = TagSpec(true, 2, 0, 10_000); // 0.00 – 100.00 %
        _tags[TAG_RESPONSE_TIME] = TagSpec(true, 0, 0, 3_600_000); // ms, ≤ 1h
        _tags[TAG_BLOCKTIME_FRESHNESS] = TagSpec(true, 2, 0, 10_000); // 0.00 – 100.00 %
        _tags[TAG_REVENUES] = TagSpec(true, 6, 0, type(int128).max); // USDC, 6 decimals
    }

    // -------------------------------------------------------------------------
    // Feedback — the grounded write path
    // -------------------------------------------------------------------------

    /// @dev Grounding rule (a): the reviewer must be a staked, ACTIVE agent owner.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        // Self-review is checked first: "you cannot rate yourself" is a sharper refusal
        // than "you are not grounded", and the spec forbids it outright.
        _requireNotSelfReview(agentId);
        if (!stakeRegistry.isStakedReviewer(msg.sender)) {
            revert UngroundedFeedback(
                msg.sender, "reviewer is not a staked agent owner and no payment proof was supplied"
            );
        }
        _giveFeedback(
            FeedbackInput(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash), true, false
        );
    }

    /// @dev Grounding rule (b): the reviewer either has stake, or cites a payment that a
    ///      trusted prover already verified against the settlement layer (the x402 path,
    ///      where a Chainlink Function or re-executing indexer attests the transfer).
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
    ) external {
        _requireNotSelfReview(agentId);
        bool staked = stakeRegistry.isStakedReviewer(msg.sender);
        bool paid = _consumePayment(proof.paymentRef, agentId, msg.sender);
        if (!staked && !paid) {
            revert UngroundedFeedback(msg.sender, "stake below reviewer minimum and no valid payment proof");
        }
        _giveFeedback(
            FeedbackInput(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash), staked, paid
        );
    }

    /// @notice Feedback grounded by an *atomic* x402 settlement: the reviewer signs a
    ///         EIP-3009 authorization paying the agent, the registry executes it and
    ///         verifies the resulting balance delta before recording the feedback.
    ///         No external prover is required on this path.
    function giveFeedbackWithX402Settlement(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        uint256 paymentAmount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 paymentNonce,
        bytes calldata signature
    ) external {
        _requireNotSelfReview(agentId);
        // Payment is the grounding here: an unstaked client that actually paid the agent
        // has skin in the game, which is exactly the condition the empirical study found
        // missing from 99% of ERC-8004 feedback records.
        if (paymentAmount < minPaymentForGrounding) revert PaymentTooSmall(paymentAmount, minPaymentForGrounding);
        address payTo = _payoutAddress(agentId);

        uint256 before = usdc.balanceOf(payTo);
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        IERC3009(address(usdc)).transferWithAuthorization(
            msg.sender, payTo, paymentAmount, validAfter, validBefore, paymentNonce, v, r, s
        );
        uint256 delta = usdc.balanceOf(payTo) - before;
        if (delta < paymentAmount) revert PaymentTooSmall(delta, paymentAmount);

        bytes32 paymentRef = keccak256(abi.encode(msg.sender, payTo, paymentAmount, paymentNonce));
        _payments[paymentRef] = PaymentAttestation({
            agentId: agentId,
            payer: msg.sender,
            token: address(usdc),
            amount: delta,
            paidAt: uint64(block.timestamp),
            recorded: true
        });
        emit PaymentAttested(paymentRef, agentId, msg.sender, delta);

        _giveFeedback(
            FeedbackInput(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash), true, true
        );
    }

    function _giveFeedback(FeedbackInput memory input, bool groundedByStake, bool groundedByPayment) private {
        uint256 agentId = input.agentId;
        if (_banned[agentId]) revert AgentIsBanned(agentId);
        if (!identity.isRegistered(agentId)) revert UnknownAgent(agentId);

        TagSpec memory spec = _tags[keccak256(bytes(input.tag1))];
        if (!spec.enabled) revert TagNotAllowed(input.tag1);
        if (input.value < spec.minValue || input.value > spec.maxValue) {
            revert ValueOutOfRange(input.tag1, input.value, spec.minValue, spec.maxValue);
        }
        if (input.valueDecimals != spec.decimals) {
            revert WrongDecimals(input.tag1, input.valueDecimals, spec.decimals);
        }

        uint64 readyAt = lastFeedbackAt[agentId][msg.sender] + feedbackCooldown;
        if (lastFeedbackAt[agentId][msg.sender] != 0 && block.timestamp < readyAt) {
            revert FeedbackCooldownActive(agentId, msg.sender, readyAt);
        }
        lastFeedbackAt[agentId][msg.sender] = uint64(block.timestamp);

        FeedbackRecord[] storage list = _feedback[agentId][msg.sender];
        uint64 index = uint64(list.length);
        list.push(
            FeedbackRecord({
                value: input.value,
                valueDecimals: input.valueDecimals,
                timestamp: uint64(block.timestamp),
                revoked: false,
                groundedByStake: groundedByStake,
                groundedByPayment: groundedByPayment,
                feedbackHash: input.feedbackHash,
                tag1: input.tag1,
                tag2: input.tag2,
                endpoint: input.endpoint,
                feedbackURI: input.feedbackURI
            })
        );

        // Canonical ERC-8004 event, so existing 8004 indexers see Avaira feedback.
        emit NewFeedback(
            agentId,
            msg.sender,
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
        emit FeedbackGiven(
            agentId,
            msg.sender,
            index,
            input.value,
            input.valueDecimals,
            input.tag1,
            input.tag2,
            groundedByStake,
            groundedByPayment,
            input.feedbackHash
        );
    }

    /// @inheritdoc IAvairaReputationRegistry
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        FeedbackRecord[] storage list = _feedback[agentId][msg.sender];
        if (feedbackIndex >= list.length) revert IndexOutOfRange(agentId, msg.sender, feedbackIndex);
        list[feedbackIndex].revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @dev Anyone may append a response (typically the reviewed agent answering a
    ///      rating); responses are hash-anchored, never free text onchain.
    function appendResponse(
        uint256 agentId,
        address reviewer,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        if (feedbackIndex >= _feedback[agentId][reviewer].length) {
            revert IndexOutOfRange(agentId, reviewer, feedbackIndex);
        }
        _responses[agentId][reviewer][feedbackIndex].push(
            Response({
                responder: msg.sender,
                timestamp: uint64(block.timestamp),
                responseURI: responseURI,
                responseHash: responseHash
            })
        );
        emit ResponseAppended(agentId, reviewer, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    /// @inheritdoc IAvairaReputationRegistry
    function readFeedback(uint256 agentId, address reviewer, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool revoked)
    {
        FeedbackRecord storage record = _feedback[agentId][reviewer][feedbackIndex];
        return (record.value, record.valueDecimals, record.tag1, record.tag2, record.revoked);
    }

    /// @dev Caller-supplied reviewer set (the study's recommendation: callers must be
    ///      able to exclude Sybil clusters) — and every record here is already grounded
    ///      and commensurable, so a plain mean is meaningful.
    function getSummary(uint256 agentId, address[] calldata reviewers, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        if (reviewers.length == 0) revert EmptyReviewerList();
        if (reviewers.length > MAX_REVIEWERS_PER_SUMMARY) revert ReviewerListTooLong(reviewers.length);

        bytes32 wantTag1 = keccak256(bytes(tag1));
        bytes32 wantTag2 = keccak256(bytes(tag2));
        bool anyTag2 = bytes(tag2).length == 0;

        int256 total = 0;
        uint8 decimals = 0;
        for (uint256 i = 0; i < reviewers.length; ++i) {
            FeedbackRecord[] storage list = _feedback[agentId][reviewers[i]];
            for (uint256 j = 0; j < list.length; ++j) {
                FeedbackRecord storage record = list[j];
                if (record.revoked) continue;
                if (keccak256(bytes(record.tag1)) != wantTag1) continue;
                if (!anyTag2 && keccak256(bytes(record.tag2)) != wantTag2) continue;
                total += record.value;
                decimals = record.valueDecimals;
                count += 1;
            }
        }
        if (count == 0) return (0, 0, 0);
        summaryValue = int128(total / int256(uint256(count)));
        summaryValueDecimals = decimals;
    }

    /// @notice Feedback record with provenance (grounding flags, endpoint, URI).
    function readFeedbackFull(uint256 agentId, address reviewer, uint64 feedbackIndex)
        external
        view
        returns (FeedbackRecord memory)
    {
        FeedbackRecord storage record = _feedback[agentId][reviewer][feedbackIndex];
        return record;
    }

    /// @inheritdoc IAvairaReputationRegistry
    function feedbackCount(uint256 agentId, address reviewer) external view returns (uint64) {
        return uint64(_feedback[agentId][reviewer].length);
    }

    function responseCount(uint256 agentId, address reviewer, uint64 feedbackIndex) external view returns (uint256) {
        return _responses[agentId][reviewer][feedbackIndex].length;
    }

    // -------------------------------------------------------------------------
    // Payment attestations (the x402 grounding path)
    // -------------------------------------------------------------------------

    /// @notice Record a verified offchain payment (x402 settlement, USDC transfer) so it
    ///         can ground feedback. Restricted to provers: the Chainlink Functions
    ///         consumer, the re-executing indexer, or the Avaira service.
    function attestPayment(
        bytes32 paymentRef,
        uint256 agentId,
        address payer,
        address token,
        uint256 amount,
        uint64 paidAt
    ) external {
        if (!paymentProvers[msg.sender] && msg.sender != owner()) {
            revert UngroundedFeedback(msg.sender, "not a payment prover");
        }
        if (_payments[paymentRef].recorded) revert PaymentAlreadyUsed(paymentRef);
        if (amount < minPaymentForGrounding) revert PaymentTooSmall(amount, minPaymentForGrounding);

        _payments[paymentRef] = PaymentAttestation({
            agentId: agentId,
            payer: payer,
            token: token,
            amount: amount,
            paidAt: paidAt,
            recorded: true
        });
        emit PaymentAttested(paymentRef, agentId, payer, amount);
    }

    function paymentOf(bytes32 paymentRef) external view returns (PaymentAttestation memory) {
        return _payments[paymentRef];
    }

    function setPaymentProver(address prover, bool allowed) external onlyOwner {
        paymentProvers[prover] = allowed;
    }

    /// @dev Validates and burns a payment attestation so it grounds exactly one record.
    function _consumePayment(bytes32 paymentRef, uint256 agentId, address reviewer) private returns (bool) {
        PaymentAttestation storage attestation = _payments[paymentRef];
        if (!attestation.recorded) revert PaymentNotAttested(paymentRef);
        if (attestation.agentId != agentId) {
            revert PaymentAgentMismatch(paymentRef, agentId, attestation.agentId);
        }
        if (block.timestamp > attestation.paidAt + paymentProofMaxAge) {
            revert PaymentTooOld(attestation.paidAt, paymentProofMaxAge);
        }
        if (attestation.payer != reviewer) {
            revert UngroundedFeedback(reviewer, "payment was made by a different account");
        }
        attestation.recorded = false; // single use
        return true;
    }

    // -------------------------------------------------------------------------
    // Avaira Score — posted by the scorer role, never by feedback
    // -------------------------------------------------------------------------

    /// @notice Stake buys entry; it never buys score. Only the scorer service — which
    ///         recomputes the weighted score from settlement and validation data — can
    ///         move this number.
    function postAvairaScore(uint256 agentId, uint8 score, bytes32 breakdownHash) external {
        if (msg.sender != scorer && msg.sender != owner()) revert NotScorer(msg.sender);
        _postScore(agentId, score, breakdownHash);
    }

    function postAvairaScoreBatch(uint256[] calldata agentIds, uint8[] calldata scores, bytes32[] calldata breakdowns)
        external
    {
        if (msg.sender != scorer && msg.sender != owner()) revert NotScorer(msg.sender);
        require(agentIds.length == scores.length && scores.length == breakdowns.length, "length mismatch");
        for (uint256 i = 0; i < agentIds.length; ++i) {
            _postScore(agentIds[i], scores[i], breakdowns[i]);
        }
    }

    function _postScore(uint256 agentId, uint8 score, bytes32 breakdownHash) private {
        if (score > 100) revert ScoreOutOfRange(score);
        if (_banned[agentId]) revert AgentIsBanned(agentId);

        _score[agentId] = score;
        _scorePostedAt[agentId] = uint64(block.timestamp);
        _breakdown[agentId] = breakdownHash;
        _hasScore[agentId] = true;

        emit ScorePosted(agentId, score, ScoreLib.grade(score), breakdownHash, msg.sender);
    }

    /// @notice Called by the stake registry on BAN: the score is zeroed and frozen.
    function markBanned(uint256 agentId) external {
        if (msg.sender != address(stakeRegistry) && msg.sender != owner()) revert NotStakeRegistry(msg.sender);
        uint8 previous = _score[agentId];
        _banned[agentId] = true;
        _score[agentId] = 0;
        _hasScore[agentId] = true;
        _scorePostedAt[agentId] = uint64(block.timestamp);
        _breakdown[agentId] = bytes32(0);
        emit AgentBannedOnchain(agentId, previous);
        emit ScorePosted(agentId, 0, "D", bytes32(0), msg.sender);
    }

    /// @inheritdoc IAvairaReputationRegistry
    function scoreOf(uint256 agentId) external view returns (uint8) {
        return _score[agentId];
    }

    /// @inheritdoc IAvairaReputationRegistry
    function hasScore(uint256 agentId) external view returns (bool) {
        return _hasScore[agentId];
    }

    /// @inheritdoc IAvairaReputationRegistry
    function scorePostedAt(uint256 agentId) external view returns (uint64) {
        return _scorePostedAt[agentId];
    }

    /// @inheritdoc IAvairaReputationRegistry
    function gradeOf(uint256 agentId) external view returns (string memory) {
        return ScoreLib.grade(_score[agentId]);
    }

    /// @inheritdoc IAvairaReputationRegistry
    function scoreBreakdownOf(uint256 agentId) external view returns (bytes32) {
        return _breakdown[agentId];
    }

    /// @notice True when the posted score is older than {ScoreLib.SCORE_FRESHNESS}.
    function isScoreStale(uint256 agentId) external view returns (bool) {
        if (!_hasScore[agentId]) return true;
        return block.timestamp > _scorePostedAt[agentId] + ScoreLib.SCORE_FRESHNESS;
    }

    /// @notice The six score weights (bps), published onchain so the formula is auditable.
    function scoreWeights() external pure returns (uint16[6] memory) {
        return ScoreLib.weights();
    }

    function isBanned(uint256 agentId) external view returns (bool) {
        return _banned[agentId];
    }

    // -------------------------------------------------------------------------
    // Tag governance
    // -------------------------------------------------------------------------

    function configureTag(string calldata tag1, uint8 decimals, int128 minValue, int128 maxValue, bool enabled)
        external
        onlyOwner
    {
        require(minValue <= maxValue, "invalid range");
        if (enabled && bytes(tag1).length == 0) revert TagNotAllowed(tag1);
        _tags[keccak256(bytes(tag1))] = TagSpec(enabled, decimals, minValue, maxValue);
        emit TagConfigured(tag1, decimals, minValue, maxValue, enabled);
    }

    function tagSpec(string calldata tag1)
        external
        view
        returns (bool enabled, uint8 decimals, int128 minValue, int128 maxValue)
    {
        TagSpec memory spec = _tags[keccak256(bytes(tag1))];
        return (spec.enabled, spec.decimals, spec.minValue, spec.maxValue);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setScorer(address newScorer) external onlyOwner {
        if (newScorer == address(0)) revert ZeroAddress();
        emit ScorerUpdated(scorer, newScorer);
        scorer = newScorer;
    }

    function setStakeRegistry(address registry) external onlyOwner {
        stakeRegistry = IAvairaStakeRegistry(registry);
    }

    function setIdentityRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ZeroAddress();
        identity = IAvairaIdentityRegistry(registry);
    }

    function setMinPaymentForGrounding(uint256 value) external onlyOwner {
        minPaymentForGrounding = value;
    }

    function setFeedbackCooldown(uint64 value) external onlyOwner {
        feedbackCooldown = value;
    }

    function setPaymentProofMaxAge(uint64 value) external onlyOwner {
        paymentProofMaxAge = value;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev ERC-8004: an agent's owner, its operator or its bound wallet cannot review it.
    function _requireNotSelfReview(uint256 agentId) private view {
        address owner_ = identity.ownerOf(agentId);
        if (
            msg.sender == owner_ || msg.sender == identity.getAgentWallet(agentId)
                || identity.isApprovedForAll(owner_, msg.sender) || msg.sender == identity.getApproved(agentId)
        ) {
            revert SelfReview(agentId, msg.sender);
        }
    }

    function _payoutAddress(uint256 agentId) private view returns (address) {
        address wallet = identity.getAgentWallet(agentId);
        if (wallet != address(0)) return wallet;
        return identity.ownerOf(agentId);
    }

    function _splitSignature(bytes calldata signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length != 65) revert InvalidSignatureLength(signature.length);
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
    }
}
