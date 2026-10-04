import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshState, loadState, saveState, trimLogs } from "../src/store.js";

test("save/load round-trip preserves the full state", () => {
  const dir = mkdtempSync(join(tmpdir(), "perpl-"));
  const path = join(dir, "state.json");
  const state = freshState();
  state.cycles = 7;
  state.position = { pair: "MON/USDC", qty: 3, avgPrice: 1.02 };
  state.equityUsd = "123";
  state.txHashes.push("0xabc");
  state.gateLog.push({
    cycle: 7,
    ts: 1,
    outcome: "allowed",
    reason: "ALLOWED",
    envelope: { maxSpendUsd: "1000000", allowedActions: ["perpl.quote"], deadline: 2 },
  });
  saveState(path, state);
  const loaded = loadState(path);
  assert.equal(loaded.cycles, 7);
  assert.equal(loaded.position.qty, 3);
  assert.deepEqual(loaded.txHashes, ["0xabc"]);
  assert.equal(loaded.gateLog[0]!.reason, "ALLOWED");
});

test("corrupted state file falls back to a fresh state", () => {
  const dir = mkdtempSync(join(tmpdir(), "perpl-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "{not json");
  const state = loadState(path);
  assert.equal(state.cycles, 0);
});

test("trimLogs bounds the in-memory logs", () => {
  const state = freshState();
  for (let i = 0; i < 500; i++) {
    state.gateLog.push({
      cycle: i,
      ts: i,
      outcome: "allowed",
      reason: "ALLOWED",
      envelope: { maxSpendUsd: "0", allowedActions: [], deadline: 0 },
    });
    state.txHashes.push(`0x${i}`);
  }
  trimLogs(state, 100);
  assert.equal(state.gateLog.length, 100);
  assert.equal(state.gateLog[99]!.cycle, 499, "keeps the most recent entries");
  assert.ok(state.txHashes.length <= 200);
});

test("halt state survives persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "perpl-"));
  const path = join(dir, "state.json");
  const state = freshState();
  state.halted = { at: 123, reason: "kill switch", cycle: 4 };
  saveState(path, state);
  assert.equal(loadState(path).halted?.reason, "kill switch");
});
