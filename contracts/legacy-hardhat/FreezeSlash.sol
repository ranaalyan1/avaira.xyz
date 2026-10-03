// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";

/// @title AVAIRA FreezeSlash Controller
/// @notice Provides protocol-authorized freeze and slash enforcement with audit events.
contract FreezeSlash is Ownable, ReentrancyGuard {
    AgentRegistry public immutable registry;

    mapping(address => bool) public protocolAuthorized;

    event ProtocolAuthorizationUpdated(address indexed actor, bool authorized);
    event FreezeAndSlashAudit(address indexed actor, address indexed agent, uint256 slashAmount, string reason, uint256 timestamp);

    error FreezeSlash__NotProtocolAuthorized();
    error FreezeSlash__EmptyReason();

    modifier onlyProtocolAuthorized() {
        if (!(protocolAuthorized[msg.sender] || msg.sender == owner())) {
            revert FreezeSlash__NotProtocolAuthorized();
        }
        _;
    }

    constructor(address registryAddress) Ownable(msg.sender) {
        registry = AgentRegistry(registryAddress);
    }

    /// @notice Adds or removes a protocol-authorized caller.
    /// @param actor The caller address.
    /// @param authorized Whether the caller should be authorized.
    function setProtocolAuthorized(address actor, bool authorized) external onlyOwner {
        protocolAuthorized[actor] = authorized;
        emit ProtocolAuthorizationUpdated(actor, authorized);
    }

    /// @notice Freezes an agent and slashes collateral in a single audited action.
    /// @param agent The agent wallet address.
    /// @param slashAmount The slash amount denominated in wei.
    /// @param reason Human-readable reason for the action.
    /// @return actualSlashed The final slash amount applied.
    function freezeAndSlash(address agent, uint256 slashAmount, string calldata reason)
        external
        onlyProtocolAuthorized
        nonReentrant
        returns (uint256 actualSlashed)
    {
        if (bytes(reason).length == 0) {
            revert FreezeSlash__EmptyReason();
        }
        registry.freeze(agent, reason);
        actualSlashed = registry.slash(agent, slashAmount, reason);
        registry.updateReputation(agent, -20, "freeze_and_slash");
        emit FreezeAndSlashAudit(msg.sender, agent, actualSlashed, reason, block.timestamp);
    }
}
