import test from "node:test";
import assert from "node:assert/strict";
import { SimExchange } from "../src/exchange.js";
import { usdToMicro } from "../src/types.js";

test("SimExchange quotes a positive mid that random-walks", async () => {
  const ex = new SimExchange("MON/USDC", 1.0);
  const q1 = await ex.quote();
  assert.ok(q1.mid > 0);
  assert.ok(q1.bid < q1.mid && q1.mid < q1.ask);
  const seen = new Set<number>();
  for (let i = 0; i < 20; i++) seen.add((await ex.quote()).mid);
  assert.ok(seen.size > 1, "mid must drift between quotes");
});

test("aggressive order crosses and appears in settlement fills", async () => {
  const ex = new SimExchange("MON/USDC", 1.0);
  const q = await ex.quote();
  // buying AT the mid crosses (price >= mid) → immediate fill
  const placed = await ex.place({ side: "buy", price: q.mid, qty: 1, notionalUsd: usdToMicro(q.mid) }, 1);
  assert.match(placed.txHash, /^0x[0-9a-f]{64}$/);
  const settlement = await ex.settle();
  assert.match(settlement.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(settlement.fills?.length, 1);
  assert.ok(settlement.feesUsd > 0n);
});

test("resting quote fills when the walk crosses it", async () => {
  const ex = new SimExchange("MON/USDC", 1.0, 7);
  const q0 = await ex.quote();
  // a generous bid 5% above mid can never rest; a bid just below mid rests until crossed
  const bid = { side: "buy" as const, price: q0.mid * 0.999, qty: 2, notionalUsd: usdToMicro(q0.mid * 0.999 * 2) };
  await ex.place(bid, 1);
  // walk the market until the bid fills (bounded loop)
  let settlement = await ex.settle();
  for (let i = 0; i < 500 && (settlement.fills?.length ?? 0) === 0; i++) {
    await ex.quote();
    settlement = await ex.settle();
  }
  assert.ok((settlement.fills?.length ?? 0) >= 1, "resting bid should eventually be crossed by the walk");
  assert.equal(settlement.fills![0]!.qty, 2);
});

test("cancel removes a resting order so it cannot fill", async () => {
  const ex = new SimExchange("MON/USDC", 1.0, 3);
  const q0 = await ex.quote();
  const bid = { side: "buy" as const, price: q0.mid * 0.9999, qty: 1, notionalUsd: usdToMicro(q0.mid) };
  const placed = await ex.place(bid, 1);
  const cancelHash = await ex.cancel(placed);
  assert.match(cancelHash ?? "", /^0x[0-9a-f]{64}$/);
  for (let i = 0; i < 300; i++) await ex.quote();
  const settlement = await ex.settle();
  assert.equal(settlement.fills?.length ?? 0, 0, "cancelled order must never fill");
});

test("round trip at the same price realises zero edge", async () => {
  const ex = new SimExchange("MON/USDC", 1.0, 11);
  // buy at 0.999, then sell at 1.001: both cross vs mid 1.0
  await ex.place({ side: "buy", price: 1.0, qty: 1, notionalUsd: usdToMicro(1.0) }, 1);
  await ex.place({ side: "sell", price: 1.0, qty: 1, notionalUsd: usdToMicro(1.0) }, 1);
  const settlement = await ex.settle();
  assert.equal(settlement.fills?.length, 2);
  // bought then sold at the same price: edge is 0, PnL is exactly 0
  assert.equal(settlement.realizedPnlUsd, 0n);
  assert.equal(ex.cumulativePnlUsd(), 0n);
});
