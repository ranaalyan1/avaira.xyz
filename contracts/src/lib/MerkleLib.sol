// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeviationLeaf} from "../interfaces/IAvaira.sol";

/// @title MerkleLib
/// @notice Sorted-pair keccak256 Merkle tree used to anchor the agent's local
///         hash-chained audit trail onchain (one 32-byte root per execution).
/// @dev The offchain trail keeps full throughput; the chain keeps the commitment.
///      Leaves are domain-separated per level to prevent second-preimage forgery.
library MerkleLib {
    error InvalidProofLength();

    /// @notice Hashes a single execution leaf published by the agent.
    function hashDeviationLeaf(DeviationLeaf memory leaf) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "Avaira.DeviationLeaf.v1",
                leaf.agentId,
                leaf.intentHash,
                keccak256(bytes(leaf.action)),
                leaf.spendUsd,
                leaf.nonce
            )
        );
    }

    /// @notice Hashes a raw leaf value with the standard tree domain separator.
    function hashLeaf(bytes32 value) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), value));
    }

    /// @notice Hashes an internal node from two children (order-independent).
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        (bytes32 left, bytes32 right) = a <= b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(bytes1(0x01), left, right));
    }

    /// @notice Verifies `leaf` is part of the tree whose root is `expectedRoot`.
    /// @param leaf Raw 32-byte leaf value (pass `hashDeviationLeaf(...)` output).
    function verify(bytes32[] memory proof, bytes32 expectedRoot, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = hashLeaf(leaf);
        uint256 len = proof.length;
        for (uint256 i; i < len; ++i) {
            computed = hashPair(computed, proof[i]);
        }
        return computed == expectedRoot;
    }

    /// @notice Computes the Merkle root of `leaves`. Odd nodes are promoted unchanged.
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 len = leaves.length;
        if (len == 0) return bytes32(0);
        bytes32[] memory level = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            level[i] = hashLeaf(leaves[i]);
        }
        while (len > 1) {
            uint256 next = (len + 1) / 2;
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i; i < next; ++i) {
                uint256 left = 2 * i;
                uint256 right = left + 1;
                parents[i] = right < len ? hashPair(level[left], level[right]) : level[left];
            }
            level = parents;
            len = next;
        }
        return level[0];
    }
}
