import test from "node:test";
import assert from "node:assert/strict";
import { checkDrawdown, checkPositionCap, checkScore, cycleBudgetUsd, markEquity } from "../src/risk.js";
import { freshState } from "../src/store.js";
import type { BotConfig } from "../src/config.js";

const cfg: BotConfig = {
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
  monUsd: 2,
  gasReserveUsd: 0.5,
  stateFile: "/tmp/x.json",
  port: 8401,
  forceBlock: false,
};

test("checkPositionCap blocks orders that breach the inventory cap", () => {
  const p = { pair: "MON/USDC", qty: 9.5, avgPrice: 1 };
  assert.equal(checkPositionCap(p, 1, cfg).ok, false);
  assert.equal(checkPositionCap(p, -1, cfg).ok, true);
  assert.equal(checkPositionCap({ ...p, qty: 0 }, 1, cfg).ok, true);
});

test("checkDrawdown trips the kill switch at the configured threshold", () => {
  const state = freshState();
  state.peakEquityUsd = "100000000"; // $100
  state.equityUsd = "96000000"; // $96 → 4% drawdown
  assert.equal(checkDrawdown(state, cfg).ok, true);
  state.equityUsd = "94000000"; // $94 → 6% drawdown
  const check = checkDrawdown(state, cfg);
  assert.equal(check.ok, false);
  assert.match(check.reason!, /kill switch/);
});

test("cycleBudgetUsd reserves gas and scales with gas price", () => {
  const cheap = cycleBudgetUsd(cfg, 1n); // 1 wei — negligible
  // 10 µMON per gas → 250k gas of overhead ≈ 2.5 MON ≈ $5 > the $0.5 floor reserve
  const expensive = cycleBudgetUsd(cfg, 10_000_000_000_000n);
  assert.ok(cheap > expensive, "higher gas price must shrink the spendable budget");
  const floor = cycleBudgetUsd({ ...cfg, cycleBudgetUsd: 0.0001 }, 10_000_000_000_000n);
  assert.equal(floor, 0n, "budget never goes negative");
});

test("checkScore enforces the min-score floor", () => {
  assert.equal(checkScore(60, cfg).ok, true);
  assert.equal(checkScore(59, cfg).ok, false);
});

test("markEquity combines realized PnL and inventory mark", () => {
  const state = freshState();
  state.realizedPnlUsd = "1000000"; // $1
  state.position = { pair: "MON/USDC", qty: 10, avgPrice: 1.0 };
  // MON at $1.10 → +$0.10 per unit × 10 units = +$1 unrealised
  const equity = markEquity(state, 1.1);
  assert.equal(equity, 2_000_000n);
});
