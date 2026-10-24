import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, bodyHash, canonical, sign } from "../src/auth.js";
import { Gateway, type ExecuteRequest } from "../src/server.js";
import { StubGateClient } from "../src/gate.js";

const SEED = "seed";
const ADMIN_SEED = "admin-seed";

function signedReq(overrides: Partial<ExecuteRequest> = {}, seedUsed: string = SEED): ExecuteRequest {
  const base: ExecuteRequest = {
    agentId: "1",
    intentHash: "0x" + "aa".repeat(32),
    envelopeHash: "0x" + "bb".repeat(32),
    nonce: `n${Math.random()}`,
    timestamp: Date.now(),
    action: { tool: "web.search", query: "test" },
    ...overrides,
  };
  return base;
}

function sigFor(req: ExecuteRequest): string {
  const key = agentKey(SEED, req.agentId);
  return sign(key, canonical({
    agentId: req.agentId,
    intentHash: req.intentHash,
    envelopeHash: req.envelopeHash,
    nonce: req.nonce,
    timestamp: req.timestamp,
    bodyHash: bodyHash(JSON.stringify(req.action ?? {})),
  }));
}

function freshGateway(answers: Array<{ allowed: boolean; reason: number; score: number }>) {
  const gate = new StubGateClient(
    answers.map((a) => ({ ...a, latencyMs: 1 })),
  );
  const gw = new Gateway({ seed: SEED, adminSeed: ADMIN_SEED, gate });
  return { gw, gate };
}

test("happy path: signed request → gate ALLOWED → 200", async () => {
  const { gw } = freshGateway([{ allowed: true, reason: 0, score: 78 }]);
  const req = signedReq();
  const res = await gw.execute(sigFor(req), req);
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, "ALLOWED");
  assert.equal(res.body.reason, "allowed");
  assert.equal(res.body.score, 78);
});

test("bad signature → 401, gate never consulted", async () => {
  const { gw } = freshGateway([]);
  const req = signedReq();
  const res = await gw.execute("0xdeadbeef", req);
  assert.equal(res.status, 401);
});

test("replay: the same nonce+timestamp twice → 409 the second time", async () => {
  const { gw } = freshGateway([
    { allowed: true, reason: 0, score: 78 },
    { allowed: true, reason: 0, score: 78 },
  ]);
  const req = signedReq();
  const first = await gw.execute(sigFor(req), req);
  assert.equal(first.status, 200);
  const replay = await gw.execute(sigFor(req), req);
  assert.equal(replay.status, 409, "captured request dies on its second trip");
});

test("gate denial → DENIED with named reason; three denials → breaker OPEN → 423 fail-fast", async () => {
  const { gw } = freshGateway([
    { allowed: false, reason: 4, score: 10 }, // STAKE_TOO_LOW
    { allowed: false, reason: 4, score: 10 },
    { allowed: false, reason: 4, score: 10 },
    { allowed: true, reason: 0, score: 78 }, // must never be reached
  ]);
  for (let i = 0; i < 3; i++) {
    const req = signedReq();
    const res = await gw.execute(sigFor(req), req);
    if (res.status === 200) {
      assert.equal(res.body.decision, "DENIED");
      assert.equal(res.body.reason, "stake too low");
      assert.equal(res.body.breaker, i === 2 ? "OPEN" : "CLOSED");
    } else {
      assert.fail("unexpected status");
    }
  }
  // fourth request: breaker is OPEN → fail fast, gate untouched (stub queue still has 1 left)
  const req4 = signedReq();
  const res4 = await gw.execute(sigFor(req4), req4);
  assert.equal(res4.status, 423);
  assert.equal(res4.body.error, "circuit breaker open");
});

test("breaker state is per-agent: a grounded agent is unaffected", async () => {
  const { gw } = freshGateway([
    { allowed: false, reason: 4, score: 10 },
    { allowed: false, reason: 4, score: 10 },
    { allowed: false, reason: 4, score: 10 },
    { allowed: true, reason: 0, score: 90 },
  ]);
  for (let i = 0; i < 3; i++) {
    const req = signedReq();
    await gw.execute(sigFor(req), req);
  }
  const other = signedReq({ agentId: "2" });
  const res = await gw.execute(sigFor(other), other);
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, "ALLOWED", "agent 2 never saw agent 1's denials");
});

test("gate unreachable → 503, fail closed, breaker not charged", async () => {
  const gate = new StubGateClient([]);
  gate.check = () => Promise.reject(new Error("connection refused"));
  const gw = new Gateway({ seed: SEED, adminSeed: ADMIN_SEED, gate });
  const req = signedReq();
  const res = await gw.execute(sigFor(req), req);
  assert.equal(res.status, 503);
});

test("admin reset requires the admin seed and clears the breaker", async () => {
  const { gw } = freshGateway([
    { allowed: false, reason: 4, score: 10 },
    { allowed: false, reason: 4, score: 10 },
    { allowed: false, reason: 4, score: 10 },
  ]);
  for (let i = 0; i < 3; i++) {
    const req = signedReq();
    await gw.execute(sigFor(req), req);
  }
  const wrongSig = sign(agentKey(SEED, "admin"), "admin:reset:1");
  const denied = await gw.handle("POST", "/breaker/1/reset", { "x-admin-signature": wrongSig }, {} as never);
  assert.equal(denied.status, 403, "the agent seed is not the admin seed");
  const rightSig = sign(agentKey(ADMIN_SEED, "admin"), "admin:reset:1");
  const ok = await gw.handle("POST", "/breaker/1/reset", { "x-admin-signature": rightSig }, {} as never);
  assert.equal(ok.status, 200);
  if (ok.status !== 200) assert.fail("reset failed");
  const state = await gw.handle("GET", "/breaker/1", {}, {} as never);
  if (state.status !== 200) assert.fail("breaker state read failed");
  assert.equal(state.body.breaker, "CLOSED");
});

test("health reports the vault", async () => {
  const { gw, gate } = freshGateway([]);
  const res = await gw.handle("GET", "/health", {}, {} as never);
  if (res.status !== 200) assert.fail("health failed");
  assert.ok(res.body.reason.includes(gate.vaultAddress()));
});
