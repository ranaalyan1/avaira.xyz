import test from "node:test";
import assert from "node:assert/strict";
import { gridOrders, applyFill } from "../src/strategy.js";
import type { BotConfig } from "../src/config.js";
import type { Position, Quote } from "../src/types.js";
import { usdToMicro } from "../src/types.js";

function cfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    chainId: 10143,
    rpcUrl: "http://127.0.0.1:8545",
    operatorKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    autoProvision: false,
    pair: "MON/USDC",
    exchangeMode: "sim",
    cycleMs: 1000,
    maxCycles: 1,
    cycleBudgetUsd: 250,
    startingCapitalUsd: 1000,
    gridLevels: 2,
    gridSpreadBps: 30,
    orderSizeMon: 1,
    maxPositionQty: 10,
    maxDrawdownPct: 5,
    minScore: 60,
    monUsd: 1,
    gasReserveUsd: 0.5,
    stateFile: "/tmp/x.json",
    port: 8401,
    forceBlock: false,
    ...overrides,
  };
}

const quote: Quote = { pair: "MON/USDC", mid: 1.0, bid: 0.9996, ask: 1.0004, depth: 500, ts: 0 };
const flat: Position = { pair: "MON/USDC", qty: 0, avgPrice: 0 };

test("gridOrders quotes symmetric levels around mid", () => {
  const orders = gridOrders({ quote, position: flat, budgetUsd: usdToMicro(1000), cfg: cfg() });
  assert.equal(orders.length, 4); // 2 bids + 2 asks
  const bids = orders.filter((o) => o.side === "buy");
  const asks = orders.filter((o) => o.side === "sell");
  assert.equal(bids.length, 2);
  assert.equal(asks.length, 2);
  assert.ok(bids.every((o) => o.price < quote.mid));
  assert.ok(asks.every((o) => o.price > quote.mid));
  // levels widen outward
  assert.ok(bids[0]!.price > bids[1]!.price);
  assert.ok(asks[0]!.price < asks[1]!.price);
});

test("gridOrders never exceeds the envelope budget", () => {
  const budget = usdToMicro(2.5); // room for ~2 orders at $1
  const orders = gridOrders({ quote, position: flat, budgetUsd: budget, cfg: cfg() });
  const total = orders.reduce((s, o) => s + o.notionalUsd, 0n);
  assert.ok(total <= budget);
});

test("gridOrders respects the hard position cap", () => {
  const long: Position = { pair: "MON/USDC", qty: 10, avgPrice: 1 }; // at cap
  const orders = gridOrders({ quote, position: long, budgetUsd: usdToMicro(1000), cfg: cfg() });
  assert.ok(orders.every((o) => o.side === "sell"), "no buys when at the long cap");
  const short: Position = { pair: "MON/USDC", qty: -10, avgPrice: 1 };
  const orders2 = gridOrders({ quote, position: short, budgetUsd: usdToMicro(1000), cfg: cfg() });
  assert.ok(orders2.every((o) => o.side === "buy"), "no sells when at the short cap");
});

test("applyFill tracks inventory and average price", () => {
  let p = applyFill(flat, "buy", 1.0, 2);
  assert.equal(p.qty, 2);
  assert.equal(p.avgPrice, 1.0);
  p = applyFill(p, "buy", 1.1, 2);
  assert.equal(p.qty, 4);
  assert.ok(Math.abs(p.avgPrice - 1.05) < 1e-9);
  p = applyFill(p, "sell", 1.2, 4);
  assert.equal(p.qty, 0);
  assert.equal(p.avgPrice, 0);
});

test("zero budget produces no orders", () => {
  const orders = gridOrders({ quote, position: flat, budgetUsd: 0n, cfg: cfg() });
  assert.equal(orders.length, 0);
});
