/**
 * Determinism and cap behaviour of the Avaira Score formula.
 *
 * The scorer on this branch ships the pure formula module (the reader/CLI lives elsewhere), so
 * this suite pins the properties the dashboard and the on-chain score depend on: the same
 * inputs always produce the same score, slashes fade instead of vanishing, small samples are
 * smoothed, and eligibility caps are caps — not something stake can buy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCaps,
  computeComponents,
  computeScore,
  consistencySpread,
  decayedSlashPenalty,
  gradeForScore,
  smoothedRate,
} from "../src/formula.js";
import type { ScoreInputs } from "../src/types.js";

const NOW = 1_760_000_000;

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  const attested = [
    { intentHash: `0x${"11".repeat(32)}`, at: NOW - 3_600, deviated: false },
    { intentHash: `0x${"22".repeat(32)}`, at: NOW - 7_200, deviated: false },
    { intentHash: `0x${"33".repeat(32)}`, at: NOW - 10_800, deviated: true },
    { intentHash: `0x${"44".repeat(32)}`, at: NOW - 14_400, deviated: false },
    { intentHash: `0x${"55".repeat(32)}`, at: NOW - 18_000, deviated: false },
    { intentHash: `0x${"66".repeat(32)}`, at: NOW - 21_600, deviated: false },
    { intentHash: `0x${"77".repeat(32)}`, at: NOW - 25_200, deviated: false },
    { intentHash: `0x${"88".repeat(32)}`, at: NOW - 28_800, deviated: false },
  ];
  return {
    agentId: "1",
    chainId: 10143,
    registeredAt: NOW - 40 * 86_400,
    status: 2,
    stakeUsdc: "100000000",
    minStakeUsdc: "100000000",
    minScore: 60,
    intentsCommitted: 10,
    outcomesAttested: 8,
    deviationsUpheld: 1,
    challengesRejected: 0,
    attestedIntents: attested,
    slashEvents: [],
    gateAllows: 9,
    gateBlocks: 1,
    gateLatencyMsAvg: 210,
    feedbackCount: 3,
    feedbackUniqueReviewers: 3,
    feedbackValues: [80, 90, 85],
    volumeUsd: "250000000",
    validationCount: 2,
    validationAverageResponse: 4,
    appealCases: 2,
    appealWins: 1,
    fromBlock: "1",
    toBlock: "1000",
    ...overrides,
  };
}

test("the same inputs produce the same score and breakdown", () => {
  const a = computeScore(inputs(), NOW);
  const b = computeScore(inputs(), NOW);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.components, b.components);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.grade, gradeForScore(a.score));
});

test("a stake below the protocol minimum caps the agent out of eligibility", () => {
  const thin = inputs({ stakeUsdc: "1000000" });
  const caps = computeCaps(thin, NOW);
  const stakeCap = caps.find((cap) => cap.rule === "stake-below-minimum");
  assert.ok(stakeCap, "the stake cap must be reported");
  assert.ok(stakeCap!.cap < 60, `the cap must block eligibility, got ${stakeCap!.cap}`);
  assert.match(stakeCap!.reason, /minimum/);
});

test("a banned agent is capped to zero and a suspended one below the floor", () => {
  assert.equal(computeCaps(inputs({ status: 4 }), NOW)[0].cap, 0);
  const suspended = computeCaps(inputs({ status: 3 }), NOW)[0];
  assert.equal(suspended.rule, "suspended");
  assert.ok(suspended.cap < 60);
});

test("an upheld deviation within 24h caps the score", () => {
  const caps = computeCaps(inputs(), NOW);
  assert.ok(caps.some((cap) => cap.rule === "recent-deviation"));
});

test("slashes decay with the configured half-life", () => {
  const fresh = decayedSlashPenalty([{ level: 2, at: NOW - 60 }], NOW);
  const old = decayedSlashPenalty([{ level: 2, at: NOW - 90 * 86_400 }], NOW);
  assert.ok(fresh > old, "a recent slash must weigh more than an old one");
  assert.ok(old > 0, "a slash never fully disappears");
});

test("Laplace smoothing keeps small samples near the prior", () => {
  const tiny = smoothedRate(1, 1, 0.75, 4);
  const large = smoothedRate(900, 1_000, 0.75, 4);
  assert.ok(tiny < large, "one lucky run must not outrank a thousand");
  assert.ok(tiny > 0.75 && tiny < 0.9);
});

test("grades step down monotonically", () => {
  const grades = [100, 80, 60, 40, 10].map(gradeForScore);
  assert.ok(new Set(grades).size >= 4, "the ladder must distinguish bands");
  const ordered = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"];
  const indices = grades.map((grade) => ordered.indexOf(grade));
  assert.ok(indices.every((index) => index >= 0), `unknown grade in ${grades.join(", ")}`);
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], "grades must not improve as the score drops");
  }
});

test("consistency is undefined without enough windows of history", () => {
  assert.equal(consistencySpread([]), null);
  assert.equal(consistencySpread([{ at: NOW, deviated: false }]), null);
  assert.equal(typeof consistencySpread(inputs().attestedIntents), "number");
});

test("every component reports points inside its own weight", () => {
  for (const component of computeComponents(inputs(), NOW)) {
    assert.ok(component.points >= 0, `${component.key} points must be non-negative`);
    assert.ok(component.points <= component.max + 1e-9, `${component.key} exceeded its weight`);
    assert.ok(component.detail.length > 0, `${component.key} needs a human-readable justification`);
  }
});
