/**
 * Canonical-JSON behaviour of the scorer's own encoder, pinned against Python.
 *
 * `inputsHash` and `breakdownHash` are anchored on-chain as `breakdownHash` in
 * `postAvairaScore`/`ScorePosted`, and the contract *never* recomputes them: the anchor is worth
 * something only because an auditor can re-derive it from the published inputs. That makes this
 * serialisation part of the trust surface, and it is the exact class of bug found in the SDKs
 * (FINDINGS.md AV-013: two implementations of "the same" canonical JSON produced different bytes).
 *
 * Two facts this file pins down, because both are load-bearing and neither is obvious:
 *
 * 1. The scorer's encoding equals `python3 json.dumps(..., sort_keys=True, separators=(",",":"),
 *    ensure_ascii=False)` byte for byte, for every value shape `ScoreInputs` can hold. That is the
 *    target for whoever writes the auditor's re-derivation.
 * 2. The scorer's encoder is **not** the SDK's encoder (`@avaira/sdk`'s `canonicalJson`, which
 *    escapes non-ASCII and rejects floats/bigint). They hash different domains — an agent-authored
 *    plan vs. the scorer's own numeric inputs — and they are deliberately kept apart. If anyone
 *    "unifies" them, already-published `breakdownHash` anchors stop re-deriving, so the
 *    divergence below is asserted, not merely tolerated. See STATE.md (D-01) and SP-06.
 */
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, hashCanonical } from "../src/canonical.js";

/** Values `ScoreInputs` can actually hold: ids, 6-decimal USDC strings, timestamps, rates, free text. */
const VECTORS: unknown[] = [
  { agentId: "1", chainId: 143, minScore: 60, stakeUsdc: "100000000" },
  { nested: { b: 1, a: [{ z: true, y: null }, 2] } },
  { "0": "zero key", "10": "ten", "9": "nine" }, // lexicographic order, not numeric
  { list: [{ b: 1, a: 2 }, { d: 3, c: 4 }] },
  { reason: "café ☕ — 東京", empty: "" }, // slashEvents[].reason is free text
  { num: 1.5, neg: -0.25, zero: 0 },
  { trueish: true, falseish: false, nil: null },
  [],
  {},
];

const PYTHON_AVAILABLE = (() => {
  try {
    execFileSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
})();

function pythonSortedCompact(value: unknown): string {
  return execFileSync(
    "python3",
    [
      "-c",
      "import json,sys; print(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, separators=(',',':'), ensure_ascii=False))",
    ],
    { input: JSON.stringify(value), encoding: "utf8" },
  ).trim();
}

test("canonicalJson equals Python's sorted compact JSON (ensure_ascii=False)", { skip: !PYTHON_AVAILABLE && "python3 not on PATH" }, () => {
  let compared = 0;
  for (const vector of VECTORS) {
    assert.equal(canonicalJson(vector), pythonSortedCompact(vector), `diverged for ${JSON.stringify(vector)}`);
    compared++;
  }
  assert.equal(compared, VECTORS.length, "every vector must have been compared, none silently skipped");
});

test("key order never changes the bytes (the AV-013 failure mode)", () => {
  const a = { z: 1, a: [{ y: 2, x: 3 }], m: "s" };
  const b = { a: [{ x: 3, y: 2 }], m: "s", z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashCanonical(a), hashCanonical(b));
});

test("floats are rounded to 6dp so every language re-serialises identically", () => {
  assert.equal(canonicalJson({ n: 1 / 3 }), '{"n":0.333333}');
  assert.equal(canonicalJson({ n: 2 ** 53 }), '{"n":9007199254740992}');
  assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), /non-finite/);
});

test("bigint survives as a decimal string, and undefined members vanish", () => {
  // 6-decimal USDC amounts exceed 2^53, so this is the difference between an exact anchor and a lie.
  assert.equal(canonicalJson({ v: 12345678901234567n }), '{"v":"12345678901234567"}');
  assert.equal(canonicalJson({ v: 0n }), '{"v":"0"}');
  assert.equal(canonicalJson({ a: 1, b: undefined, c: null }), '{"a":1,"c":null}');
});

test("the SDK encoder is a different domain on purpose (documented, not accidental)", async () => {
  // Imported from source rather than the package entry point: the published `main` is
  // ./dist/index.js, and tests must not depend on a build step to run.
  const sdkUrl = new URL("../../../sdk/typescript/src/canonical.ts", import.meta.url).href;
  const sdk: { canonicalJson: (v: unknown) => string } = await import(sdkUrl);
  const value = { reason: "café" };
  // The scorer keeps non-ASCII; the SDK escapes it. Both are pinned by tests on their own side.
  assert.equal(canonicalJson(value), '{"reason":"café"}');
  assert.equal((sdk.canonicalJson as (v: unknown) => string)(value), '{"reason":"caf\\u00e9"}');
  assert.notEqual(canonicalJson(value), (sdk.canonicalJson as (v: unknown) => string)(value));
  // ...and they agree on everything an intent or a score input shares: pure ASCII keys and values.
  const ascii = { agentId: "7", taskId: "t-1", steps: ["web.search"] };
  assert.equal(canonicalJson(ascii), (sdk.canonicalJson as (v: unknown) => string)(ascii));
});
