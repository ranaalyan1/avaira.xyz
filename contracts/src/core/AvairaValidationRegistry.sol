// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IERC8004ValidationRegistry} from "../interfaces/IERC8004.sol";

/// @title AvairaValidationRegistry
/// @notice ERC-8004 Validation Registry (0–100 independent checks).
/// @dev Spec-faithful flow: an agent owner/operator files `validationRequest` naming a
///      registered validator and a `requestHash`; the validator answers with
///      `validationResponse(requestHash, response, responseURI, responseHash, tag)`.
///      Multiple responses per request are allowed so a soft verdict can be
///      superseded by a hard one (`tag == "hard-final"` freezes the request).
///
///      Avaira ships a real validator: the two-pass adversarial reviewer ("Kimi
///      auditor") runs offchain, writes its findings to IPFS, and posts the
///      `kimi-adversarial` tagged verdict onchain through this registry.
contract AvairaValidationRegistry is AccessControl, IERC8004ValidationRegistry {
    /* --------------------------------- errors -------------------------------- */

    error ValidatorNotRegistered(address validator);
    error ValidatorAlreadyRegistered(address validator);
    error RequestAlreadyExists(bytes32 requestHash);
    error UnknownRequest(bytes32 requestHash);
    error NotRequestingAgent(address caller, uint256 agentId);
    error NotAssignedValidator(address caller, bytes32 requestHash);
    error ResponseOutOfRange(uint8 response);
    error RequestFinalised(bytes32 requestHash);
    error LengthMismatch();
    error ZeroAddress();

    /* --------------------------------- roles --------------------------------- */

    /// @notice Role allowed to register/remove validators.
    bytes32 public constant VALIDATOR_ADMIN_ROLE = keccak256("AVAIRA_VALIDATOR_ADMIN_ROLE");

    /// @notice Tag that marks a verdict as hard-final; no further responses are accepted.
    string public constant TAG_HARD_FINAL = "hard-final";

    /// @notice Default tag used by the Kimi two-pass adversarial auditor.
    string public constant TAG_KIMI_ADVERSARIAL = "kimi-adversarial";

    /* ---------------------------------- types -------------------------------- */

    struct Request {
        address validatorAddress;
        uint256 agentId;
        string requestURI;
        uint64 createdAt;
        bool exists;
    }

    struct ResponseRecord {
        address validatorAddress;
        uint8 response;
        string responseURI;
        bytes32 responseHash;
        string tag;
        uint64 createdAt;
    }

    /* ---------------------------------- state -------------------------------- */

    IERC721 public immutable identityRegistry;

    mapping(bytes32 requestHash => Request) private _requests;
    mapping(bytes32 requestHash => ResponseRecord[]) private _responses;
    mapping(uint256 agentId => bytes32[] requestHashes) private _agentValidations;
    mapping(address validator => bool) public isValidator;
    mapping(address validator => string) public validatorMetadataURI;
    address[] private _validators;

    /* --------------------------------- events -------------------------------- */

    event ValidatorRegistered(address indexed validator, string metadataURI);
    event ValidatorRemoved(address indexed validator);

    /* ------------------------------- constructor ------------------------------ */

    constructor(address identityRegistry_, address admin) AccessControl() {
        if (identityRegistry_ == address(0) || admin == address(0)) revert ZeroAddress();
        identityRegistry = IERC721(identityRegistry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VALIDATOR_ADMIN_ROLE, admin);
    }

    /* --------------------------------- requests ------------------------------- */

    /// @inheritdoc IERC8004ValidationRegistry
    /// @dev Callable by the agent's owner or an approved operator.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external override {
        if (!isValidator[validatorAddress]) revert ValidatorNotRegistered(validatorAddress);
        if (_requests[requestHash].exists) revert RequestAlreadyExists(requestHash);
        if (!_isAgentOperator(agentId, msg.sender)) revert NotRequestingAgent(msg.sender, agentId);

        _requests[requestHash] = Request({
            validatorAddress: validatorAddress,
            agentId: agentId,
            requestURI: requestURI,
            createdAt: uint64(block.timestamp),
            exists: true
        });
        _agentValidations[agentId].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    /* -------------------------------- responses ------------------------------- */

    /// @inheritdoc IERC8004ValidationRegistry
    /// @dev Only the validator named in the request may answer; `response` is 0–100.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external override {
        Request storage request = _requests[requestHash];
        if (!request.exists) revert UnknownRequest(requestHash);
        if (request.validatorAddress != msg.sender) revert NotAssignedValidator(msg.sender, requestHash);
        if (response > 100) revert ResponseOutOfRange(response);
        if (_isFinalised(requestHash)) revert RequestFinalised(requestHash);

        _responses[requestHash].push(
            ResponseRecord({
                validatorAddress: msg.sender,
                response: response,
                responseURI: responseURI,
                responseHash: responseHash,
                tag: tag,
                createdAt: uint64(block.timestamp)
            })
        );

        emit ValidationResponse(msg.sender, request.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    /* ---------------------------------- views --------------------------------- */

    /// @inheritdoc IERC8004ValidationRegistry
    function getValidationStatus(bytes32 requestHash)
        external
        view
        override
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            string memory responseURI,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        Request storage request = _requests[requestHash];
        if (!request.exists) revert UnknownRequest(requestHash);
        ResponseRecord[] storage records = _responses[requestHash];
        if (records.length == 0) {
            return (request.validatorAddress, request.agentId, 0, "", bytes32(0), "", request.createdAt);
        }
        ResponseRecord storage latest = records[records.length - 1];
        return (
            latest.validatorAddress,
            request.agentId,
            latest.response,
            latest.responseURI,
            latest.responseHash,
            latest.tag,
            latest.createdAt
        );
    }

    /// @notice Every response recorded for `requestHash`, oldest first.
    function getValidationResponses(bytes32 requestHash) external view returns (ResponseRecord[] memory) {
        return _responses[requestHash];
    }

    /// @inheritdoc IERC8004ValidationRegistry
    /// @dev Averages the latest response of each supplied validator, optionally filtered by tag.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        override
        returns (uint64 count, uint8 averageResponse)
    {
        if (validatorAddresses.length == 0) revert LengthMismatch();
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 total;
        bytes32[] storage hashes = _agentValidations[agentId];

        for (uint256 v; v < validatorAddresses.length; ++v) {
            address validator = validatorAddresses[v];
            for (uint256 h; h < hashes.length; ++h) {
                ResponseRecord[] storage records = _responses[hashes[h]];
                for (uint256 i; i < records.length; ++i) {
                    ResponseRecord storage record = records[i];
                    if (record.validatorAddress != validator) continue;
                    if (bytes(tag).length > 0 && keccak256(bytes(record.tag)) != tagHash) continue;
                    total += record.response;
                    count++;
                }
            }
        }
        averageResponse = count == 0 ? 0 : uint8(total / count);
    }

    /// @inheritdoc IERC8004ValidationRegistry
    function getAgentValidations(uint256 agentId) external view override returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    /// @notice Latest response value for `requestHash` (0 when unanswered).
    function latestResponse(bytes32 requestHash) external view returns (uint8) {
        ResponseRecord[] storage records = _responses[requestHash];
        return records.length == 0 ? 0 : records[records.length - 1].response;
    }

    /// @notice Every registered validator address.
    function validators() external view returns (address[] memory) {
        return _validators;
    }

    /* --------------------------------- admin ---------------------------------- */

    function registerValidator(address validator, string calldata metadataURI) external onlyRole(VALIDATOR_ADMIN_ROLE) {
        if (validator == address(0)) revert ZeroAddress();
        if (isValidator[validator]) revert ValidatorAlreadyRegistered(validator);
        isValidator[validator] = true;
        validatorMetadataURI[validator] = metadataURI;
        _validators.push(validator);
        emit ValidatorRegistered(validator, metadataURI);
    }

    function removeValidator(address validator) external onlyRole(VALIDATOR_ADMIN_ROLE) {
        if (!isValidator[validator]) revert ValidatorNotRegistered(validator);
        isValidator[validator] = false;
        uint256 len = _validators.length;
        for (uint256 i; i < len; ++i) {
            if (_validators[i] == validator) {
                _validators[i] = _validators[len - 1];
                _validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(validator);
    }

    /* -------------------------------- internals ------------------------------- */

    function _isFinalised(bytes32 requestHash) private view returns (bool) {
        ResponseRecord[] storage records = _responses[requestHash];
        if (records.length == 0) return false;
        return keccak256(bytes(records[records.length - 1].tag)) == keccak256(bytes(TAG_HARD_FINAL));
    }

    function _isAgentOperator(uint256 agentId, address account) private view returns (bool) {
        address owner = identityRegistry.ownerOf(agentId);
        if (account == owner) return true;
        if (identityRegistry.getApproved(agentId) == account) return true;
        return identityRegistry.isApprovedForAll(owner, account);
    }
}
