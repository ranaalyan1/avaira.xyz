/**
 * Avaira Score — deterministic formula tests.
 *
 * These are the claims the README makes about the score, asserted in code: Laplace
 * smoothing for small samples, decayed slash penalties, measured (not assumed)
 * consistency, log-scaled volume, age saturation, eligibility caps that can only lower a
 * score, and byte-identical results for identical inputs on any machine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashCanonical, canonicalJson } from "../src/canonical.js";
import {
  MAX_AUDIT_PENALTY,
  computeCaps,
  computeScore,
  consistencySpread,
  decayedSlashPenalty,
  gradeForScore,
  smoothedRate,
  weights,
} from "../src/formula.js";
import { WEIGHTS, type ScoreInputs } from "../src/types.js";

const DAY = 86_400;
const NOW = 1_800_000_000; // fixed clock — nothing here may depend on wall time

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  const base: ScoreInputs = {
    agentId: "1",
    chainId: 10143,
    registeredAt: NOW - 60 * DAY,
    status: 2, // ACTIVE
    stakeUsdc: "150000000", // 150 USDC
    minStakeUsdc: "100000000",
    minScore: 60,
    intentsCommitted: 0,
    outcomesAttested: 0,
    deviationsUpheld: 0,
    challengesRejected: 0,
    attestedIntents: [],
    slashEvents: [],
    gateAllows: 0,
    gateBlocks: 0,
    gateLatencyMsAvg: 41,
    feedbackCount: 0,
    feedbackUniqueReviewers: 0,
    feedbackValues: [],
    volumeUsd: "0",
    validationCount: 0,
    validationAverageResponse: 0,
    appealCases: 0,
    appealWins: 0,
    fromBlock: "0",
    toBlock: "1",
  };
  return { ...base, ...overrides };
}

const attested = (n: number, deviated = 0) =>
  Array.from({ length: n }, (_, i) => ({
    intentHash: `0x${i.toString(16).padStart(2, "0")}`,
    at: NOW - (n - i) * DAY,
    deviated: i >= n - deviated,
  }));

/* ── grades ───────────────────────────────────────────────────────────────── */

test("grade bands cover the full 0–100 range and are monotonic", () => {
  assert.equal(gradeForScore(100), "A+");
  assert.equal(gradeForScore(95), "A+");
  assert.equal(gradeForScore(94.99), "A");
  assert.equal(gradeForScore(85), "A-");
  assert.equal(gradeForScore(84.99), "B+");
  assert.equal(gradeForScore(70), "B-");
  assert.equal(gradeForScore(60), "C");
  assert.equal(gradeForScore(59.99), "C-");
  assert.equal(gradeForScore(55), "C-");
  assert.equal(gradeForScore(54.99), "D");
  assert.equal(gradeForScore(0), "D");
});

/* ── smoothing ────────────────────────────────────────────────────────────── */

test("Laplace smoothing stops one lucky run from outranking a thousand", () => {
  // A brand-new agent with no history lands on the prior, not on 0 and not on 1.
  assert.equal(smoothedRate(0, 0, 0.75, 8), 0.75);
  const oneRun = smoothedRate(1, 1, 0.75, 8);
  const thousandRuns = smoothedRate(1000, 1000, 0.75, 8);
  assert.ok(oneRun < thousandRuns, `${oneRun} should be < ${thousandRuns}`);
  assert.ok(oneRun < 0.98, "small samples must stay honest");
  assert.ok(thousandRuns > 0.99);
});

test("smoothedRate clamps nonsense inputs instead of inventing trust", () => {
  assert.equal(smoothedRate(-5, -5, 0.5, 4), 0.5); // both clamp to zero attempts → the prior
  assert.equal(smoothedRate(10, 2, 0.5, 4), smoothedRate(2, 2, 0.5, 4)); // successes cannot exceed attempts
});

/* ── slashing decay ───────────────────────────────────────────────────────── */

test("slash penalties decay with a 45-day half-life but never vanish", () => {
  const banned = [{ level: 3, at: NOW }];
  assert.equal(decayedSlashPenalty(banned, NOW), 20);
  assert.equal(decayedSlashPenalty(banned, NOW + 45 * DAY), 10);
  assert.equal(decayedSlashPenalty(banned, NOW + 90 * DAY), 5);
  assert.ok(decayedSlashPenalty(banned, NOW + 365 * DAY) > 0, "history never fully disappears");
  assert.equal(decayedSlashPenalty([{ level: 0, at: NOW }], NOW), 0, "NONE is not a penalty");
  assert.equal(decayedSlashPenalty([{ level: 3, at: NOW + 10 * DAY }], NOW), 20, "future timestamps clamp to age 0");
});

/* ── consistency ──────────────────────────────────────────────────────────── */

test("consistency is measured across windows, and needs a sample to say anything", () => {
  assert.equal(consistencySpread(attested(3)), null, "under 4 outcomes → no verdict");
  assert.equal(consistencySpread(attested(8)), 0, "uniform success → zero spread");
  // Four clean outcomes, then four deviations — the second half of the agent's life is bad.
  const erratic = Array.from({ length: 8 }, (_, i) => ({
    intentHash: `0x${i.toString(16)}`,
    at: NOW - (8 - i) * DAY,
    deviated: i >= 4,
  }));
  const spread = consistencySpread(erratic);
  assert.ok(spread !== null && spread > 0.5, `erratic agent must show spread, got ${spread}`);
});

/* ── components, caps and determinism ─────────────────────────────────────── */

test("a flawless, seasoned, well-staked agent earns an uncapped top grade", () => {
  const result = computeScore(
    inputs({
      intentsCommitted: 40,
      outcomesAttested: 40,
      attestedIntents: attested(40),
      volumeUsd: "1000000000000", // $1,000,000 settled → full VolumeHandled marks
      appealCases: 4,
      appealWins: 4,
    }),
    NOW,
  );
  assert.deepEqual(result.caps, []);
  assert.equal(result.grade, "A+");
  assert.ok(result.score >= 95, `expected ≥95, got ${result.score}`);
});

test("stake below the protocol minimum caps the score, and staking more never grants points", () => {
  const history = {
    intentsCommitted: 40,
    outcomesAttested: 40,
    attestedIntents: attested(40),
    volumeUsd: "1000000000000",
  };
  const rich = computeScore(inputs({ ...history, stakeUsdc: "100000000000" }), NOW);
  const underStaked = computeScore(inputs({ ...history, stakeUsdc: "1000" }), NOW);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  assert.equal(rich.score, round2(underStaked.subtotal), "extra collateral adds no points");
  assert.ok(underStaked.caps.some((c) => c.rule === "stake-below-minimum"));
  assert.ok(underStaked.score <= 59, "under-staked agents are gated out");
  assert.ok(underStaked.score >= 0);
  assert.equal(underStaked.grade, "C-");
});

test("a banned agent scores 0 and no amount of history lifts the cap", () => {
  const result = computeScore(
    inputs({
      status: 4,
      intentsCommitted: 500,
      outcomesAttested: 500,
      attestedIntents: attested(100),
      volumeUsd: "5000000000000",
    }),
    NOW,
  );
  assert.equal(result.caps[0]?.rule, "banned");
  assert.equal(result.score, 0);
  assert.equal(result.grade, "D");
});

test("a deviation in the last 24h caps the agent below the gate floor", () => {
  const recent = attested(6, 1).map((a, i) => (i === 5 ? { ...a, at: NOW - 3600 } : a));
  const caps = computeCaps(inputs({ intentsCommitted: 6, outcomesAttested: 6, attestedIntents: recent }), NOW);
  assert.ok(caps.some((c) => c.rule === "recent-deviation"));
});

test("the adversarial audit penalty is bounded and can only lower the score", () => {
  const base = inputs({ intentsCommitted: 40, outcomesAttested: 40, attestedIntents: attested(40) });
  const clean = computeScore(base, NOW);
  const audited = computeScore(base, NOW, 1000); // way over the cap
  assert.equal(audited.penalty, MAX_AUDIT_PENALTY);
  assert.equal(clean.penalty, 0);
  assert.ok(audited.score < clean.score);
  assert.equal(computeScore(base, NOW, -50).penalty, 0, "a penalty can never be a bonus");
});

test("identical inputs produce byte-identical results on any machine", () => {
  const sample = inputs({
    intentsCommitted: 12,
    outcomesAttested: 11,
    deviationsUpheld: 1,
    attestedIntents: attested(12, 1),
    slashEvents: [{ level: 1, at: NOW - 10 * DAY, reason: "envelope violation", amountUsdc: "10000000" }],
    volumeUsd: "250000000",
    appealCases: 1,
  });
  const a = computeScore(sample, NOW);
  const b = computeScore(sample, NOW);
  assert.deepEqual(a, b);
  assert.equal(hashCanonical(sample), hashCanonical(sample));
  assert.equal(canonicalJson(sample), canonicalJson(sample));
  // Two runs of the *whole* scorer must agree once the clock is pinned.
  const later = computeScore(sample, NOW + 7 * DAY);
  assert.ok(later.score >= a.score, "decaying penalties and ageing can only help, never hurt");
  assert.ok(later.score - a.score < 1 + MAX_AUDIT_PENALTY, "and only slightly");
});

test("weights are the published formula and sum to 100", () => {
  const w = weights();
  assert.deepEqual(w, WEIGHTS);
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
});

test("an unknown agent with no history scores low but is not fabricated into a pass", () => {
  const result = computeScore(
    inputs({ registeredAt: null, status: 0, stakeUsdc: "0", volumeUsd: "0" }),
    NOW,
  );
  const byKey = Object.fromEntries(result.components.map((c) => [c.key, c]));
  assert.equal(byKey.ageOnNetwork?.points, 0, "unregistered agents earn no age points");
  assert.ok(result.score < 60, "no history must not clear the gate floor");
  assert.ok(result.score > 0, "and the prior is not zero either");
});
