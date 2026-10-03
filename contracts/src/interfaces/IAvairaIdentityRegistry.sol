// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MetadataEntry} from "./IAvairaTypes.sol";

/// @title IAvairaIdentityRegistry — ERC-8004 Identity Registry surface + Avaira bond extension.
/// @notice Implements the ERC-8004 "Trustless Agents" identity registry interface
///         (ERC-721 based, `agentURI` per agent, reserved `agentWallet` metadata key)
///         plus Avaira's registration bond: minting an agent identity is not free, and
///         the bond is forfeited on BAN. This is Sybil fix #1 from arXiv:2606.26028,
///         which found only 3%/4%/15% of registrations across ETH/BSC/Base expose a live
///         agent at all — free identity minting is why.
interface IAvairaIdentityRegistry is IERC721 {
    // ---------------------------------------------------------------------
    // ERC-8004 events
    // ---------------------------------------------------------------------
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    // ---------------------------------------------------------------------
    // Avaira extension events
    // ---------------------------------------------------------------------
    event BondPosted(uint256 indexed agentId, address indexed payer, uint256 amount);
    event BondRefunded(uint256 indexed agentId, address indexed to, uint256 amount);
    event BondForfeited(uint256 indexed agentId, address indexed treasury, uint256 amount);
    event RegistrationBondUpdated(uint256 previousBond, uint256 newBond);
    event AgentWalletSet(uint256 indexed agentId, address indexed newWallet);
    event AgentWalletUnset(uint256 indexed agentId);

    // ---------------------------------------------------------------------
    // ERC-8004 registry API
    // ---------------------------------------------------------------------

    /// @notice Mint a new agent identity. `msg.value` MUST equal {registrationBond}.
    /// @param agentURI URI of the registration file (IPFS or HTTPS).
    /// @return agentId The minted agent id (== ERC-721 token id).
    function register(string calldata agentURI) external payable returns (uint256 agentId);

    /// @notice Mint a new agent identity with initial metadata entries.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        payable
        returns (uint256 agentId);

    /// @notice Update the agent's registration file URI.
    function setAgentURI(uint256 agentId, string calldata newURI) external;

    /// @notice Read a metadata value by key. `agentWallet` is reserved and served from
    ///         the agent-wallet slot, never from metadata storage.
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory);

    /// @notice Write a metadata value. Reserved keys (`agentWallet`) are rejected.
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external;

    /// @notice Bind a wallet to the agent. Requires proof of control of `newWallet`
    ///         (ECDSA for EOAs, ERC-1271 for smart accounts such as Privy passkey wallets)
    ///         and authorization from the agent owner / approved operator.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external;

    /// @notice The wallet currently bound to the agent (address(0) when unset).
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice Remove the wallet binding (owner / operator only).
    function unsetAgentWallet(uint256 agentId) external;

    /// @notice `eip155:{chainId}:{identityRegistryAddress}` — the value agents are
    ///         expected to advertise inside their registration file.
    function agentRegistry() external view returns (string memory);


    // ---------------------------------------------------------------------
    // Avaira bond extension
    // ---------------------------------------------------------------------

    /// @notice Bond currently held against `agentId`.
    function bondOf(uint256 agentId) external view returns (uint256);

    /// @notice Bond required for new registrations.
    function registrationBond() external view returns (uint256);

    /// @notice True when `agentId` is registered and still bonded.
    function isRegistered(uint256 agentId) external view returns (bool);

    /// @notice Burn the identity and refund the bond (voluntary exit).
    function refundBondAndBurn(uint256 agentId) external;

    /// @notice Forfeit the bond to the treasury — called by the slash authority on BAN.
    function forfeitBond(uint256 agentId) external;
}
