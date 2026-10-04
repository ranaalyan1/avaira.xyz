/**
 * The treasury agent loop.
 *
 *   user task → Qwen (plan + tool_calls) → for each tool call:
 *     clamp against remaining budget → avaira.run(agentId, task, execute_fn,
 *     { envelope: { maxSpendUsd: remaining budget, allowedActions: [action],
 *                   deadline: task window } })
 *     → gate blocked: record + stop the task (execute_fn never ran)
 *     → allowed: execute, hash-chain the audit entry, anchor the Merkle root
 *
 * Every step lands in the transcript as a ReasoningTrace event.
 */
import { Avaira, type AuditTrail, type RunResult } from "../../../sdk/typescript/src/index.js";
import type { LlmClient } from "./llm.js";
import { executeTool, TOOL_ACTIONS, TREASURY_TOOLS, type ToolContext } from "./treasury.js";
import { record } from "./transcript.js";
import type { ChatMessage, Transcript } from "./types.js";

export const SYSTEM_PROMPT = `You are the Avaira Treasury Agent, an autonomous financial operator for the Avaira protocol on Monad.

Rules:
- You manage the protocol treasury: balances, swaps, and certificate checks.
- Every action you take is wrapped in an Avaira risk envelope (a budget and an allowlist) and gated on-chain BEFORE execution. Anything outside the envelope can be challenged and slashed — stay inside it.
- Prefer small, verifiable steps: check balances, quote before swapping, then execute.
- Never move more than your remaining task budget in a single action.
- Reply with a short final summary when the task is done.`;

export interface TaskRunInput {
  avaira: Avaira;
  agentId: bigint;
  llm: LlmClient;
  transcript: Transcript;
  task: { id: string; description: string };
  budgetUsd: number;
  windowSec: number;
  toolCtx: ToolContext;
  /** Demo hook: runs just before each tool call's gated run (0-indexed). */
  onBeforeToolCall?: (toolName: string, callIndex: number) => Promise<void>;
}

export interface TaskRunResult {
  final: string;
  spentUsd: bigint;
  blocked: null | { tool: string; reason: string };
  runs: { tool: string; run: RunResult; trail: AuditTrail; envelopeAllowedActions: string[]; envelopeMaxSpendUsd: bigint }[];
}

function microToUsdString(micro: bigint): string {
  return (Number(micro) / 1e6).toFixed(6);
}

export async function runTask(input: TaskRunInput): Promise<TaskRunResult> {
  const { avaira, agentId, llm, transcript, task, budgetUsd, windowSec, toolCtx } = input;
  const budgetMicro = BigInt(Math.round(budgetUsd * 1e6));
  let spentUsd = 0n;
  let callIndex = 0;
  const runs: TaskRunResult["runs"] = [];

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${task.description} (task id: ${task.id}, budget: $${budgetUsd})` },
  ];

  for (let turn = 0; turn < 8; turn++) {
    const reply = await llm.chat(messages, TREASURY_TOOLS);
    messages.push(reply);

    if (reply.content) {
      record(transcript, turn === 0 ? { type: "plan", text: reply.content } : { type: "final", text: reply.content });
    }
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      return { final: reply.content ?? "", spentUsd, blocked: null, runs };
    }

    for (const call of reply.tool_calls) {
      const tool = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        /* malformed args — the gate will see an empty plan */
      }
      record(transcript, { type: "tool_call", id: call.id, tool, args });

      // ── clamp policy: proposals above the remaining budget are cut down ──
      let clamped: { from: number; to: number } | null = null;
      const remainingUsd = Number(budgetMicro - spentUsd) / 1e6;
      if (tool === "treasury_swap" && typeof args.amountUsd === "number" && args.amountUsd > remainingUsd) {
        clamped = { from: args.amountUsd, to: Math.max(0, Math.floor(remainingUsd * 100) / 100) };
        args = { ...args, amountUsd: clamped.to };
      }

      const action = TOOL_ACTIONS[tool] ?? tool;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + windowSec);
      const envelope = {
        maxSpendUsd: budgetMicro - spentUsd > 0n ? budgetMicro - spentUsd : 1n,
        allowedActions: [action],
        deadline,
      };

      if (clamped) {
        record(transcript, {
          type: "gate",
          tool,
          outcome: "clamped",
          reason: `proposal $${clamped.from} exceeds remaining task budget $${microToUsdString(envelope.maxSpendUsd)} — clamped to $${clamped.to}`,
          envelope: { maxSpendUsd: envelope.maxSpendUsd.toString(), allowedActions: [action], deadline: Number(deadline) },
          detail: clamped,
        });
      }

      await input.onBeforeToolCall?.(tool, callIndex);
      callIndex += 1;

      let run: RunResult;
      let trail: AuditTrail | undefined;
      try {
        run = await avaira.run(
          agentId,
          { id: `${task.id}:${tool}:${turn}:${call.id}`, description: `${tool} ${JSON.stringify(args)}` },
          async ({ audit }) => {
            trail = audit;
            const out = executeTool(toolCtx, tool, args);
            audit.append(out.action, out.spendUsd, { args, result: out.result });
            return out;
          },
          { envelope },
        );
      } catch (error) {
        const reason = `execution error: ${error instanceof Error ? error.message : String(error)}`;
        record(transcript, {
          type: "gate",
          tool,
          outcome: "blocked",
          reason,
          envelope: { maxSpendUsd: envelope.maxSpendUsd.toString(), allowedActions: [action], deadline: Number(deadline) },
        });
        messages.push({ role: "tool", tool_call_id: call.id, name: tool, content: `ERROR: ${reason}` });
        return { final: "", spentUsd, blocked: { tool, reason }, runs };
      }

      const gateEventBase = {
        tool,
        envelope: { maxSpendUsd: envelope.maxSpendUsd.toString(), allowedActions: [action], deadline: Number(deadline) },
      };

      if (run.status === "blocked") {
        record(transcript, {
          type: "gate",
          ...gateEventBase,
          outcome: "blocked",
          reason: run.message ?? String(run.reason),
          score: run.score,
          intentHash: run.intentHash,
          commitTxHash: run.commitTxHash,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: tool,
          content: `BLOCKED by the Avaira gate: ${run.message ?? run.reason} — execute_fn never ran.`,
        });
        return { final: "", spentUsd, blocked: { tool, reason: run.message ?? String(run.reason) }, runs };
      }

      record(transcript, {
        type: "gate",
        ...gateEventBase,
        outcome: "allowed",
        reason: "ALLOWED",
        score: run.score,
        intentHash: run.intentHash,
        commitTxHash: run.commitTxHash,
      });

      const out = run.result as Awaited<ReturnType<typeof executeTool>>;
      spentUsd += out.spendUsd;
      if (trail) {
        runs.push({ tool, run, trail, envelopeAllowedActions: [action], envelopeMaxSpendUsd: envelope.maxSpendUsd });
      }
      record(transcript, { type: "execution", tool, spendUsd: out.spendUsd.toString(), result: out.result });
      record(transcript, {
        type: "settlement",
        tool,
        outcomeHash: run.outcomeHash,
        merkleRoot: run.merkleRoot,
        attestTxHash: run.attestTxHash,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: tool,
        content: JSON.stringify({ ok: true, result: out.result, spendUsd: out.spendUsd.toString() }),
      });
    }
  }

  return { final: "(turn limit reached)", spentUsd, blocked: null, runs };
}
