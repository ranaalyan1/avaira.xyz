/**
 * Grade-band parity: the scorer service and the chain must never disagree.
 *
 * `AvairaReputationRegistry.gradeOfScore` is what any contract on Monad reads;
 * `gradeForScore` is what our API and dashboard render. They are two implementations of the
 * same promise, and the only thing keeping them honest is this test — so the expected table is
 * *parsed out of the Solidity source* rather than copied. Change the bands in the contract
 * without changing the scorer and this fails, which is the point.
 *
 * Context: FINDINGS.md AV-009.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { gradeForScore } from "../src/formula.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOLIDITY = join(REPO_ROOT, "contracts", "src", "core", "AvairaReputationRegistry.sol");

/** @returns {[minScore, grade][]} exactly as the onchain function reads, highest band first. */
function onchainBands(): [number, string][] {
  const source = readFileSync(SOLIDITY, "utf8");
  const start = source.indexOf("function gradeOfScore(uint8 score)");
  assert.ok(start >= 0, "gradeOfScore(uint8 score) not found in the contract — did it get renamed?");
  // Bound the slice to the function body: an unbounded slice would let a later function's
  // `return "…"` be mistaken for this one's fallback grade.
  const end = source.indexOf("\n    }", start);
  const body = source.slice(start, end > start ? end : undefined);
  const bands = [...body.matchAll(/if \(score >= (\d+)\) return "([^"]+)";/g)].map((m) => [Number(m[1]), m[2]] as [number, string]);
  const returns = [...body.matchAll(/return "([^"]+)";/g)];
  const fallback = returns.at(-1);
  assert.ok(fallback, "gradeOfScore must end with a fallback grade");
  assert.ok(bands.length >= 2, `parsed ${bands.length} bands from the contract — did gradeOfScore change shape?`);
  bands.push([0, fallback[1]!]);
  return bands;
}

function chainGrade(score: number): string {
  for (const [min, grade] of onchainBands()) if (score >= min) return grade;
  return "D";
}

test("every score 0-100 grades identically in the scorer and in the contract", () => {
  const mismatches: string[] = [];
  for (let score = 0; score <= 100; score++) {
    if (gradeForScore(score) !== chainGrade(score)) mismatches.push(`${score}: scorer=${gradeForScore(score)} chain=${chainGrade(score)}`);
  }
  assert.deepEqual(mismatches, [], `grade bands drifted apart:\n  ${mismatches.join("\n  ")}`);
});

test("the parsed contract table is monotonic and covers 0-100", () => {
  const bands = onchainBands();
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i - 1]![0] > bands[i]![0], "bands must be listed high to low with no duplicates");
  }
  assert.equal(bands.at(-1)![0], 0, "the last band must start at 0");
  assert.ok(new Set(bands.map((b) => b[1])).size === bands.length, "grades must be unique");
});

test("the gate floor is a C or better, per the contract's own comment", () => {
  // `minScore` defaults to 60 in script/Deploy.s.sol and `C` starts at 60 onchain.
  assert.equal(chainGrade(60), "C");
  assert.equal(gradeForScore(60), "C");
  assert.equal(chainGrade(59), "D");
  assert.equal(gradeForScore(59), "D");
});
