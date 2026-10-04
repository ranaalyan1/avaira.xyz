/**
 * Recorded intentionally-blocked cycle.
 *
 * Runs one trading cycle with the force-block flag: the bot drops the agent's
 * Avaira Score below the gate floor (60), avaira.run() hits the on-chain gate,
 * and the cycle is blocked pre-execution — execute_fn never runs. The score is
 * restored automatically and the decision is persisted to the state file
 * (visible on GET /status).
 *
 *   npm run demo:block
 *
 * Env: PERPL_AGENT_ID (or PERPL_AUTO_PROVISION=1 to create one), plus the
 * usual chain/rpc vars.
 */
import { loadConfig } from "./config.js";
import { createExchange } from "./exchange.js";
import { buildGateContext, provisionAgent, readScore } from "./gate.js";
import { runCycle } from "./bot.js";
import { loadState, saveState } from "./store.js";

async function main() {
  const cfg = loadConfig();
  const ctx = buildGateContext(cfg);

  let agentId = cfg.agentId;
  if (!agentId) agentId = await provisionAgent(ctx);

  const exchange = createExchange(cfg.exchangeMode, cfg.pair, cfg.monUsd, cfg.perplApiUrl, cfg.perplApiKey);
  const state = loadState(cfg.stateFile);
  state.halted = null; // the block demo is allowed to run from any state
  // Neutralise the drawdown kill switch so this demo shows the SCORE gate, not a halt.
  state.peakEquityUsd = state.equityUsd;

  const before = await readScore(ctx, agentId);
  console.log(`agent #${agentId} score=${before}; running one intentionally-blocked cycle…`);

  const { record } = await runCycle(ctx, exchange, state, agentId, /* forceBlock */ true);
  console.log(`\ngate outcome : ${record.gate.outcome}`);
  console.log(`gate reason  : ${record.gate.reason}`);
  console.log(`score after  : ${await readScore(ctx, agentId)} (restored)`);
  console.log(`executed     : ${record.executed}`);
  console.log(`intent hash  : ${record.gate.intentHash ?? "-"}`);
  if (record.gate.outcome !== "blocked" || record.executed) {
    throw new Error("expected a blocked, non-executed cycle");
  }

  state.halted = null; // the block was intentional; don't leave the bot halted
  saveState(cfg.stateFile, state);
  console.log("\n✓ intentionally blocked cycle recorded (execute_fn never ran)");
}

main().catch((err) => {
  console.error("demo:block failed:", err);
  process.exit(1);
});
