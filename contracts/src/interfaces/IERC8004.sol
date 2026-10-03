// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MetadataEntry, AgentStatus} from "../lib/AvairaTypes.sol";

/// @title IERC8004 — Trustless Agents registries (ERC-8004)
/// @notice Canonical interface surface for the three ERC-8004 registries as
///         deployed by Avaira on Monad. Signatures follow the specification so
///         that any ERC-8004 client can read Avaira's registries unchanged.
/// @dev Reference: ERC-8004 "Trustless Agents" (MetaMask / EF / Google / Coinbase).

/* -------------------------------------------------------------------------- */
/*                              IDENTITY REGISTRY                             */
/* -------------------------------------------------------------------------- */

interface IERC8004IdentityRegistry {
    /// @notice Emitted on every successful registration.
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @notice Emitted when an agent's registration file pointer changes.
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    /// @notice Emitted when metadata is written for an agent.
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    /// @dev Registers a new agent with a registration-file URI. Returns the new agentId.
    function register(string calldata agentURI) external payable returns (uint256 agentId);

    /// @dev Registers a new agent with inline metadata key/value pairs.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        payable
        returns (uint256 agentId);

    /// @dev Updates the registration file pointer for `agentId`.
    function setAgentURI(uint256 agentId, string calldata newURI) external;

    /// @dev Reads a metadata value for `agentId`.
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    /// @dev Writes a metadata value for `agentId`. `agentWallet` is reserved.
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;

    /// @dev Binds a wallet to an agent using an EIP-712 (EOA) or ERC-1271 (contract) signature.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;

    /// @dev Clears the agent wallet binding.
    function unsetAgentWallet(uint256 agentId) external;

    /// @dev Returns the currently bound agent wallet (address(0) when unset).
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @dev Canonical registry identifier: `eip155:{chainId}:{identityRegistryAddress}`.
    function agentRegistry() external view returns (string memory);
}

/* -------------------------------------------------------------------------- */
/*                             REPUTATION REGISTRY                            */
/* -------------------------------------------------------------------------- */

interface IERC8004ReputationRegistry {
    /// @notice Emitted for every accepted feedback record (ERC-8004 shape).
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

    /// @notice Emitted when a reviewer revokes their own feedback.
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    /// @notice Emitted when an agent owner/operator replies to feedback.
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

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

    function getSummary(uint256 agentId, address[] calldata reviewers, string calldata tag)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/* -------------------------------------------------------------------------- */
/*                             VALIDATION REGISTRY                            */
/* -------------------------------------------------------------------------- */

interface IERC8004ValidationRegistry {
    /// @notice Emitted when an agent requests validation of a request hash.
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );

    /// @notice Emitted when a validator answers a request.
    event ValidationResponse(
        address indexed validatorAddress,
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
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            string memory responseURI,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);
}

/// @notice Avaira-specific identity extensions (registration bond, ban, exit).
interface IAvairaIdentityRegistry is IERC8004IdentityRegistry {
    event AgentBanned(uint256 indexed agentId, address indexed enforcer, uint256 forfeitedBond, string reason);
    event AgentExited(uint256 indexed agentId, address indexed owner, uint256 refundedBond);
    event AgentWalletUnset(uint256 indexed agentId, address indexed unsetBy);
    event AgentWalletSet(uint256 indexed agentId, address indexed newWallet, address indexed setBy);
    event RegistrationBondUpdated(uint256 previousBond, uint256 newBond);
    event TreasuryUpdated(address previousTreasury, address newTreasury);
    event EnforcerUpdated(address previousEnforcer, address newEnforcer);

    function exitAgent(uint256 agentId) external;
    function banAgent(uint256 agentId, string calldata reason) external;
    function isBanned(uint256 agentId) external view returns (bool);
    function isActive(uint256 agentId) external view returns (bool);
    function statusOf(uint256 agentId) external view returns (AgentStatus);
    function registrationBond() external view returns (uint256);
    function activeAgents() external view returns (uint256);
}
