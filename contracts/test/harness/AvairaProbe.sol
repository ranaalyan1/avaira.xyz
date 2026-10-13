// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleLib} from "avaira/lib/MerkleLib.sol";
import {RiskEnvelope, RiskEnvelopeLib} from "avaira/lib/AvairaTypes.sol";
import {DeviationLeaf, GateReason} from "avaira/interfaces/IAvaira.sol";
import {AvairaStakeRegistry} from "avaira/core/AvairaStakeRegistry.sol";
import {AvairaIntentVault} from "avaira/core/AvairaIntentVault.sol";

/**
 * @title AvairaProbe
 * @notice Test-only oracle. Two jobs, both of which the verification harness needs and no
 *         production contract should own:
 *
 *         1. Expose `MerkleLib` / `RiskEnvelopeLib` as external calls, so an offchain
 *            implementation in another language (Python, TypeScript, Rust) can be compared
 *            against the *onchain* one byte-for-byte. The libraries are `internal pure`, so
 *            without a probe the only cross-check is to burn a challenge transaction per
 *            vector.
 *         2. Read the per-agent protocol state in one `eth_call`. A stateful invariant
 *            campaign evaluates its invariants after every sequence; doing that with a dozen
 *            separate calls makes the campaign call-bound instead of EVM-bound.
 *
 * @dev Holds no authority: read-only, wired into nothing, and deliberately *not* deployed by
 *      `script/Deploy.s.sol`. `tools/doctor.py` asserts this contract never appears in a
 *      deployment manifest.
 */
contract AvairaProbe {
    AvairaStakeRegistry public immutable stakeRegistry;
    AvairaIntentVault public immutable intentVault;

    constructor(address stakeRegistry_, address intentVault_) {
        stakeRegistry = AvairaStakeRegistry(stakeRegistry_);
        intentVault = AvairaIntentVault(intentVault_);
    }

    /* ------------------------------ hashing oracles ----------------------------- */

    function root(bytes32[] calldata leaves) external pure returns (bytes32) {
        return MerkleLib.root(leaves);
    }

    function hashLeaf(bytes32 value) external pure returns (bytes32) {
        return MerkleLib.hashLeaf(value);
    }

    function hashPair(bytes32 a, bytes32 b) external pure returns (bytes32) {
        return MerkleLib.hashPair(a, b);
    }

    function verify(bytes32[] calldata proof, bytes32 expectedRoot, bytes32 leaf) external pure returns (bool) {
        return MerkleLib.verify(proof, expectedRoot, leaf);
    }

    function hashDeviationLeaf(DeviationLeaf calldata leaf) external pure returns (bytes32) {
        return MerkleLib.hashDeviationLeaf(leaf);
    }

    function hashEnvelope(RiskEnvelope calldata envelope) external pure returns (bytes32) {
        return RiskEnvelopeLib.hash(envelope);
    }

    function actionsHash(string[] calldata actions) external pure returns (bytes32) {
        return RiskEnvelopeLib.allowedActionsHash(RiskEnvelope({maxSpendUsd: 0, allowedActions: actions, deadline: 0}));
    }

    /* ------------------------------ batched state view --------------------------- */

    struct AgentState {
        uint256 agentId;
        uint256 stakeOf;
        uint256 stakerAccountStake;
        uint256 slashedTotal;
        uint256 slashCount;
        uint256 suspendedUntil;
        uint8 status;
        uint8 score;
        uint8 minScore;
        bool gateAllowed;
        bool eligible;
        uint8 gateReason;
        address staker;
    }

    /** @notice One call, every number the ledger and slash-ladder invariants need. */
    function agents(uint256[] calldata ids) external view returns (AgentState[] memory out) {
        out = new AgentState[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            address staker = stakeRegistry.stakerOf(id);
            (bool allowed,, GateReason reason) = intentVault.checkGate(id);
            out[i] = AgentState({
                agentId: id,
                stakeOf: stakeRegistry.stakeOf(id),
                stakerAccountStake: staker == address(0) ? 0 : stakeRegistry.accountStake(staker),
                slashedTotal: stakeRegistry.slashedTotal(id),
                slashCount: stakeRegistry.slashCount(id),
                suspendedUntil: stakeRegistry.suspendedUntil(id),
                status: uint8(stakeRegistry.statusOf(id)),
                score: stakeRegistry.scoreOf(id),
                minScore: stakeRegistry.minScore(),
                gateAllowed: allowed,
                eligible: stakeRegistry.isEligible(id),
                gateReason: uint8(reason),
                staker: staker
            });
        }
    }

    /** @notice Protocol-wide constants the invariants depend on. */
    function config() external view returns (uint256 minStake, uint8 minScore, uint64 cooldown, address treasury) {
        return (stakeRegistry.minStake(), stakeRegistry.minScore(), stakeRegistry.suspensionCooldown(), stakeRegistry.treasury());
    }
}
