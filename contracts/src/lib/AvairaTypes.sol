// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AvairaTypes
/// @notice Shared value types for the Avaira onchain trust layer.
/// @dev Avaira is a Monad-native accountability layer for the agent economy:
///      ERC-8004 registries (identity / reputation / validation) + a real-time
///      pre-execution gate (Proof-of-Intent) + stake/slash + score-gated credit.

/// @notice ERC-8004 identity metadata entry, supplied at registration time.
/// @param metadataKey Arbitrary key. The key `agentWallet` is reserved.
/// @param metadataValue Raw value bytes (typically ABI-encoded or UTF-8).
struct MetadataEntry {
    string metadataKey;
    bytes metadataValue;
}

/// @notice Agent lifecycle inside Avaira's accountability layer.
/// @dev NONE => unknown, PENDING => registered but unstaked, ACTIVE => eligible,
///      SUSPENDED => gated off but recoverable, BANNED => terminal.
enum AgentStatus {
    NONE,
    PENDING,
    ACTIVE,
    SUSPENDED,
    BANNED
}

/// @notice Slashing severity ladder (see AvairaStakeRegistry).
/// @dev WARNING is an escrowed/partial penalty, SUSPENSION halves the stake,
///      BAN burns the full stake and permanently bans the agent.
enum SlashLevel {
    NONE,
    WARNING,
    SUSPENSION,
    BAN
}

/// @notice The risk envelope an agent binds to a committed intent.
/// @dev Committed onchain *before* execution and enforced by `checkGate`.
///      The gate is a `view` call, so it can be evaluated speculatively
///      (Monad 400ms blocks) without waiting for full finality.
/// @param maxSpendUsd Maximum USD-denominated spend for the intent (6 decimals, USDC-style).
/// @param allowedActions Action discriminators the agent is allowed to perform.
/// @param deadline Unix timestamp after which the intent is void.
struct RiskEnvelope {
    uint256 maxSpendUsd;
    string[] allowedActions;
    uint64 deadline;
}

/// @notice Canonical serialisation of a risk envelope, used for commitment hashing.
/// @dev `intentHash` committed by the agent MUST cover the envelope plus the full plan,
///      so any post-hoc deviation is provable against a single 32-byte commitment.
library RiskEnvelopeLib {
    bytes32 internal constant ENVELOPE_TYPEHASH = keccak256(
        "RiskEnvelope(uint256 maxSpendUsd,bytes32 allowedActionsHash,uint64 deadline)"
    );

    /// @notice Hash of the envelope's action list (order-sensitive).
    function allowedActionsHash(RiskEnvelope memory envelope) internal pure returns (bytes32) {
        return keccak256(abi.encode(envelope.allowedActions));
    }

    /// @notice EIP-712-style struct hash of an envelope.
    function hash(RiskEnvelope memory envelope) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(ENVELOPE_TYPEHASH, envelope.maxSpendUsd, allowedActionsHash(envelope), envelope.deadline)
        );
    }

    /// @notice True when `action` is inside the envelope's allow-list.
    function isActionAllowed(RiskEnvelope memory envelope, string memory action) internal pure returns (bool) {
        uint256 len = envelope.allowedActions.length;
        for (uint256 i; i < len; ++i) {
            if (keccak256(bytes(envelope.allowedActions[i])) == keccak256(bytes(action))) return true;
        }
        return false;
    }
}
