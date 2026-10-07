/**
 * The score formula's own invariants (INV-REP-03 and friends).
 *
 * Cheap tests, but they are the properties every downstream consumer assumes: a score is an
 * integer-ish 0–100, the six components are *exactly* enough to reach 100 and no more, the
 * attached grade is the on-chain grade, misconduct decays instead of accumulating forever, and
 * an audit can never zero an agent out.
 *
 * Why "no more than 100" matters: `postAvairaScore(uint8)` accepts anything up to 255, so an
 * over-summing weight table would be accepted by the contract and would silently invalidate
 * every band comparison. The grade table itself is pinned against the contract in
 * `grade-parity.test.ts` (see FINDINGS.md AV-009).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeCaps, computeScore, consistencySpread, decayedSlashPenalty, gradeForScore, MAX_AUDIT_PENALTY, weights } from "../src/formula.js";
import { WEIGHTS, type ScoreInputs } from "../src/types.js";

const NOW = 1_700_008_640;

function inputs(patch: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    agentId: "1",
    chainId: 143,
    registeredAt: NOW - 90 * 86_400,
    status: 2,
    stakeUsdc: "100000000",
    minStakeUsdc: "100000000",
    minScore: 60,
    intentsCommitted: 100,
    outcomesAttested: 100,
    deviationsUpheld: 0,
    challengesRejected: 0,
    attestedIntents: Array.from({ length: 100 }, (_, i) => ({ intentHash: `0x${i}`, at: NOW - i * 3600, deviated: false })),
    slashEvents: [],
    gateAllows: 100,
    gateBlocks: 0,
    gateLatencyMsAvg: 240,
    feedbackCount: 12,
    feedbackUniqueReviewers: 12,
    feedbackValues: [92, 95, 88, 90],
    volumeUsd: "25000000",
    validationCount: 9,
    validationAverageResponse: 95,
    appealCases: 0,
    appealWins: 0,
    fromBlock: "0x0",
    toBlock: "0x1000",
    ...patch,
  };
}

test("the six weights sum to exactly 100 points (INV-REP-03)", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100, `weights must sum to 100 so a perfect agent scores exactly 100, got ${sum}`);
  assert.deepEqual(Object.keys(weights()).sort(), Object.keys(WEIGHTS).sort(), "weights() must expose exactly WEIGHTS");
});

test("the ceiling is under 100 by construction, and A+ is still reachable", () => {
  // Every component is smoothed toward a prior (Laplace) or seeded with one, so a *finite* agent
  // can never collect all 100 points: the maximum reachable score is 30+20+20+15+10+2.5 = 97.5.
  // Worth pinning because dashboards and README prose say "0–100", and a consumer that treats
  // `score === 100` as "flawless" would never fire — while `A+ ≥ 90` does.
  const flawless = inputs({ volumeUsd: "1000000000000", outcomesAttested: 10_000, intentsCommitted: 10_000 });
  const r = computeScore(flawless, NOW);
  assert.deepEqual(computeCaps(flawless, NOW), [], "the flawless agent must trip no cap");
  assert.ok(r.score > 90 && r.score < 100, `expected a score in (90,100), got ${r.score}`);
  assert.equal(r.grade, "A+");
  const sum = r.components.reduce((a, c) => a + c.max, 0);
  assert.equal(sum, 100, "the component maxima must still sum to 100");
  assert.ok(r.components.every((c) => c.points <= c.max));
});

test("an unestablished agent cannot reach the gate floor", () => {
  const blank = computeScore(
    inputs({
      status: 0,
      stakeUsdc: "0",
      registeredAt: NOW,
      intentsCommitted: 0,
      outcomesAttested: 0,
      attestedIntents: [],
      feedbackCount: 0,
      feedbackUniqueReviewers: 0,
      feedbackValues: [],
      volumeUsd: "0",
      validationCount: 0,
      validationAverageResponse: 0,
      gateAllows: 0,
    }),
    NOW,
  );
  const caps = computeCaps(
    inputs({ status: 0, stakeUsdc: "0", attestedIntents: [], intentsCommitted: 0, outcomesAttested: 0 }),
    NOW,
  );
  assert.ok(caps.some((c) => c.rule === "stake-below-minimum"), "under-staking must be capped, not merely penalised");
  assert.ok(blank.score < 60, `a fresh agent must sit below the C floor, got ${blank.score}`);
});

test("computeScore is total and bounded over adversarial inputs", () => {
  const nasty: Partial<ScoreInputs>[] = [
    { status: 4 },
    { status: 3, slashEvents: [{ level: 3, at: NOW, reason: "ban", amountUsdc: "100000000" }] },
    { stakeUsdc: "0", minStakeUsdc: "100000000" },
    { intentsCommitted: 1000, outcomesAttested: 0 },
    { deviationsUpheld: 500, outcomesAttested: 1 }, // more deviations than outcomes
    { challengesRejected: -5 },
    { feedbackValues: [] },
    { feedbackValues: [1e9, -1e9, NaN] },
    { volumeUsd: "-1" },
    { appealCases: 1, appealWins: 99 }, // won > filed: impossible
    { registeredAt: null },
    { attestedIntents: Array.from({ length: 50 }, (_, i) => ({ intentHash: `0x${i}`, at: NOW - i * 86_400, deviated: i % 7 === 0 })) },
    { gateLatencyMsAvg: -1 },
  ];
  for (const patch of nasty) {
    const r = computeScore(inputs(patch), NOW);
    assert.ok(Number.isFinite(r.score), `score must stay finite for ${JSON.stringify(patch)}`);
    assert.ok(r.score >= 0 && r.score <= 100, `score out of [0,100] (${r.score}) for ${JSON.stringify(patch)}`);
    assert.equal(r.grade, gradeForScore(r.score), "the attached grade must match the score");
    assert.equal(r.components.length, Object.keys(WEIGHTS).length, "one row per weight");
    for (const c of r.components) {
      assert.ok(c.points >= 0 && c.points <= c.max, `component ${c.key}=${c.points} outside [0,${c.max}]`);
    }
  }
});

test("slash penalties decay monotonically and never go negative", () => {
  const at = (daysAgo: number) => NOW - daysAgo * 86_400;
  const fresh = decayedSlashPenalty([{ level: 3, at: at(0) }], NOW);
  const year = decayedSlashPenalty([{ level: 3, at: at(365) }], NOW);
  const future = decayedSlashPenalty([{ level: 3, at: NOW + 86_400 }], NOW);
  assert.ok(fresh > year, "a fresh slash must hurt more than a year-old one");
  assert.ok(year >= 0 && future >= 0, "penalties must never be negative");
  assert.ok(future <= fresh + 1e-9, "a timestamp in the future must not be rewarded (age is clamped at 0)");
  const ladder = [0, 1, 2, 3].map((level) => decayedSlashPenalty([{ level, at: NOW }], NOW));
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i]! >= ladder[i - 1]!, "higher severity must never hurt less");
});

test("the audit penalty is clamped into [0, MAX_AUDIT_PENALTY]", () => {
  const base = computeScore(inputs(), NOW).score;
  assert.equal(computeScore(inputs(), NOW, 1e9).penalty, MAX_AUDIT_PENALTY, "an absurd penalty must be clamped");
  assert.equal(computeScore(inputs(), NOW, -50).penalty, 0, "a negative penalty must be ignored, not banked");
  assert.equal(computeScore(inputs(), NOW, 1e9).score, base - MAX_AUDIT_PENALTY);
});

test("consistencySpread refuses to fabricate a value from too little data", () => {
  assert.equal(consistencySpread([]), null);
  assert.equal(consistencySpread([{ at: 1, deviated: false }]), null);
  const spread = consistencySpread(Array.from({ length: 12 }, (_, i) => ({ at: NOW - i * 86_400, deviated: i % 3 === 0 })), 4);
  assert.ok(spread !== null && spread >= 0 && spread <= 1, `spread must be a rate in [0,1], got ${spread}`);
  const flawless = consistencySpread(Array.from({ length: 12 }, (_, i) => ({ at: NOW - i * 86_400, deviated: false })), 4);
  assert.equal(flawless, 0, "no deviations means no spread");
});
