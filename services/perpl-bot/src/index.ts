/**
 * Perpl trading bot entry point.
 *
 *   npm start                — run the loop (env-configured)
 *   npm run provision        — register/stake/score the agent only
 *   npm run demo:block       — one recorded intentionally-blocked cycle
 *
 * Every cycle goes through avaira.run(); a gate block halts the bot until an
 * operator resets it via POST /admin/reset-halt.
 */
import { loadConfig } from "./config.js";
import { createExchange } from "./exchange.js";
import { buildGateContext, provisionAgent } from "./gate.js";
import { runCycle, clearHalt } from "./bot.js";
import { loadState, saveState } from "./store.js";
import { startTelemetry } from "./telemetry.js";
import { usdToMicro } from "./types.js";

async function main() {
  const cfg = loadConfig();
  const ctx = buildGateContext(cfg);

  let agentId = cfg.agentId;
  if (!agentId && cfg.autoProvision) {
    agentId = await provisionAgent(ctx);
  }
  if (!agentId) {
    throw new Error("no PERPL_AGENT_ID and PERPL_AUTO_PROVISION=0 — nothing to trade with");
  }

  const exchange = createExchange(cfg.exchangeMode, cfg.pair, cfg.monUsd, cfg.perplApiUrl, cfg.perplApiKey);
  const state = loadState(cfg.stateFile);
  if (state.cycles === 0 && state.capitalUsd === "0") {
    const capital = usdToMicro(cfg.startingCapitalUsd).toString();
    state.capitalUsd = capital;
    state.equityUsd = capital;
    state.peakEquityUsd = capital;
  }
  if (state.halted) {
    console.warn(`[perpl-bot] resuming from persisted halt: ${state.halted.reason} (POST /admin/reset-halt to resume)`);
  }

  const meta = { agentId };
  let blockNext = cfg.forceBlock;
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));

  const telemetry = startTelemetry(
    cfg,
    () => state,
    () => meta,
    {
      requestBlockNext: () => {
        blockNext = true;
      },
      resetHalt: () => {
        clearHalt(state);
        saveState(cfg.stateFile, state);
      },
    },
  );

  console.log(
    `[perpl-bot] agent #${agentId} on chain ${cfg.chainId} | ${cfg.exchangeMode} ${cfg.pair} | cycle ${cfg.cycleMs}ms | budget $${cfg.cycleBudgetUsd}`,
  );

  let cycleCount = 0;
  while (!stop && cycleCount < cfg.maxCycles) {
    const forceBlock = blockNext;
    blockNext = false;
    try {
      const { record, halted } = await runCycle(ctx, exchange, state, agentId, forceBlock);
      cycleCount += 1;
      console.log(
        `[cycle ${record.cycle}] gate=${record.gate.outcome} (${record.gate.reason})` +
          (record.executed
            ? ` mid=${record.quoteMid?.toFixed(4)} placed=${record.placed} cancelled=${record.cancelled} spend=$${(Number(record.spendUsd) / 1e6).toFixed(2)}`
            : "") +
          (halted ? " — HALTED" : ""),
      );
    } catch (error) {
      console.error(`[cycle ${state.cycles}] unexpected error:`, error);
    }
    await new Promise((r) => setTimeout(r, cfg.cycleMs));
  }

  telemetry.close();
  saveState(cfg.stateFile, state);
  console.log("[perpl-bot] stopped");
}

main().catch((err) => {
  console.error("[perpl-bot] fatal:", err);
  process.exit(1);
});
