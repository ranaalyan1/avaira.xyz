/**
 * Offline suite for the Qwen agent: planning, envelope enforcement, the gate seam, and the
 * audit trail the deviation scenario depends on. No network, no LLM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditTrail } from "@avaira/sdk";
import { concatHex, keccak256 } from "viem";

import { QwenAgent, checkEnvelope, ALLOWED_ACTIONS } from "../src/agent.js";
import { SimulatedGate } from "../src/gate.js";
import { OfflinePlanner, formatUsd, makePlanner, parsePlan, toUsdc } from "../src/qwen.js";
import { readBalances, settle, swapUsdcToCva, treasuryTools } from "../src/tools.js";

const zero = "0x0000000000000000000000000000000000000000" as const;

function agent(options: {
  planner?: OfflinePlanner;
  gate?: SimulatedGate;
  budgetUsd?: bigint;
  tools?: ReturnType<typeof treasuryTools>;
}) {
  return new QwenAgent({
    planner: options.planner ?? new OfflinePlanner(),
    gate: options.gate ?? new SimulatedGate({ score: 78, status: "active", cviValid: true }),
    tools: options.tools ?? treasuryTools({}, zero),
    task: "rebalance the reserve",
    budgetUsd: options.budgetUsd ?? 1_000n * 1_000_000n,
    log: () => {},
  });
}

/* ─────────────────────────────────── parsing ────────────────────────────────── */

test("toUsdc scales decimals and passes through micro-units", () => {
  assert.equal(toUsdc("1"), 1_000_000n);
  assert.equal(toUsdc("1.5"), 1_500_000n);
  assert.equal(toUsdc(2), 2_000_000n);
  assert.equal(toUsdc("2500000000"), 2_500_000_000n); // already micro-USDC
  assert.throws(() => toUsdc("ten dollars"));
});

test("parsePlan reads a bare array, a fenced block and a wrapped object", () => {
  const bare = parsePlan('[{"tool":"read_balances","action":"treasury.read","spendUsd":"0"}]');
  assert.equal(bare[0].tool, "read_balances");

  const fenced = parsePlan('```json\n[{"tool":"settle","action":"cva.settle","spendUsd":"12.5"}]\n```');
  assert.equal(fenced[0].spendUsd, 12_500_000n);

  const wrapped = parsePlan('{"calls":[{"tool":"report","action":"treasury.report","spendUsd":"0"}]}');
  assert.equal(wrapped[0].tool, "report");

  assert.throws(() => parsePlan("I refuse to answer"));
});

test("makePlanner falls back to the offline planner without a key", () => {
  const planner = makePlanner({ baseUrl: "https://example.invalid", model: "qwen3.8-max", mock: false, maxSteps: 4 });
  assert.equal(planner.kind, "offline");
  assert.equal(planner.model, "offline-planner");
});

/* ─────────────────────────────── envelope policy ───────────────────────────── */

test("checkEnvelope rejects a spend above the remaining budget", () => {
  const violation = checkEnvelope(
    { tool: "swap_usdc_to_cva", action: "cva.transfer", spendUsd: 2_000_000_000n, args: {}, rationale: "" },
    { remainingUsd: 1_000_000_000n, allowedActions: ALLOWED_ACTIONS.treasury },
  );
  assert.equal(violation?.reason, "SPEND_EXCEEDED");
});

test("checkEnvelope rejects an action outside the role envelope", () => {
  const violation = checkEnvelope(
    { tool: "place_order", action: "perpl.place_order", spendUsd: 1n, args: {}, rationale: "" },
    { remainingUsd: 1_000_000_000n, allowedActions: ALLOWED_ACTIONS.treasury },
  );
  assert.equal(violation?.reason, "ACTION_NOT_ALLOWED");
});

/* ──────────────────────────────────── runs ─────────────────────────────────── */

test("happy path: every step is allowed and executed, and the trail is hash-chained", async () => {
  const transcript = await agent({}).run();
  assert.equal(transcript.status, "completed");
  assert.equal(transcript.steps.length, 3);
  for (const step of transcript.steps) {
    assert.equal(step.gate.allowed, true, `step ${step.step} should be allowed`);
    assert.equal(step.executed, true, `step ${step.step} should have executed`);
  }
  assert.equal(transcript.spendUsd, "1000.0");
  assert.equal(transcript.planner, "offline");
  // Every step leaves a distinct audit head, i.e. the chain advanced.
  const heads = new Set(transcript.steps.map((step) => step.gate.auditHead));
  assert.equal(heads.size, 3);
});

test("blocked: an oversized proposal never reaches execute_fn", async () => {
  const transcript = await agent({ planner: new OfflinePlanner({ overshoot: true }), budgetUsd: 1_000n * 1_000_000n }).run();
  assert.equal(transcript.status, "blocked");
  const blocked = transcript.steps.find((step) => !step.gate.allowed);
  assert.ok(blocked, "a refusal must be recorded");
  assert.equal(blocked!.gate.reason, "SPEND_EXCEEDED");
  assert.equal(blocked!.executed, false);
  assert.equal(transcript.blockedAtStep, blocked!.step);
  // Nothing after the refusal is attempted.
  assert.ok(transcript.steps.every((step) => step.step <= blocked!.step));
});

test("a revoked Cleanverse credential blocks a cva.* step on the gate", async () => {
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: false });
  const transcript = await agent({ gate }).run();
  assert.equal(transcript.status, "blocked");
  const blocked = transcript.steps.find((step) => !step.gate.allowed);
  assert.equal(blocked?.gate.reason, "CVI_UNVERIFIED");
  assert.equal(blocked?.executed, false);
  // The free read still ran; only the cva.* step was refused.
  assert.equal(transcript.steps[0].executed, true);
});

test("a fragile agent (score below the floor) cannot act at all", async () => {
  const gate = new SimulatedGate({ score: 41, status: "active", cviValid: true });
  const transcript = await agent({ gate }).run();
  assert.equal(transcript.status, "blocked");
  assert.equal(transcript.steps[0].gate.reason, "SCORE_TOO_LOW");
  assert.ok(transcript.steps.every((step) => step.executed === false));
});

test("the audit trail proves a spend that left the committed envelope", async () => {
  // Mirrors scenario (c): an entry worth 10,000 USD inside a 100 USD envelope.
  const trail = new AuditTrail(1n, `0x${"ab".repeat(32)}` as const);
  trail.append("cva.transfer", 10_000_000_000n, { forged: true }, 10_000_000_000n);
  const deviations = trail.deviations({ maxSpendUsd: 100_000_000n, allowedActions: ["cva.transfer"] });
  assert.equal(deviations.length, 1);

  const entry = deviations[0];
  const leafHash = AuditTrail.leafFor(trail.agentId, trail.intentHash, entry.action, entry.spendUsd, entry.nonce);
  assert.equal(trail.proofFor(entry.seq).length, 0, "a single-leaf tree proves with an empty proof");
  // MerkleLib.verify starts from `hashLeaf(leaf)` (= keccak256(0x00 ‖ leaf)), so a single-leaf
  // tree proves against exactly that root.
  assert.equal(trail.merkleRoot(), keccak256(concatHex(["0x00", leafHash])));
});

/* ──────────────────────────────────── tools ────────────────────────────────── */

test("tools append to the trail and report their spend", async () => {
  const trail = new AuditTrail(7n, `0x${"cd".repeat(32)}` as const);
  const read = await readBalances({}).execute(
    { tool: "read_balances", action: "treasury.read", spendUsd: 0n, args: {}, rationale: "" },
    { intentHash: trail.intentHash, audit: trail },
  );
  assert.equal(read.spendUsd, 0n);

  const swap = await swapUsdcToCva({}, zero).execute(
    { tool: "swap_usdc_to_cva", action: "cva.transfer", spendUsd: 250_000_000n, args: { amountUsdc: "250" }, rationale: "" },
    { intentHash: trail.intentHash, audit: trail },
  );
  assert.equal(swap.spendUsd, 250_000_000n);
  assert.equal(trail.all().length, 2);
  assert.equal(trail.verify().valid, true, "the trail stays internally consistent");

  const settled = await settle({}).execute(
    { tool: "settle", action: "cva.settle", spendUsd: 1_000_000n, args: {}, rationale: "" },
    { intentHash: trail.intentHash, audit: trail },
  );
  assert.ok(settled.detail.length > 0);
});

test("formatUsd renders micro-USDC without trailing zeros", () => {
  assert.equal(formatUsd(1_500_000n), "1.5");
  assert.equal(formatUsd(2_000_000n), "2.0");
  assert.equal(formatUsd(0n), "0.0");
});
