// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////////
                                 AVAIRA
        Component 3 of 6: AvairaValidationRegistry
        ------------------------------------------
        ERC-8004 Validation Registry: independent 0–100 checks, requested by the agent,
        answered by a designated validator, multiple responses per request allowed.

        Avaira's validator of record is the two-pass adversarial auditor running on Kimi
        (tag: "kimi-adversarial"). The auditor re-reads the agent's plan, then re-reads it
        again adversarially looking for what the first pass rationalised away, and posts
        the resulting 0–100 response onchain. Validation responses are an input to the
        Avaira Score; they never *are* the score, and they cannot be bought — only a
        request's designated validator may answer it.

        Finality: `tag` carries the spec's soft/hard distinction ("soft" responses can be
        superseded by later ones, "hard"/"final" lock the request).
//////////////////////////////////////////////////////////////////////////////*/

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAvairaValidationRegistry} from "./interfaces/IAvairaValidationRegistry.sol";
import {IAvairaIdentityRegistry} from "./interfaces/IAvairaIdentityRegistry.sol";

contract AvairaValidationRegistry is IAvairaValidationRegistry, Ownable {
    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    IAvairaIdentityRegistry public identity;

    /// @notice Tag used by the Kimi two-pass adversarial auditor.
    string public constant KIMI_TAG = "kimi-adversarial";

    struct Request {
        address validator;
        uint256 agentId;
        uint64 createdAt;
        uint8 lastResponse;
        uint64 lastUpdate;
        bool finalized;
        bool exists;
    }

    struct ResponseRecord {
        address validator;
        uint8 response;
        uint64 timestamp;
        bool hard;
        string responseURI;
        bytes32 responseHash;
        string tag;
    }

    mapping(bytes32 requestHash => Request) private _requests;
    mapping(bytes32 requestHash => ResponseRecord[]) private _responses;
    mapping(uint256 agentId => bytes32[] hashes) private _agentValidations;
    mapping(address validator => bytes32[] hashes) private _validatorRequests;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error RequestExists(bytes32 requestHash);
    error UnknownRequest(bytes32 requestHash);
    error NotAgentOperator(uint256 agentId, address caller);
    error NotDesignatedValidator(bytes32 requestHash, address caller);
    error InvalidResponse(uint8 response);
    error RequestFinalized(bytes32 requestHash);
    error EmptyRequestURI();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address identity_) Ownable(initialOwner) {
        if (identity_ == address(0)) revert ZeroAddress();
        identity = IAvairaIdentityRegistry(identity_);
    }

    // -------------------------------------------------------------------------
    // Requests
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaValidationRegistry
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        if (validatorAddress == address(0)) revert ZeroAddress();
        if (bytes(requestURI).length == 0) revert EmptyRequestURI();
        if (_requests[requestHash].exists) revert RequestExists(requestHash);
        _requireAgentOperator(agentId);

        _requests[requestHash] = Request({
            validator: validatorAddress,
            agentId: agentId,
            createdAt: uint64(block.timestamp),
            lastResponse: 0,
            lastUpdate: 0,
            finalized: false,
            exists: true
        });
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequested(validatorAddress, agentId, requestHash, requestURI);
    }

    /// @inheritdoc IAvairaValidationRegistry
    /// @dev Multiple responses per request are allowed (the spec's soft/hard finality
    ///      model): a "hard" or "final" tagged response locks the request permanently.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Request storage request = _requests[requestHash];
        if (!request.exists) revert UnknownRequest(requestHash);
        if (msg.sender != request.validator) revert NotDesignatedValidator(requestHash, msg.sender);
        if (request.finalized) revert RequestFinalized(requestHash);
        if (response > 100) revert InvalidResponse(response);

        bool hard = _isFinalTag(tag);
        _responses[requestHash].push(
            ResponseRecord({
                validator: msg.sender,
                response: response,
                timestamp: uint64(block.timestamp),
                hard: hard,
                responseURI: responseURI,
                responseHash: responseHash,
                tag: tag
            })
        );

        request.lastResponse = response;
        request.lastUpdate = uint64(block.timestamp);
        if (hard) request.finalized = true;

        emit ValidationResponded(msg.sender, request.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    /// @inheritdoc IAvairaValidationRegistry
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validator,
            uint256 agentId,
            uint8 response,
            string memory responseURI,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        Request storage request = _requests[requestHash];
        ResponseRecord[] storage list = _responses[requestHash];
        if (list.length == 0) {
            return (request.validator, request.agentId, 0, "", bytes32(0), "", request.lastUpdate);
        }
        ResponseRecord storage latest = list[list.length - 1];
        return (
            latest.validator,
            request.agentId,
            latest.response,
            latest.responseURI,
            latest.responseHash,
            latest.tag,
            latest.timestamp
        );
    }

    /// @inheritdoc IAvairaValidationRegistry
    /// @dev Mean response across the caller-supplied validator set, filtered by tag
    ///      (empty tag = all). Caller-supplied filtering is deliberate: a relying party
    ///      must be able to exclude validators it does not trust.
    function getSummary(uint256 agentId, address[] calldata validators, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        bytes32 wantTag = keccak256(bytes(tag));
        bool anyTag = bytes(tag).length == 0;

        uint256 total;
        bytes32[] storage hashes = _agentValidations[agentId];
        for (uint256 i = 0; i < hashes.length; ++i) {
            ResponseRecord[] storage list = _responses[hashes[i]];
            for (uint256 j = 0; j < list.length; ++j) {
                if (!anyTag && keccak256(bytes(list[j].tag)) != wantTag) continue;
                if (!_isInSet(list[j].validator, validators)) continue;
                total += list[j].response;
                count += 1;
            }
        }
        if (count == 0) return (0, 0);
        averageResponse = uint8(total / uint256(count));
    }

    /// @inheritdoc IAvairaValidationRegistry
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    /// @inheritdoc IAvairaValidationRegistry
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    /// @notice Full response history for a request (soft → hard evolution).
    function getResponses(bytes32 requestHash) external view returns (ResponseRecord[] memory) {
        return _responses[requestHash];
    }

    function requestOf(bytes32 requestHash) external view returns (Request memory) {
        return _requests[requestHash];
    }

    function responseCount(bytes32 requestHash) external view returns (uint256) {
        return _responses[requestHash].length;
    }

    /// @notice The latest Kimi adversarial audit score for an agent (0 when never audited).
    function latestKimiScore(uint256 agentId) external view returns (uint8 score, uint64 timestamp) {
        bytes32[] storage hashes = _agentValidations[agentId];
        for (uint256 i = hashes.length; i > 0; --i) {
            ResponseRecord[] storage list = _responses[hashes[i - 1]];
            for (uint256 j = list.length; j > 0; --j) {
                if (keccak256(bytes(list[j - 1].tag)) == keccak256(bytes(KIMI_TAG))) {
                    return (list[j - 1].response, list[j - 1].timestamp);
                }
            }
        }
        return (0, 0);
    }

    // -------------------------------------------------------------------------
    // Internals / admin
    // -------------------------------------------------------------------------

    function setIdentityRegistry(address identity_) external onlyOwner {
        if (identity_ == address(0)) revert ZeroAddress();
        identity = IAvairaIdentityRegistry(identity_);
    }

    function _isFinalTag(string calldata tag) private pure returns (bool) {
        bytes32 h = keccak256(bytes(tag));
        return h == keccak256("hard") || h == keccak256("final");
    }

    function _isInSet(address needle, address[] calldata set) private pure returns (bool) {
        if (set.length == 0) return true; // empty set = no filter
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i] == needle) return true;
        }
        return false;
    }

    function _requireAgentOperator(uint256 agentId) private view {
        address owner_ = identity.ownerOf(agentId);
        bool ok = msg.sender == owner_ || msg.sender == identity.getAgentWallet(agentId)
            || identity.isApprovedForAll(owner_, msg.sender) || msg.sender == identity.getApproved(agentId);
        if (!ok) revert NotAgentOperator(agentId, msg.sender);
    }
}
