// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleLib — audit-trail anchoring and deviation proofs.
/// @notice The Avaira SDK keeps the full audit trail offchain as a hash chain (for
///         throughput) and anchors one 32-byte Merkle root per intent onchain. A
///         deviation proof therefore costs ~O(log n) hashes to verify, which is what
///         makes challenging a bad execution cheap enough to be done by anyone.
///
///         Leaf format (must match the TypeScript and Python SDKs exactly):
///             leaf = keccak256(abi.encode(string action, uint256 spendUsd))
///         Internal nodes use commutative pair hashing:
///             parent = keccak256(abi.encode(min(a,b), max(a,b)))
///         so a calling SDK does not have to care about left/right ordering.
library MerkleLib {
    /// @notice Hash of an audit-trail leaf.
    function hashLeaf(string memory action, uint256 spendUsd) internal pure returns (bytes32) {
        return keccak256(abi.encode(action, spendUsd));
    }

    /// @notice Hash of an audit-trail leaf from raw bytes (audit entries with extra fields).
    function hashLeafBytes(bytes memory encoded) internal pure returns (bytes32) {
        return keccak256(encoded);
    }

    /// @notice Commutative pair hash.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @notice Recompute a root from `leaf` and `proof`. An empty proof means the tree is
    ///         a single leaf, in which case the root is the leaf.
    function processProof(bytes32[] memory proof, bytes32 leaf) internal pure returns (bytes32) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            computed = hashPair(computed, proof[i]);
        }
        return computed;
    }

    /// @notice Verify `proof` against `root` for `leaf`.
    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        return processProof(proof, leaf) == root;
    }

    /// @notice Convenience overload for deviation proofs built from (action, spendUsd).
    function verifyDeviation(bytes32[] memory proof, bytes32 root, string memory action, uint256 spendUsd)
        internal
        pure
        returns (bool)
    {
        return processProof(proof, hashLeaf(action, spendUsd)) == root;
    }
}
