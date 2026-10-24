import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, BreakerRegistry } from "../src/breaker.js";

test("stays CLOSED while allowed", () => {
  const b = new CircuitBreaker();
  for (let i = 0; i < 50; i++) {
    assert.equal(b.record(true, i * 1000), "CLOSED");
    assert.ok(b.permits(i * 1000));
  }
});

test("trips to OPEN after the threshold of denials in the window", () => {
  const b = new CircuitBreaker();
  const t0 = 1_000_000;
  assert.equal(b.record(false, t0), "CLOSED");
  assert.equal(b.record(false, t0 + 1000), "CLOSED");
  assert.equal(b.record(false, t0 + 2000), "OPEN", "third denial trips it");
  assert.ok(!b.permits(t0 + 3000), "OPEN fails fast — no RPC call");
});

test("denials older than the window decay away", () => {
  const b = new CircuitBreaker({ threshold: 3, windowMs: 10_000, cooldownMs: 10_000 });
  const t0 = 1_000_000;
  b.record(false, t0);
  b.record(false, t0 + 20_000); // first decayed out
  b.record(false, t0 + 20_500);
  assert.equal(b.state_, "CLOSED", "the first denial left the rolling window");
  b.record(false, t0 + 21_000);
  assert.equal(b.state_, "OPEN");
});

test("cooldown → HALF_OPEN probe: allowed closes it, denied re-opens it", () => {
  const b = new CircuitBreaker({ threshold: 2, windowMs: 10_000, cooldownMs: 10_000 });
  const t0 = 1_000_000;
  b.record(false, t0);
  b.record(false, t0 + 1);
  assert.equal(b.state_, "OPEN");
  assert.ok(!b.permits(t0 + 5_000), "still cooling down");
  assert.ok(b.permits(t0 + 10_001), "cooldown elapsed → one probe permitted");
  assert.equal(b.state_, "HALF_OPEN");
  assert.equal(b.record(true, t0 + 10_002), "CLOSED", "successful probe closes the breaker");
  // and the denied-probe path
  const b2 = new CircuitBreaker({ threshold: 2, windowMs: 10_000, cooldownMs: 10_000 });
  b2.record(false, t0);
  b2.record(false, t0 + 1);
  b2.permits(t0 + 10_001);
  assert.equal(b2.record(false, t0 + 10_002), "OPEN", "failed probe re-opens");
});

test("registry isolates breakers per agent", () => {
  const reg = new BreakerRegistry({ threshold: 1, windowMs: 10_000, cooldownMs: 10_000 });
  reg.for("1").record(false, 0);
  assert.equal(reg.for("1").state_, "OPEN");
  assert.equal(reg.for("2").state_, "CLOSED", "one agent's compromise never grounds the fleet");
  assert.ok(reg.reset("1"));
  assert.equal(reg.for("1").state_, "CLOSED");
  assert.ok(!reg.reset("nope"));
});
