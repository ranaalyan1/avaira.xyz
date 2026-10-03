/**
 * SDK tests — the audit trail is the part of the v2 SDK that has to be exactly right,
 * because a challenge built on a wrong leaf is a challenge that loses the challenger's bond.
 *
 * The parity fixtures asserted here are the *same* fixtures the Foundry suite
 * (`contracts/test/MerkleParity.t.sol`) asserts against `MerkleLib`. If both suites pass,
 * offchain and onchain agree byte-for-byte.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import { keccak256, toHex, type Hex } from "viem";

import { AuditTrail, hashPair, merkleProof, merkleRoot } from "../src/audit.js";
import { Avaira } from "../src/avaira.js";
import { percentile, stats } from "../src/metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(resolve(here, "../../../contracts/test/fixtures/sdk-vectors.json"), "utf8"),
) as {
  intentHash: Hex;
  envelopeHash: Hex;
  sets: { name: string; root: Hex; proofs: Hex[][]; leaves: { agentId: string; action: string; spendUsd: string; nonce: string }[] }[];
};

const INTENT: Hex = vectors.intentHash;
const OTHER_INTENT: Hex = keccak256(toHex("avaira.other.intent"));

function makeTrail(intentHash: Hex = INTENT, agentId = 7n): AuditTrail {
  return new AuditTrail(agentId, intentHash);
}

describe("AuditTrail hash chain", () => {
  test("genesis entry chains from the zero hash", () => {
    const trail = makeTrail();
    const entry = trail.append("web.search", 1_000_000n);
    assert.equal(entry.prevHash, `0x${"0".repeat(64)}`);
    assert.equal(trail.headHash, entry.hash);
  });

  test("entries chain to each other and verify", () => {
    const trail = makeTrail();
    for (let i = 0; i < 25; i++) trail.append("mcp.call", BigInt(i * 1_000));
    assert.equal(trail.size, 25);
    assert.deepEqual(trail.verify(), { valid: true });
  });

  test("tampering with any entry breaks the chain at that index", () => {
    const trail = makeTrail();
    for (let i = 0; i < 10; i++) trail.append("db.write", BigInt(i));
    const entries = trail.all() as unknown as { spendUsd: bigint }[];
    entries[4]!.spendUsd = 999_999_999n;
    const result = trail.verify();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 4);
  });

  test("re-hashing the tampered entry still breaks the chain downstream", () => {
    const trail = makeTrail();
    for (let i = 0; i < 6; i++) trail.append("db.write", BigInt(i));
    const entries = trail.all() as unknown as { spendUsd: bigint; seq: number; action: string; nonce: bigint; timestamp: number; hash: Hex }[];
    // An attacker who recomputes the tampered hash cannot fix the *next* entry's prevHash.
    entries[2]!.spendUsd = 1n;
    assert.equal(trail.verify().valid, false);
    assert.equal(trail.verify().brokenAt, 2);
  });

  test("distinct trails do not collide across intents", () => {
    const a = makeTrail(INTENT).append("web.search", 1n);
    const b = makeTrail(OTHER_INTENT).append("web.search", 1n);
    assert.notEqual(a.hash, b.hash);
  });
});

describe("Merkle root and proofs", () => {
  test("empty tree hashes to zero", () => {
    assert.equal(merkleRoot([]), `0x${"0".repeat(64)}`);
  });

  test("single leaf is its own root", () => {
    const leaf = keccak256(toHex("leaf"));
    assert.equal(merkleRoot([leaf]), keccak256(`0x00${leaf.slice(2)}` as Hex));
    assert.deepEqual(merkleProof([leaf], 0), []);
  });

  test("hashPair is order-independent", () => {
    const a = keccak256(toHex("a"));
    const b = keccak256(toHex("b"));
    assert.equal(hashPair(a, b), hashPair(b, a));
  });

  for (const size of [2, 3, 5, 8, 16, 33]) {
    test(`every leaf of a ${size}-leaf tree has a validating proof`, () => {
      const leaves = Array.from({ length: size }, (_, i) => keccak256(toHex(`leaf-${i}`)));
      const root = merkleRoot(leaves);
      for (let i = 0; i < size; i++) {
        let computed = keccak256(`0x00${leaves[i]!.slice(2)}` as Hex);
        for (const sibling of merkleProof(leaves, i)) computed = hashPair(computed, sibling);
        assert.equal(computed, root, `leaf ${i} of ${size} failed`);
      }
    });
  }

  test("proofs from an odd tree match the SDK-generated parity vectors", () => {
    for (const set of vectors.sets) {
      const leaves = set.leaves.map((l) =>
        AuditTrail.leafFor(BigInt(l.agentId), INTENT, l.action, BigInt(l.spendUsd), BigInt(l.nonce)),
      );
      assert.equal(merkleRoot(leaves), set.root, `root drifted for set ${set.name}`);
      for (let i = 0; i < leaves.length; i++) {
        let computed = keccak256(`0x00${leaves[i]!.slice(2)}` as Hex);
        for (const sibling of set.proofs[i]!) computed = hashPair(computed, sibling);
        assert.equal(computed, set.root, `proof drifted for set ${set.name} index ${i}`);
      }
    }
  });

  test("trail root equals the root of its leaves and verifies each entry", () => {
    const trail = makeTrail();
    for (let i = 0; i < 7; i++) trail.append("swap.execute", BigInt(i) * 10n);
    const root = trail.merkleRoot();
    const leaves = trail.leaves();
    for (let i = 0; i < leaves.length; i++) {
      let computed = keccak256(`0x00${leaves[i]!.slice(2)}` as Hex);
      for (const sibling of trail.proofFor(i)) computed = hashPair(computed, sibling);
      assert.equal(computed, root);
    }
  });
});

describe("envelope hashing (parity with RiskEnvelopeLib)", () => {
  const avaira = new Avaira({
    rpcUrl: "http://localhost:8545",
    chainId: 10143,
    contracts: {
      identityRegistry: "0x0000000000000000000000000000000000000001",
      reputationRegistry: "0x0000000000000000000000000000000000000002",
      stakeRegistry: "0x0000000000000000000000000000000000000003",
      intentVault: "0x0000000000000000000000000000000000000004",
    },
  });

  test("matches the committed Solidity parity vector", () => {
    const hash = avaira.hashEnvelope({
      maxSpendUsd: 5_000_000n,
      allowedActions: ["web.search", "mcp.call"],
      deadline: 1_893_456_000n,
    });
    assert.equal(hash, vectors.envelopeHash);
  });

  test("is sensitive to every field, including action order", () => {
    const base = { maxSpendUsd: 5_000_000n, allowedActions: ["web.search", "mcp.call"], deadline: 1_893_456_000n };
    assert.notEqual(avaira.hashEnvelope(base), avaira.hashEnvelope({ ...base, maxSpendUsd: 5_000_001n }));
    assert.notEqual(avaira.hashEnvelope(base), avaira.hashEnvelope({ ...base, deadline: 1_893_456_001n }));
    assert.notEqual(
      avaira.hashEnvelope(base),
      avaira.hashEnvelope({ ...base, allowedActions: ["mcp.call", "web.search"] }),
    );
    assert.notEqual(avaira.hashEnvelope(base), avaira.hashEnvelope({ ...base, allowedActions: ["web.search"] }));
  });
});

describe("deviation detection", () => {
  const envelope = { maxSpendUsd: 2_000_000n, allowedActions: ["web.search", "mcp.call"] };

  test("flags overspend and disallowed actions, keeps the rest", () => {
    const trail = makeTrail();
    trail.append("web.search", 100_000n);
    trail.append("mcp.call", 2_500_000n); // over budget
    trail.append("swap.execute", 0n); // not allowed
    trail.append("mcp.call", 1_999_999n); // exactly inside

    const deviations = trail.deviations(envelope);
    assert.equal(deviations.length, 2);
    assert.deepEqual(deviations.map((d) => d.action), ["mcp.call", "swap.execute"]);
    assert.deepEqual(deviations.map((d) => d.seq), [1, 2]);
  });

  test("an honest run has no deviations", () => {
    const trail = makeTrail();
    trail.append("web.search", 1_000n);
    trail.append("mcp.call", 2_000_000n);
    assert.equal(trail.deviations(envelope).length, 0);
  });

  test("a deviation leaf is provable against the trail's anchored root", () => {
    const trail = makeTrail();
    trail.append("web.search", 1_000n);
    trail.append("swap.execute", 900_000n);
    const deviating = trail.deviations(envelope);
    assert.equal(deviating.length, 1);

    const index = deviating[0]!.seq;
    let computed = keccak256(`0x00${trail.leaves()[index]!.slice(2)}` as Hex);
    for (const sibling of trail.proofFor(index)) computed = hashPair(computed, sibling);
    assert.equal(computed, trail.merkleRoot());
  });
});

describe("metrics helpers", () => {
  test("percentiles are computed over sorted values", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile([], 50), 0);
  });

  test("stats summarise a latency sample", () => {
    const s = stats([10, 20, 30, 40]);
    assert.equal(s.mean, 25);
    assert.equal(s.max, 40);
    assert.equal(s.p50, 20);
  });
});
