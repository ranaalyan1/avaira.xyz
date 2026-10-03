// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {AvairaValidationRegistry} from "avaira/core/AvairaValidationRegistry.sol";
import {IERC8004ValidationRegistry} from "avaira/interfaces/IERC8004.sol";

import {AvairaFixture} from "./utils/AvairaFixture.sol";

/// @title AvairaValidationRegistryTest — Component 3 (0–100 independent checks)
contract AvairaValidationRegistryTest is AvairaFixture {
    uint256 internal agentId;
    address internal kimiAuditor = makeAddr("kimiAuditor");
    bytes32 internal requestHash = keccak256("validation:task-1");

    function setUp() public override {
        super.setUp();
        agentId = _activeAgent(alice, MIN_STAKE, 74);
        vm.prank(owner);
        validation.registerValidator(kimiAuditor, "ipfs://validators/kimi.json");
    }

    /* ------------------------------- registration ----------------------------- */

    function test_RegisterValidator_AdminOnlyAndNoDuplicates() public {
        assertTrue(validation.isValidator(kimiAuditor));
        assertEq(validation.validatorMetadataURI(kimiAuditor), "ipfs://validators/kimi.json");
        assertEq(validation.validators().length, 1);

        bytes32 adminRole = validation.VALIDATOR_ADMIN_ROLE();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, adminRole));
        validation.registerValidator(bob, "");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.ValidatorAlreadyRegistered.selector, kimiAuditor));
        validation.registerValidator(kimiAuditor, "");
    }

    function test_RemoveValidator_StopsNewRequests() public {
        vm.prank(owner);
        validation.removeValidator(kimiAuditor);
        assertFalse(validation.isValidator(kimiAuditor));
        assertEq(validation.validators().length, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.ValidatorNotRegistered.selector, kimiAuditor));
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);
    }

    /* --------------------------------- requests -------------------------------- */

    function test_ValidationRequest_OnlyAgentOperatorAndUnregisteredValidatorRejected() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.NotRequestingAgent.selector, bob, agentId));
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.ValidatorNotRegistered.selector, bob));
        validation.validationRequest(bob, agentId, "ipfs://req", requestHash);

        vm.prank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);

        assertEq(validation.getAgentValidations(agentId).length, 1);
        assertEq(validation.getAgentValidations(agentId)[0], requestHash);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.RequestAlreadyExists.selector, requestHash));
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);
    }

    /* -------------------------------- responses -------------------------------- */

    function test_ValidationResponse_OnlyAssignedValidator() public {
        vm.prank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.NotAssignedValidator.selector, bob, requestHash));
        validation.validationResponse(requestHash, 80, "ipfs://res", bytes32(0), "kimi-adversarial");

        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, 88, "ipfs://res", keccak256("res"), "kimi-adversarial");

        (
            address validatorAddress,
            uint256 returnedAgentId,
            uint8 response,
            string memory responseURI,
            bytes32 responseHash_,
            string memory tag,
            uint256 lastUpdate
        ) = validation.getValidationStatus(requestHash);
        assertEq(validatorAddress, kimiAuditor);
        assertEq(returnedAgentId, agentId);
        assertEq(response, 88);
        assertEq(responseURI, "ipfs://res");
        assertEq(responseHash_, keccak256("res"));
        assertEq(tag, "kimi-adversarial");
        assertGt(lastUpdate, 0);
        assertEq(validation.latestResponse(requestHash), 88);
    }

    function test_ValidationResponse_RejectsOutOfRangeAndUnknownRequest() public {
        vm.prank(kimiAuditor);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.UnknownRequest.selector, requestHash));
        validation.validationResponse(requestHash, 50, "", bytes32(0), "");

        vm.prank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);
        vm.prank(kimiAuditor);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.ResponseOutOfRange.selector, 101));
        validation.validationResponse(requestHash, 101, "", bytes32(0), "");
    }

    /// @dev Soft verdicts stay open for revision; a hard-final verdict freezes the request.
    function test_MultipleResponses_SoftThenHardFinality() public {
        vm.prank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);

        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, 40, "ipfs://pass1", bytes32(0), "soft");
        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, 85, "ipfs://pass2", bytes32(0), "soft");

        assertEq(validation.getValidationResponses(requestHash).length, 2);
        assertEq(validation.latestResponse(requestHash), 85);

        // NB: read the constant *before* pranking — an external view call consumes the prank.
        string memory hardFinal = validation.TAG_HARD_FINAL();
        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, 85, "ipfs://final", bytes32(0), hardFinal);
        assertEq(validation.getValidationResponses(requestHash).length, 3);

        vm.prank(kimiAuditor);
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.RequestFinalised.selector, requestHash));
        validation.validationResponse(requestHash, 10, "ipfs://late", bytes32(0), "soft");
    }

    /* --------------------------------- summaries ------------------------------- */

    function test_GetSummary_AveragesPerValidatorWithTagFilter() public {
        vm.prank(owner);
        validation.registerValidator(bob, "");

        bytes32 second = keccak256("validation:task-2");
        vm.startPrank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req1", requestHash);
        validation.validationRequest(bob, agentId, "ipfs://req2", second);
        vm.stopPrank();

        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, 90, "", bytes32(0), "kimi-adversarial");
        vm.prank(bob);
        validation.validationResponse(second, 70, "", bytes32(0), "kimi-adversarial");

        address[] memory validators = new address[](2);
        validators[0] = kimiAuditor;
        validators[1] = bob;

        (uint64 count, uint8 average) = validation.getSummary(agentId, validators, "kimi-adversarial");
        assertEq(count, 2);
        assertEq(average, 80);

        (count, average) = validation.getSummary(agentId, validators, "");
        assertEq(count, 2);
        assertEq(average, 80);

        address[] memory onlyKimi = new address[](1);
        onlyKimi[0] = kimiAuditor;
        (count, average) = validation.getSummary(agentId, onlyKimi, "kimi-adversarial");
        assertEq(count, 1);
        assertEq(average, 90);
    }

    function test_GetSummary_RejectsEmptyValidatorSet() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AvairaValidationRegistry.LengthMismatch.selector);
        validation.getSummary(agentId, empty, "");
    }

    function test_GetValidationStatus_RevertsForUnknownRequest() public {
        vm.expectRevert(abi.encodeWithSelector(AvairaValidationRegistry.UnknownRequest.selector, keccak256("nope")));
        validation.getValidationStatus(keccak256("nope"));
    }

    /* ---------------------------------- fuzz ---------------------------------- */

    function testFuzz_ValidationResponse_AnyScoreInRange(uint8 score, uint64 tagSeed) public {
        score = uint8(bound(score, 0, 100));
        string[2] memory tags = ["kimi-adversarial", "soft"];
        string memory tag = tags[tagSeed % 2];

        vm.prank(alice);
        validation.validationRequest(kimiAuditor, agentId, "ipfs://req", requestHash);
        vm.prank(kimiAuditor);
        validation.validationResponse(requestHash, score, "ipfs://res", bytes32(0), tag);

        assertEq(validation.latestResponse(requestHash), score);
    }
}
