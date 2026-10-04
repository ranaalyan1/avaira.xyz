import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record, save } from "../src/transcript.js";
import type { Transcript } from "../src/types.js";

function fresh(): Transcript {
  return {
    scenario: "unit",
    ts: Date.now(),
    model: "qwen3.8-max",
    mode: "mock",
    chainId: 10143,
    agentId: "1",
    task: { id: "t-1", description: "unit task" },
    events: [],
  };
}

test("record appends plan/gate/settlement events", () => {
  const t = fresh();
  record(t, { type: "plan", text: "step one" });
  record(t, {
    type: "gate",
    tool: "treasury_swap",
    outcome: "allowed",
    reason: "ALLOWED",
    envelope: { maxSpendUsd: "500000000", allowedActions: ["treasury.swap"], deadline: 123 },
  });
  record(t, { type: "settlement", tool: "treasury_swap", outcomeHash: "0xaa", merkleRoot: "0xbb" });
  assert.deepEqual(
    t.events.map((e) => e.type),
    ["plan", "gate", "settlement"],
  );
});

test("save writes machine JSON + human text with the key markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "qwen-"));
  const t = fresh();
  record(t, { type: "plan", text: "the plan" });
  record(t, {
    type: "gate",
    tool: "cert_verify",
    outcome: "blocked",
    reason: "score too low",
    envelope: { maxSpendUsd: "0", allowedActions: ["cert.verify"], deadline: 1 },
  });
  record(t, { type: "challenge", leaf: {}, proofDepth: 2, txHash: "0x" + "1".repeat(64), slashed: "75000000", bounty: "5000000" });
  const paths = save(t, dir);
  const parsed = JSON.parse(readFileSync(paths.json, "utf8")) as Transcript;
  assert.equal(parsed.scenario, "unit");
  assert.equal(parsed.events.length, 3);
  const txt = readFileSync(paths.txt, "utf8");
  assert.match(txt, /PLAN/);
  assert.match(txt, /GATE .*cert_verify -> BLOCKED/);
  assert.match(txt, /CHALLENGE deviation upheld/);
  assert.match(txt, /envelope maxSpend/);
});
