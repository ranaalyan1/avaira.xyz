/**
 * Interactive treasury agent: one task from the CLI (or stdin), gated tool
 * calls, transcript to services/qwen-agent/transcripts/.
 *
 *   npm start -- "Rebalance $100 of MON into USDC"
 */
import { runTask } from "./agent.js";
import { buildCtx, provisionAgent } from "./gate.js";
import { createLlm } from "./llm.js";
import { save } from "./transcript.js";
import type { ToolContext } from "./treasury.js";
import { loadQwenConfig } from "./types.js";

async function main() {
  const cfg = loadQwenConfig();
  const description = process.argv.slice(2).join(" ") || "Report the treasury balances and suggest one small rebalance.";
  console.log(`[qwen-agent] model=${cfg.model} mode=${cfg.mock ? "mock" : "live"} task="${description}"`);
  const ctx = buildCtx(cfg);
  const agentId = cfg.agentId ?? (cfg.autoProvision ? await provisionAgent(ctx) : undefined);
  if (!agentId) throw new Error("no QWEN_AGENT_ID and QWEN_AUTO_PROVISION=0");

  const transcript = {
    scenario: "interactive",
    ts: Date.now(),
    model: cfg.model,
    mode: (cfg.mock ? "mock" : "live") as "mock" | "live",
    chainId: cfg.chainId,
    agentId: agentId.toString(),
    task: { id: `interactive-${Date.now()}`, description },
    events: [] as import("./types.js").TranscriptEvent[],
  };

  const toolCtx: ToolContext = { ledger: { MON: 1_250, USDC: 8_000 } };
  const llm = createLlm(cfg.mock ? "mock" : "live", cfg.model, cfg.baseUrl, cfg.apiKey);
  const result = await runTask({
    avaira: ctx.avaira,
    agentId,
    llm,
    transcript,
    task: transcript.task,
    budgetUsd: cfg.taskBudgetUsd,
    windowSec: cfg.taskWindowSec,
    toolCtx,
  });

  console.log(`\nfinal  : ${result.final || `(blocked: ${result.blocked?.reason})`}`);
  console.log(`spent  : $${Number(result.spentUsd) / 1e6}`);
  const paths = save(transcript, cfg.transcriptsDir);
  console.log(`transcript: ${paths.json}`);
}

main().catch((err) => {
  console.error("qwen-agent failed:", err);
  process.exit(1);
});
