/**
 * Generates cross-language parity vectors for the audit trail.
 *
 * The claim Avaira makes is strong: a leaf produced by this TypeScript SDK can be handed
 * to `AvairaIntentVault.challengeDeviation` (Solidity) and verified against a root the
 * agent anchored onchain. That only holds if the two implementations agree byte-for-byte,
 * so we generate vectors here, commit them, and assert them from Solidity in
 * `contracts/test/MerkleParity.t.sol`.
 *
 *   npm run vectors
 *
 * Emits:
 *   contracts/test/fixtures/SdkVectors.sol   — consumed by the Foundry parity test
 *   contracts/test/fixtures/sdk-vectors.json — human/dashboard reference copy
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, type Hex } from "viem";

import { AuditTrail, merkleProof, merkleRoot } from "../src/audit.js";
import { Avaira } from "../src/avaira.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../contracts/test/fixtures");

interface VectorLeaf {
  agentId: bigint;
  intentHash: Hex;
  action: string;
  spendUsd: bigint;
  nonce: bigint;
}

interface VectorSet {
  name: string;
  leaves: VectorLeaf[];
  rawLeaves: Hex[];
  root: Hex;
  proofs: Hex[][];
}

const INTENT_HASH = keccak256(toHex("avaira.parity.intent.v1"));
const AGENT_ID = 7n;
const ACTIONS = ["web.search", "mcp.call", "swap.execute", "email.send", "db.write"];

/** Deterministic pseudo-random generator so vectors never churn between runs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function buildSet(name: string, size: number, seed: number): VectorSet {
  const random = lcg(seed);
  const leaves: VectorLeaf[] = [];
  for (let i = 0; i < size; i++) {
    leaves.push({
      agentId: AGENT_ID,
      intentHash: INTENT_HASH,
      action: ACTIONS[random() % ACTIONS.length]!,
      spendUsd: BigInt((random() % 5_000_000) + 1),
      nonce: BigInt(i),
    });
  }
  const rawLeaves = leaves.map((l) =>
    AuditTrail.leafFor(l.agentId, l.intentHash, l.action, l.spendUsd, l.nonce),
  );
  return {
    name,
    leaves,
    rawLeaves,
    root: merkleRoot(rawLeaves),
    proofs: rawLeaves.map((_, i) => merkleProof(rawLeaves, i)),
  };
}

/**
 * Emits the vectors as a pure-Solidity library so the Foundry test needs no JSON parsing.
 * Deliberately uses explicit field assignments rather than array literals — this file is
 * machine-written, so it should be the most boring, impossible-to-misparse Solidity there is.
 */
function solidityLibrary(sets: VectorSet[], envelopeHash: Hex): string {
  const setsSource = sets
    .map((set, s) => {
      const lines: string[] = [];
      lines.push(`        out[${s}].name = "${set.name}";`);

      lines.push(`        out[${s}].leaves = new Leaf[](${set.leaves.length});`);
      set.leaves.forEach((l, i) => {
        lines.push(
          `        out[${s}].leaves[${i}] = Leaf(${l.agentId}, ${l.intentHash}, "${l.action}", ${l.spendUsd}, ${l.nonce});`,
        );
      });

      lines.push(`        out[${s}].rawLeaves = new bytes32[](${set.rawLeaves.length});`);
      set.rawLeaves.forEach((h, i) => {
        lines.push(`        out[${s}].rawLeaves[${i}] = ${h};`);
      });

      lines.push(`        out[${s}].root = ${set.root};`);

      lines.push(`        out[${s}].proofs = new bytes32[][](${set.proofs.length});`);
      set.proofs.forEach((proof, i) => {
        if (proof.length > 0) {
          lines.push(`        out[${s}].proofs[${i}] = new bytes32[](${proof.length});`);
          proof.forEach((p, j) => {
            lines.push(`        out[${s}].proofs[${i}][${j}] = ${p};`);
          });
        } else {
          // Keep a zero-length array so `proofs.length` still matches `leaves.length`.
          lines.push(`        out[${s}].proofs[${i}] = new bytes32[](0);`);
        }
      });

      return lines.join("\n");
    })
    .join("\n");

  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ┌────────────────────────────────────────────────────────────────────────────────────┐
// │  GENERATED FILE — do not edit by hand.                                             │
// │  Regenerate with:  cd sdk/typescript && npm run vectors                            │
// │                                                                                    │
// │  Produced by the TypeScript SDK (@avaira/sdk), consumed by                         │
// │  contracts/test/MerkleParity.t.sol. Proves the offchain audit trail is admissible  │
// │  onchain: identical leaf encoding, identical sorted-pair tree, identical roots.    │
// └────────────────────────────────────────────────────────────────────────────────────┘

/// @notice Parity vectors for the SDK↔Solidity audit-trail commitment.
library SdkVectors {
    struct Leaf {
        uint256 agentId;
        bytes32 intentHash;
        string action;
        uint256 spendUsd;
        uint256 nonce;
    }

    struct Set {
        string name;
        Leaf[] leaves;
        bytes32[] rawLeaves;
        bytes32 root;
        bytes32[][] proofs;
    }

    /// @notice Number of vector sets.
    function setCount() internal pure returns (uint256) {
        return ${sets.length};
    }

    /// @notice Every vector set: leaves, their SDK-computed leaf hashes, root and proofs.
    function sets() internal pure returns (Set[] memory out) {
        out = new Set[](${sets.length});
        uint256 i;
${setsSource}
    }

    /// @notice A risk envelope and the SDK's EIP-712-style hash of it.
    function envelope() internal pure returns (uint256 maxSpendUsd, string[] memory allowedActions, uint64 deadline, bytes32 expectedHash) {
        maxSpendUsd = 5000000;
        deadline = 1893456000;
        allowedActions = new string[](2);
        allowedActions[0] = "web.search";
        allowedActions[1] = "mcp.call";
        expectedHash = ${envelopeHash};
    }

}
`;
}

function main(): void {
  const sets = [
    buildSet("single", 1, 1),
    buildSet("pair", 2, 2),
    buildSet("odd-three", 3, 3),
    buildSet("odd-five", 5, 5),
    buildSet("even-eight", 8, 8),
  ];

  const offchain = new Avaira({
    rpcUrl: "http://localhost:8545",
    chainId: 10143,
    contracts: {
      identityRegistry: "0x0000000000000000000000000000000000000001",
      reputationRegistry: "0x0000000000000000000000000000000000000002",
      stakeRegistry: "0x0000000000000000000000000000000000000003",
      intentVault: "0x0000000000000000000000000000000000000004",
    },
  });
  const envelopeHash = offchain.hashEnvelope({
    maxSpendUsd: 5_000_000n,
    allowedActions: ["web.search", "mcp.call"],
    deadline: 1_893_456_000n,
  });

  mkdirSync(fixtures, { recursive: true });
  writeFileSync(resolve(fixtures, "SdkVectors.sol"), solidityLibrary(sets, envelopeHash));
  writeFileSync(
    resolve(fixtures, "sdk-vectors.json"),
    `${JSON.stringify(
      {
        generatedBy: "@avaira/sdk scripts/gen-parity-vectors.ts",
        intentHash: INTENT_HASH,
        envelopeHash,
        sets: sets.map((s) => ({
          name: s.name,
          root: s.root,
          leaves: s.leaves.map((l) => ({
            agentId: l.agentId.toString(),
            action: l.action,
            spendUsd: l.spendUsd.toString(),
            nonce: l.nonce.toString(),
          })),
          proofs: s.proofs,
        })),
      },
      null,
      2,
    )}\n`,
  );

  for (const set of sets) console.log(`  ${set.name.padEnd(12)} ${set.leaves.length} leaves → root ${set.root}`);
  console.log(`  envelope hash ${envelopeHash}`);
  console.log(`wrote ${fixtures}/SdkVectors.sol + sdk-vectors.json`);
}

main();
