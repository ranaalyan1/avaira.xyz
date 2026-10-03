// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAvairaTypes — shared value types for the Avaira onchain trust stack.
/// @notice Everything in the Avaira protocol is denominated in exactly one of these
///         types so that offchain services (scorer, auditor, SDK) and onchain
///         contracts cannot disagree about semantics.

/// @notice Lifecycle of an agent in the Avaira network.
///         NONE      — unknown to Avaira (gate always refuses).
///         PENDING   — stake posted, not yet eligible (score unposted or below floor).
///         ACTIVE    — may pass the gate; may review other agents.
///         SUSPENDED — temporarily ineligible, stake partially slashed.
///         BANNED    — permanent, stake burned, identity bond forfeited.
enum AgentStatus {
    NONE,
    PENDING,
    ACTIVE,
    SUSPENDED,
    BANNED
}

/// @notice Severity of a protocol-enforced punishment.
///         WARNING    — 10% of stake moved to the treasury.
///         SUSPENSION — 50% of stake slashed, agent loses eligibility.
///         BAN        — 100% of stake slashed, agent permanently removed.
enum SlashLevel {
    WARNING,
    SUSPENSION,
    BAN
}

/// @notice Assets accepted by the protocol.
enum Asset {
    MON,
    USDC
}

/// @notice The risk envelope an agent commits to *before* it acts.
///         This is the Avaira primitive: not a policy document, a hash-committed
///         onchain promise that a Merkle proof of the outcome can be checked against.
/// @param maxSpendUsd Maximum cumulative USD-denominated spend authorised for the intent.
/// @param allowedActions Whitelist of action identifiers the intent may perform.
/// @param deadline Unix timestamp after which the intent can no longer be executed.
struct RiskEnvelope {
    uint256 maxSpendUsd;
    string[] allowedActions;
    uint64 deadline;
}

/// @notice ERC-8004 `register` metadata entries.
struct MetadataEntry {
    string metadataKey;
    bytes metadataValue;
}

/// @notice Proof that an attested outcome violated its committed envelope.
///         `leafHash` is recomputed onchain as keccak256(abi.encode(action, spendUsd))
///         so a challenger cannot invent an action/spend pair that is not in the trail.
/// @param action Action identifier observed in the audit trail.
/// @param spendUsd USD-denominated spend observed for that action.
/// @param leafIndex Index of the leaf in the audit-trail Merkle tree.
/// @param merkleProof Sibling path from the leaf to the anchored Merkle root.
struct DeviationProof {
    string action;
    uint256 spendUsd;
    uint256 leafIndex;
    bytes32[] merkleProof;
}

/// @notice References a payment that a prover (Chainlink Functions / re-executing
///         indexer) has already verified against the settlement layer.
struct PaymentProof {
    bytes32 paymentRef;
}
