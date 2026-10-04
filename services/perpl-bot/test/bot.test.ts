/**
 * Offline suite for the Perpl bot: strategy maths, the risk kernel, the gate seam and the
 * cycle's safety properties. Everything runs against the simulated exchange — no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, type BotConfig } from "../src/config";
import { SimulatedPerplExchange } from "../src/exchange";
import { SimulatedGate } from "../src/gate";
import { PerplBot } from "../src/bot";
import { assessRisk, planGrid } from "../src/strategy";
import { StateStore } from "../src/state";

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return loadConfig({
    mock: true,
    pair: "MON/USDC",
    gridLevels: 3,
    gridSpacingBps: 20,
    orderSizeUsd: 20,
    maxPositionUsd: 500,
    maxDrawdownUsd: 100,
    minScore: 60,
    gasBufferUsd: 2,
    cycleSeconds: 1,
    ...overrides,
  });
}

function store(): StateStore {
  const dir = mkdtempSync(join(tmpdir(), "perpl-bot-"));
  return new StateStore(join(dir, "state.json"), join(dir, "journal.jsonl"), 1n, "MON/USDC");
}

test("grid plans symmetric bids and asks around the mark", () => {
  const plan = planGrid(config(), { pair: "MON/USDC", markPrice: 3.4, bid: 3.39, ask: 3.41, depthUsd: 1000 }, 1);
  assert.equal(plan.quotes.length, 6);
  const buys = plan.quotes.filter((quote) => quote.side === "buy");
  const sells = plan.quotes.filter((quote) => quote.side === "sell");
  assert.equal(buys.length, 3);
  assert.equal(sells.length, 3);
  for (const buy of buys) assert.ok(buy.price < plan.markPrice, `bid ${buy.price} must sit below the mark`);
  for (const sell of sells) assert.ok(sell.price > plan.markPrice, `ask ${sell.price} must sit above the mark`);
  // Spacing grows with distance from the mark at a fixed bps rate. Odd cycles shift the
  // ladder by half a step so resting quotes do not go stale.
  const spacing = plan.markPrice * 0.002;
  assert.ok(Math.abs(buys[0].price - (plan.markPrice - spacing * 1.5)) < 1e-6);
  assert.ok(Math.abs(sells[0].price - (plan.markPrice + spacing * 1.5)) < 1e-6);
});

test("risk kernel refuses to quote below the minimum Avaira score", () => {
  const decision = assessRisk(config(), { positions: [], realisedPnlUsd: 0, score: 59 }, [
    { side: "buy", price: 3, sizeUsd: 20, level: 1 },
  ]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "SCORE_TOO_LOW");
});

test("risk kernel trips the drawdown kill-switch on unrealised loss", () => {
  const decision = assessRisk(
    config({ maxDrawdownUsd: 50, maxPositionUsd: 10_000 }),
    { positions: [{ pair: "MON/USDC", size: 10, entryPrice: 4, markPrice: 3, unrealisedPnlUsd: -60 }], realisedPnlUsd: 0, score: 80 },
    [{ side: "buy", price: 3, sizeUsd: 20, level: 1 }],
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "DRAWDOWN_KILL_SWITCH");
});

test("risk kernel clamps size to the position cap instead of refusing outright", () => {
  const decision = assessRisk(
    config({ maxPositionUsd: 100, orderSizeUsd: 60, gasBufferUsd: 2 }),
    { positions: [{ pair: "MON/USDC", size: 5, entryPrice: 3, markPrice: 3, unrealisedPnlUsd: 0 }], realisedPnlUsd: 0, score: 80 },
    [
      { side: "buy", price: 3, sizeUsd: 60, level: 1 },
      { side: "sell", price: 3, sizeUsd: 60, level: 2 },
    ],
  );
  assert.equal(decision.allowed, true);
  const clamped = decision.clampedQuotes ?? [];
  const total = clamped.reduce((sum, quote) => sum + quote.sizeUsd, 0);
  assert.ok(total <= 100 - 15 - 2 + 1e-6, `clamped clip ${total} must respect the cap`);
  assert.ok(clamped.length >= 1);
});

test("an allowed cycle places ladder orders and records them", async () => {
  const exchange = new SimulatedPerplExchange();
  const state = store();
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: true });
  const bot = new PerplBot({ config: config(), exchange, gate, state, log: () => {} });

  const report = await bot.cycle();
  assert.equal(report.allowed, true);
  assert.ok(report.placed.length > 0);
  assert.equal(report.reason, "OK");
  assert.equal(state.current.cyclesAllowed, 1);
  assert.ok(state.current.trades.length >= report.placed.length);
  // Every trade row carries the spend consumed so far in the cycle — the audit trail.
  for (const trade of state.current.trades) assert.equal(typeof trade.spendUsdThisCycle, "number");
});

test("a blocked gate places nothing and halts the bot", async () => {
  const exchange = new SimulatedPerplExchange();
  const state = store();
  const gate = new SimulatedGate({ score: 20, status: "active", cviValid: true });
  const bot = new PerplBot({ config: config(), exchange, gate, state, log: () => {} });

  const report = await bot.cycle();
  assert.equal(report.allowed, false);
  assert.equal(report.reason, "SCORE_TOO_LOW");
  assert.equal(report.placed.length, 0);
  assert.equal(state.current.halted, true);
  assert.ok(state.current.haltReason?.includes("SCORE_TOO_LOW"));
  assert.equal(state.current.cyclesBlocked, 1);
});

test("a suspended agent never reaches the exchange", async () => {
  const exchange = new SimulatedPerplExchange();
  const state = store();
  const gate = new SimulatedGate({ score: 90, status: "suspended", cviValid: true });
  const bot = new PerplBot({ config: config(), exchange, gate, state, log: () => {} });

  const report = await bot.cycle();
  assert.equal(report.allowed, false);
  assert.equal(report.reason, "SUSPENDED");
  assert.equal(report.placed.length, 0);
});

test("state survives a restart and latches the halt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpl-bot-restart-"));
  const stateFile = join(dir, "state.json");
  const journalFile = join(dir, "journal.jsonl");

  const first = new StateStore(stateFile, journalFile, 1n, "MON/USDC");
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: true });
  const bot = new PerplBot({ config: config(), exchange: new SimulatedPerplExchange(), gate, state: first, log: () => {} });
  await bot.cycle();
  first.halt("test halt");

  const resumed = new StateStore(stateFile, journalFile, 1n, "MON/USDC");
  assert.equal(resumed.current.halted, true);
  assert.equal(resumed.current.haltReason, "test halt");
  assert.equal(resumed.current.cycle, 1);

  const journal = readFileSync(journalFile, "utf8").trim().split("\n");
  assert.ok(journal.length >= 2, "the journal keeps a line per decision");
});

test("cycle spend never exceeds the envelope budget", async () => {
  const exchange = new SimulatedPerplExchange();
  const state = store();
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: true });
  const bot = new PerplBot({ config: config(), exchange, gate, state, log: () => {} });
  const report = await bot.cycle();
  // 6 quotes at 20 USD = 120 USD planned, so the envelope must be at least that.
  assert.ok(report.spendUsdThisCycle <= 120n, `spend ${report.spendUsdThisCycle} must stay within the cycle budget`);
});
