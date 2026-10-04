#!/usr/bin/env tsx
/**
 * CLI for the Avaira-gated Perpl bot.
 *
 *   npm start                 live loop (PERPL_MOCK=0 requires Perpl credentials)
 *   npm run once              a single cycle, then exit
 *   npm run demo:blocked      one allowed cycle, then a blocked cycle (LOW_SCORE), recorded
 *   npm run demo:drawdown     run until the drawdown kill-switch trips, then halt + report
 *   npm run status            print the persisted state as JSON
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadConfig, type BotConfig } from "./config";
import { SimulatedPerplExchange, createExchange } from "./exchange";
import { AvairaGate, SimulatedGate, type Gate } from "./gate";
import { PerplBot } from "./bot";
import { StateStore } from "./state";
import { createStatusServer } from "./status";

const command = process.argv[2] ?? "start";

function makeDeps(overrides: Partial<BotConfig> = {}) {
  const config = loadConfig(overrides);
  const exchange = createExchange(config);
  const state = new StateStore(config.stateFile, config.journalFile, config.agentId, config.pair);
  const gate: Gate = config.mock
    ? new SimulatedGate({ score: 78, status: "active", cviValid: true }, config.agentId.toString())
    : new AvairaGate(config);
  return { config, exchange, state, gate };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  switch (command) {
    case "start": {
      const { config, exchange, state, gate } = makeDeps();
      const bot = new PerplBot({ config, exchange, gate, state });
      const server = createStatusServer({ config, exchange, state, startedAt });
      server.listen(config.port, config.host, () => {
        console.log(`[perpl-bot] /status on http://${config.host}:${config.port}/status (exchange: ${exchange.kind}, gate: ${gate.kind})`);
      });

      // Restart-safe: state.halted latches survive a crash until a human (or the drawdown
      // demo) clears them.
      if (state.current.halted) {
        console.log(`[perpl-bot] state is halted (${state.current.haltReason}); refusing to trade`);
      }

      const loop = async () => {
        if (state.current.halted) return;
        try {
          await bot.cycle();
        } catch (error) {
          console.error(`[perpl-bot] cycle error: ${(error as Error).message}`);
        }
      };

      await loop();
      setInterval(loop, config.cycleSeconds * 1000);
      return;
    }

    case "once": {
      const { config, exchange, state, gate } = makeDeps();
      const bot = new PerplBot({ config, exchange, gate, state });
      const report = await bot.cycle();
      console.log(JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
      return;
    }

    case "demo:blocked":
      return demoBlocked();

    case "demo:drawdown":
      return demoDrawdown();

    case "status": {
      const { state } = makeDeps();
      console.log(JSON.stringify(state.current, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
      return;
    }

    default:
      console.error(`unknown command "${command}" — try start | once | demo:blocked | demo:drawdown | status`);
      process.exitCode = 1;
  }
}

/* ─────────────────────────────── demo scenarios ─────────────────────────────── */

async function demoBlocked(): Promise<void> {
  const { config, exchange, state, gate } = makeDeps({ mock: true });
  const bot = new PerplBot({ config, exchange, gate, state });
  const simulated = gate as SimulatedGate;

  console.log("\n═══ Perpl bot · allowed cycle then a blocked cycle ═══\n");

  const first = await bot.cycle();
  console.log(`  cycle ${first.cycle}: ${first.allowed ? "ALLOWED" : "BLOCKED"} · ${first.placed.length} order(s) placed`);

  // The agent's Avaira score drops below the minimum: the protocol no longer vouches for it.
  simulated.setState({ score: 41 });
  const second = await bot.cycle();
  console.log(`  cycle ${second.cycle}: ${second.allowed ? "ALLOWED" : "BLOCKED"} · reason ${second.reason} · ${second.placed.length} order(s) placed`);

  const transcript = resolve("transcripts", "blocked-cycle-demo.json");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ first, second, state: state.current }, jsonSafe, 2)}\n`);

  const passed = first.allowed && first.placed.length > 0 && !second.allowed && second.reason === "SCORE_TOO_LOW" && second.placed.length === 0;
  console.log(`\n  ${passed ? "✓" : "✗"} blocked-cycle demo ${passed ? "passed" : "FAILED"}: no order was placed after the gate refused`);
  console.log(`  transcript: ${transcript}\n`);
  if (!passed) process.exitCode = 1;
}

async function demoDrawdown(): Promise<void> {
  const config = loadConfig({ mock: true, maxDrawdownUsd: 25, maxPositionUsd: 10_000, orderSizeUsd: 200 });
  const exchange = new SimulatedPerplExchange({ mid: 3.4 });
  const state = new StateStore(config.stateFile, config.journalFile, config.agentId, config.pair);
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: true });
  const bot = new PerplBot({ config, exchange, gate, state });

  console.log("\n═══ Perpl bot · drawdown kill-switch ═══\n");

  // Get long, then let the market fall until the loss breaches the limit.
  await bot.cycle();
  exchange.shock(-1.2);
  await bot.cycle();
  for (const shock of [-2, -3, -4, -5]) {
    exchange.shock(shock);
    const report = await bot.cycle();
    console.log(`  mark ${report.markPrice.toFixed(4)} · pnl ${(report.realisedPnlUsd + report.unrealisedPnlUsd).toFixed(2)} USD${report.haltReason ? ` · HALT: ${report.haltReason}` : ""}`);
    if (state.current.halted) break;
  }

  const transcript = resolve("transcripts", "drawdown-kill-switch.json");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ state: state.current }, jsonSafe, 2)}\n`);

  const passed = state.current.killSwitchTripped && state.current.halted && state.current.trades.some((trade) => trade.kind === "halt");
  console.log(`\n  ${passed ? "✓" : "✗"} kill-switch ${passed ? "tripped and halted the bot" : "did NOT trip"}`);
  console.log(`  transcript: ${transcript}\n`);
  if (!passed) process.exitCode = 1;
}

const jsonSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

main().catch((error: unknown) => {
  console.error(`✗ perpl-bot failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
