/**
 * npm run demo:qwen — records all three scenarios and writes transcripts to
 * services/qwen-agent/transcripts/. Uses live Qwen 3.8 Max when QWEN_API_KEY
 * is set, otherwise the deterministic offline script (QWEN_MOCK=1).
 */
import { buildCtx, provisionAgent } from "./gate.js";
import { saveTranscript, scenarioA, scenarioB, scenarioC } from "./scenarios.js";
import { loadQwenConfig } from "./types.js";

async function main() {
  const cfg = loadQwenConfig();
  console.log(`[qwen-agent] model=${cfg.model} mode=${cfg.mock ? "mock (offline script)" : "live"} chain=${cfg.chainId}`);
  const ctx = buildCtx(cfg);

  let agentId = cfg.agentId;
  if (!agentId) {
    if (!cfg.autoProvision) throw new Error("no QWEN_AGENT_ID and QWEN_AUTO_PROVISION=0");
    agentId = await provisionAgent(ctx);
  }

  console.log("\n══ scenario (a) — happy path: gated swap, Merkle root anchored ══");
  const ta = await scenarioA(ctx, agentId);
  const pa = await saveTranscript(cfg, ta);
  console.log(`transcript: ${pa.json}\n            ${pa.txt}`);

  console.log("\n══ scenario (b) — overspend: clamped, then blocked at the gate ══");
  const tb = await scenarioB(ctx, agentId);
  const pb = await saveTranscript(cfg, tb);
  console.log(`transcript: ${pb.json}\n            ${pb.txt}`);

  console.log("\n══ scenario (c) — forged certificate: deviation challenged + slashed ══");
  const tc = await scenarioC(ctx, agentId);
  const pc = await saveTranscript(cfg, tc);
  console.log(`transcript: ${pc.json}\n            ${pc.txt}`);

  console.log("\n✓ all three scenarios recorded — plan / gate / settlement present in each transcript");
}

main().catch((err) => {
  console.error("demo:qwen failed:", err);
  process.exit(1);
});
