import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, bodyHash, canonical, sign, verifySignature, NonceRegistry, DRIFT_MS } from "../src/auth.js";

const SEED = "test-seed";

test("per-agent keys derive from the seed, never expose it", () => {
  const k1 = agentKey(SEED, "1");
  const k2 = agentKey(SEED, "2");
  assert.notDeepStrictEqual(k1, k2, "agents must not share keys");
  assert.ok(!k1.includes(Buffer.from(SEED)));
});

test("signature verifies only for the exact canonical string", () => {
  const params = { agentId: "1", intentHash: "0xa", envelopeHash: "0xb", nonce: "n1", timestamp: 1000, bodyHash: bodyHash("{}") };
  const key = agentKey(SEED, "1");
  const sig = sign(key, canonical(params));
  assert.ok(verifySignature(key, canonical(params), sig));
  // tamper with any single field → dead
  assert.ok(!verifySignature(key, canonical({ ...params, envelopeHash: "0xc" }), sig));
  assert.ok(!verifySignature(key, canonical({ ...params, nonce: "n2" }), sig));
  assert.ok(!verifySignature(key, canonical({ ...params, timestamp: 1001 }), sig));
  assert.ok(!verifySignature(agentKey(SEED, "2"), canonical(params), sig), "wrong agent key");
});

test("nonce registry: single-use within the window, replay rejected", () => {
  const reg = new NonceRegistry(DRIFT_MS);
  const now = 1_000_000;
  assert.ok(reg.consume("1", "n1", now, now));
  assert.ok(!reg.consume("1", "n1", now, now + 1), "same nonce twice is a replay");
  assert.ok(reg.consume("1", "n1", now + DRIFT_MS + 1, now + DRIFT_MS + 1), "fresh timestamp makes the nonce fresh");
  assert.ok(!reg.consume("1", "nX", now - DRIFT_MS - 1, now), "stale timestamp rejected");
  assert.ok(reg.consume("2", "n1", now, now), "nonces are scoped per agent");
});
