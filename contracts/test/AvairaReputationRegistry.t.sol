// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvairaFixture} from "./utils/AvairaFixture.sol";
import {AvairaReputationRegistry} from "avaira/core/AvairaReputationRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title AvairaReputationRegistry tests
/// @notice Covers the Sybil-grounding rules: who is allowed to review, and why.
contract AvairaReputationRegistryTest is AvairaFixture {
    uint256 internal agentId;
    uint256 internal reviewerId;

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(carol, MIN_STAKE, 90);
        // Bob becomes a staked reviewer (grounding path A).
        reviewerId = _activeAgent(bob, MIN_STAKE, 70);
    }

    /* ------------------------------- grounded reviews ------------------------------- */

    function test_GiveFeedback_RequiresStake() public {
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 1_000e6);
        vm.prank(stranger);
        usdc.approve(address(stakeRegistry), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.NotAGroundedReviewer.selector, stranger));
        reputation.giveFeedback(agentId, 9_000_000, 6, "successRate", "research", "mcp://agent", "ipfs://fb", bytes32(0));
    }

    function test_GiveFeedback_RejectsUnstakedReviewerAfterExit() public {
        // Bob is grounded only while his capital is at risk.
        vm.startPrank(bob);
        stakeRegistry.unstake(reviewerId, MIN_STAKE);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.NotAGroundedReviewer.selector, bob));
        reputation.giveFeedback(agentId, 9_000_000, 6, "successRate", "research", "mcp://agent", "ipfs://fb", bytes32(0));
    }

    function test_GiveFeedback_GroundedReviewerSucceeds() public {
        vm.prank(bob);
        reputation.giveFeedback(agentId, 9_500_000, 6, "successRate", "research", "mcp://agent", "ipfs://fb1", bytes32(0));

        assertEq(reputation.feedbackCount(agentId, bob), 1);
        (int128 value, uint8 decimals, string memory tag1, , bool revoked) = reputation.readFeedback(agentId, bob, 0);
        assertEq(value, 9_500_000);
        assertFalse(revoked);
        assertEq(decimals, 6);
        assertEq(tag1, "successRate");
    }

    function test_GiveFeedback_OperatorCannotSelfReview() public {
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaReputationRegistry.ReviewerIsAgentOperator.selector, carol, agentId)
        );
        reputation.giveFeedback(agentId, 10_000_000, 6, "successRate", "", "", "", bytes32(0));
    }

    function test_GiveFeedback_RejectsUnsupportedTag() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.UnsupportedTag.selector, "vibes"));
        reputation.giveFeedback(agentId, 9_000_000, 6, "vibes", "", "", "", bytes32(0));
    }

    function test_GiveFeedback_RejectsExcessiveDecimals() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.ValueDecimalsTooLarge.selector, 19));
        reputation.giveFeedback(agentId, 1, 19, "uptime", "", "", "", bytes32(0));
    }

    function test_GiveFeedback_RejectsUnknownAgent() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.NotRegisteredAgent.selector, 999));
        reputation.giveFeedback(999, 1, 0, "uptime", "", "", "", bytes32(0));
    }

    /* ------------------------------ payment-grounded ------------------------------- */

    function _paymentProof(uint256 value, bytes32 nonce) internal view returns (AvairaReputationRegistry.PaymentProof memory) {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory signature = _signTransferWithAuthorization(BOB_PK, bob, carol, value, 0, validBefore, nonce);
        return AvairaReputationRegistry.PaymentProof({
            token: address(usdc),
            payer: bob,
            payee: carol,
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: nonce,
            signature: signature
        });
    }

    function test_GiveFeedbackWithPayment_SettlesAtomically() public {
        uint256 value = 5e6;
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        AvairaReputationRegistry.PaymentProof memory proof = _paymentProof(value, keccak256("n1"));
        vm.prank(bob);
        reputation.giveFeedbackWithPayment(
            agentId, 9_800_000, 6, "revenues", "research", "mcp://agent", "ipfs://paid", bytes32(0), proof
        );

        assertEq(usdc.balanceOf(carol), carolBefore + value, "payee must receive the settlement");
        assertEq(bobBefore - value, usdc.balanceOf(bob), "payer must be charged the settlement");
        assertEq(reputation.feedbackCount(agentId, bob), 1, "payment-grounded feedback must be recorded");
    }

    function test_GiveFeedbackWithPayment_RejectsSmallAndMismatchedPayments() public {
        uint256 tooSmall = MIN_GROUNDED_PAYMENT - 1;
        // NB: build proofs before the prank — a helper call inside the argument list
        // consumes `vm.prank` and would make the call come from the test contract.
        AvairaReputationRegistry.PaymentProof memory smallProof = _paymentProof(tooSmall, keccak256("n2"));
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaReputationRegistry.PaymentTooSmall.selector, MIN_GROUNDED_PAYMENT, tooSmall)
        );
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), smallProof);

        AvairaReputationRegistry.PaymentProof memory proof = _paymentProof(5e6, keccak256("n3"));
        proof.token = address(0xBAD);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.UnsupportedSettlementToken.selector, address(0xBAD)));
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), proof);
    }

    function test_GiveFeedbackWithPayment_RejectsWrongPayee() public {
        AvairaReputationRegistry.PaymentProof memory proof = _paymentProof(5e6, keccak256("n4"));
        proof.payee = alice;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.PaymentPayeeMismatch.selector, carol, alice));
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), proof);
    }

    function test_GiveFeedbackWithPayment_RejectsForgedSignature() public {
        uint256 validBefore = block.timestamp + 1 hours;
        // Signature produced by Alice but claiming Bob paid: recovery yields Alice, not Bob.
        bytes memory forged = _signTransferWithAuthorization(ALICE_PK, bob, carol, 5e6, 0, validBefore, keccak256("n5"));
        AvairaReputationRegistry.PaymentProof memory proof = AvairaReputationRegistry.PaymentProof({
            token: address(usdc),
            payer: bob,
            payee: carol,
            value: 5e6,
            validAfter: 0,
            validBefore: validBefore,
            nonce: keccak256("n5"),
            signature: forged
        });

        vm.prank(bob);
        vm.expectRevert(); // ERC-3009 authorization is invalid
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), proof);
    }

    function test_GiveFeedbackWithPayment_RejectsReplayedNonce() public {
        AvairaReputationRegistry.PaymentProof memory first = _paymentProof(5e6, keccak256("dup"));
        vm.prank(bob);
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), first);

        AvairaReputationRegistry.PaymentProof memory replay = _paymentProof(5e6, keccak256("dup"));
        vm.prank(bob);
        vm.expectRevert();
        reputation.giveFeedbackWithPayment(agentId, 5_000_000, 6, "revenues", "", "", "", bytes32(0), replay);
    }

    /* ---------------------------------- revocation --------------------------------- */

    function test_RevokeFeedback_MarksRecordAndEmits() public {
        vm.prank(bob);
        reputation.giveFeedback(agentId, 1_000_000, 6, "uptime", "", "", "", bytes32(0));

        vm.expectEmit(true, true, false, true, address(reputation));
        emit FeedbackRevoked(agentId, bob, 0);
        vm.prank(bob);
        reputation.revokeFeedback(agentId, 0);

        AvairaReputationRegistry.Feedback memory record = reputation.readFeedbackFull(agentId, bob, 0);
        assertTrue(record.revoked, "feedback must be flagged as revoked");
    }

    function test_RevokeFeedback_RevertsForUnknownAndDoubleRevoke() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(AvairaReputationRegistry.UnknownFeedback.selector, agentId, bob, uint64(7))
        );
        reputation.revokeFeedback(agentId, 7);

        vm.prank(bob);
        reputation.giveFeedback(agentId, 1_000_000, 6, "uptime", "", "", "", bytes32(0));

        vm.prank(bob);
        reputation.revokeFeedback(agentId, 0);

        vm.prank(bob);
        vm.expectRevert(AvairaReputationRegistry.AlreadyRevoked.selector);
        reputation.revokeFeedback(agentId, 0);
    }

    /* ----------------------------------- scoring ----------------------------------- */

    function test_Score_OnlyScorerCanPost() public {
        bytes32 scorerRole = reputation.SCORER_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, scorerRole)
        );
        reputation.postAvairaScore(agentId, 75);
    }

    function test_Score_RejectsOutOfRangeAndUnknownAgents() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.InvalidScore.selector, 101));
        reputation.postAvairaScore(agentId, 101);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.NotRegisteredAgent.selector, 404));
        reputation.postAvairaScore(404, 70);
    }

    function test_Score_PostsGradeAndBreakdownAnchor() public {
        bytes32 breakdown = keccak256("inputs");
        vm.prank(owner);
        reputation.postAvairaScore(agentId, 84, breakdown, "ipfs://evidence");

        assertEq(reputation.scoreOf(agentId), 84);
        assertEq(reputation.gradeOf(agentId), "A");
        assertEq(reputation.scoreBreakdownHash(agentId), breakdown);
        assertEq(reputation.scoreEvidenceURI(agentId), "ipfs://evidence");
        assertGt(reputation.scoreUpdatedAt(agentId), 0);
    }

    function testFuzz_GradeBands(uint8 score) public {
        score = uint8(bound(score, 0, 100));
        string memory grade = reputation.gradeOfScore(score);

        // Bands preserved from the offchain Avaira OS scorer.
        if (score >= 90) assertEq(grade, "A+");
        else if (score >= 80) assertEq(grade, "A");
        else if (score >= 70) assertEq(grade, "B");
        else if (score >= 60) assertEq(grade, "C");
        else assertEq(grade, "D");
    }

    /* ----------------------------------- summaries ---------------------------------- */

    function test_GetSummary_AggregatesTaggedFeedback() public {
        vm.startPrank(bob);
        reputation.giveFeedback(agentId, 9_000_000, 6, "successRate", "", "", "", bytes32(0));
        reputation.giveFeedback(agentId, 7_000_000, 6, "uptime", "", "", "", bytes32(0));
        reputation.giveFeedback(agentId, 8_000_000, 6, "successRate", "", "", "", bytes32(0));
        vm.stopPrank();

        address[] memory reviewers = new address[](1);
        reviewers[0] = bob;

        (uint64 count, int128 summary, uint8 decimals) = reputation.getSummary(agentId, reviewers, "successRate");
        assertEq(count, 2);
        assertEq(summary, 8_500_000);
        assertEq(decimals, 6);

        (uint64 tagged, , ) = reputation.getSummary(agentId, reviewers, "uptime");
        assertEq(tagged, 1, "tag filter must exclude other feedback");

        (uint64 all, , ) = reputation.getSummary(agentId, reviewers, "");
        assertEq(all, 3, "an empty tag means no filter and aggregates everything");
    }

    function test_GetSummary_RejectsEmptyReviewerList() public {
        vm.expectRevert(AvairaReputationRegistry.NoReviewersSupplied.selector);
        reputation.getSummary(agentId, new address[](0), "uptime");
    }

    /* ------------------------------- response append -------------------------------- */

    function test_AppendResponse_AgentOperatorOnly() public {
        vm.prank(bob);
        reputation.giveFeedback(agentId, 5_000_000, 6, "uptime", "", "", "", bytes32(0));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaReputationRegistry.NotAgentOperator.selector, bob, agentId));
        reputation.appendResponse(agentId, bob, 0, "right of reply", bytes32(0));

        vm.prank(carol);
        reputation.appendResponse(agentId, bob, 0, "right of reply", bytes32(0));

        AvairaReputationRegistry.Response[] memory responses = reputation.readResponses(agentId, bob);
        assertEq(responses.length, 1);
        assertEq(responses[0].responseURI, "right of reply");
    }

    /* ------------------------------------ admin ------------------------------------- */

    function test_SetScorerConfig_UpdatesGroundingRules() public {
        vm.prank(owner);
        reputation.setScorerConfig(address(stakeRegistry), address(usdc), 42);
        assertEq(reputation.minGroundedPayment(), 42);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0)
            )
        );
        reputation.setScorerConfig(address(0), address(0), 0);
    }

    function test_Rescue_MovesStrayTokensToTreasury() public {
        usdc.mint(address(reputation), 123e6);
        vm.prank(owner);
        reputation.rescue(address(usdc), 123e6);
        assertEq(usdc.balanceOf(reputation.treasury()), 123e6, "rescued funds go to the protocol treasury");
        assertEq(reputation.treasury(), treasury);
    }

}

/// @dev File-level re-declaration of the ERC-8004 event so `vm.expectEmit` can compare it.
///      The *name* is part of the signature (topic0), so it must match exactly.
event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
