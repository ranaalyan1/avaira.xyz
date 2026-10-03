// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAvairaValidationRegistry — ERC-8004 Validation Registry.
/// @notice Independent 0–100 checks. An agent requests validation from a designated
///         validator; only that validator can answer. Avaira's validator of record is
///         the Kimi two-pass adversarial auditor (`kimi-adversarial` tag).
interface IAvairaValidationRegistry {
    event ValidationRequested(
        address indexed validator, uint256 indexed agentId, bytes32 indexed requestHash, string requestURI
    );
    event ValidationResponded(
        address indexed validator,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

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
        );

    function getSummary(uint256 agentId, address[] calldata validators, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory);
}
