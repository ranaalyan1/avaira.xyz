/**
 * One-shot provisioning: register/stake/score the trading agent.
 * Prints the agent id — export it as PERPL_AGENT_ID for the bot.
 */
import { loadConfig } from "./config.js";
import { buildGateContext, provisionAgent, readScore } from "./gate.js";

async function main() {
  const cfg = loadConfig();
  const ctx = buildGateContext(cfg);
  const agentId = await provisionAgent(ctx);
  const score = await readScore(ctx, agentId);
  console.log(`agent id : ${agentId}`);
  console.log(`score    : ${score}`);
  console.log(`\nexport PERPL_AGENT_ID=${agentId}`);
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
