/**
 * The agent loop.
 *
 *   plan (Qwen) → for every tool call: avaira.run() → gate → execute_fn → journal
 *
 * The loop is built so the gate is unavoidable: tool calls are not executed directly. Each
 * call is committed as an Avaira intent whose risk envelope carries the call's spend as
 * `maxSpendUsd` and the call's action in `allowedActions`; the on-chain pre-execution gate
 * decides. When it refuses, `execute_fn` is never entered and the transcript says so.
 */
import { AuditTrail, GateReason, GATE_REASON_TEXT, type RiskEnvelope } from "@avaira/sdk";
import type { Hex } from "viem";

import type { Gate } from "./gate.js";
import type { PlannedCall, Planner } from "./qwen.js";
import { formatUsd } from "./qwen.js";

export interface ToolResult {
  ok: boolean;
  detail: string;
  spendUsd: bigint;
  txHash?: Hex;
}

export interface Tool {
  name: string;
  action: string;
  execute(call: PlannedCall, ctx: { intentHash: Hex; audit: AuditTrail }): Promise<ToolResult>;
}

export interface StepTranscript {
  step: number;
  tool: string;
  action: string;
  requestedUsd: string;
  rationale: string;
  gate: {
    kind: "avaira" | "simulated";
    allowed: boolean;
    reason: string;
    reasonText: string;
    score: number | null;
    intentHash?: string;
    merkleRoot?: string;
    auditHead?: string;
    cviBlocker?: string;
  };
  executed: boolean;
  detail: string;
  spendUsd: string;
  txHash?: string;
}

export interface RunTranscript {
  task: string;
  role: string;
  planner: "qwen" | "offline";
  model: string;
  budgetUsd: string;
  spendUsd: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "blocked" | "failed";
  blockedAtStep?: number;
  blockReason?: string;
  steps: StepTranscript[];
  /** On-chain evidence: the intent commitment and the anchored Merkle root of the trail. */
  commitments: { intentHash: string; commitTxHash?: string; attestTxHash?: string; merkleRoot?: string }[];
}

export interface QwenAgentOptions {
  planner: Planner;
  gate: Gate;
  tools: Tool[];
  task: string;
  role?: string;
  budgetUsd: bigint;
  log?: (...parts: unknown[]) => void;
  /** Test hook: a forged trailing audit entry to demonstrate the slash path. */
  afterSteps?: (transcript: RunTranscript) => void;
  /**
   * Overrides the envelope built for a step. Used by the blocked-cycle demo to hand the gate a
   * short deadline so the refusal comes from the vault, not from this loop.
   */
  envelopeFor?: (call: PlannedCall, step: number, base: RiskEnvelope) => RiskEnvelope;
  /**
   * Awaited after the envelope is built and before the gate runs — models a plan that went
   * stale while an approval was pending.
   */
  beforeGate?: (call: PlannedCall, step: number) => Promise<void>;
}

export class QwenAgent {
  private readonly log: (...parts: unknown[]) => void;

  constructor(private readonly options: QwenAgentOptions) {
    this.log = options.log ?? ((...parts: unknown[]) => console.log(...parts));
  }

  async run(): Promise<RunTranscript> {
    const { planner, gate, tools, task, budgetUsd } = this.options;
    const role = this.options.role ?? "treasury";
    const startedAt = new Date().toISOString();
    const transcript: RunTranscript = {
      task,
      role,
      planner: planner.kind,
      model: planner.model,
      budgetUsd: formatUsd(budgetUsd),
      spendUsd: "0",
      startedAt,
      finishedAt: startedAt,
      status: "completed",
      steps: [],
      commitments: [],
    };

    this.log(`\n  planning with ${planner.kind === "qwen" ? `Qwen ${planner.model}` : "offline planner"} …`);
    const plan = await planner.plan({ task, budgetUsd, role });
    this.log(`  plan: ${plan.length} tool call(s)`);
    for (const call of plan) {
      this.log(`    · ${call.tool} [${call.action}] ${formatUsd(call.spendUsd)} USD — ${call.rationale}`);
    }

    // Envelope for this cycle: the budget is a hard ceiling, and only the actions the plan
    // uses are allowed. A plan that needs more than the budget fails the gate, by design.
    const plannedSpend = plan.reduce((sum, call) => sum + call.spendUsd, 0n);
    let spent = 0n;

    for (const [index, call] of plan.entries()) {
      const step = index + 1;
      const tool = tools.find((candidate) => candidate.name === call.tool);
      if (!tool) {
        transcript.status = "failed";
        transcript.blockReason = `unknown tool "${call.tool}"`;
        transcript.steps.push(blockedStep(step, call, "UNKNOWN_TOOL", `no tool named ${call.tool}`, gate.kind));
        break;
      }

      // ── envelope policy: the gate's job is to refuse, not to fix the model's arithmetic ──
      // The cycle budget is a hard ceiling. A call that asks for more than the budget, or for
      // an action outside the role's allow-list, is refused *before* anything is committed, so
      // `execute_fn` is never entered. This mirrors what the on-chain gate does for envelopes
      // it can see (score, stake, deadline, CVI) and what `challengeDeviation` does for spend
      // the chain cannot see.
      const remaining = budgetUsd - spent;
      const policyFailure = checkEnvelope(call, {
        remainingUsd: remaining,
        allowedActions: ALLOWED_ACTIONS[role] ?? [call.action],
      });
      if (policyFailure) {
        transcript.status = "blocked";
        transcript.blockedAtStep = step;
        transcript.blockReason = `${policyFailure.reason}: ${policyFailure.message}`;
        transcript.steps.push({
          ...blockedStep(step, call, policyFailure.reason, policyFailure.message, gate.kind),
          gate: {
            kind: gate.kind,
            allowed: false,
            reason: policyFailure.reason,
            reasonText: policyFailure.message,
            score: null,
          },
        });
        this.log(`    ✗ step ${step} ${call.tool} refused by envelope policy: ${policyFailure.message} (execute_fn ran: false)`);
        break;
      }

      // Per-call envelope: the call's own spend is the ceiling, so an oversized proposal is
      // refused rather than clamped — the model is told what it may do, not fixed up.
      const baseEnvelope: RiskEnvelope = {
        maxSpendUsd: call.spendUsd > 0n ? call.spendUsd : 1n,
        allowedActions: [call.action],
        deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
      };
      const envelope = this.options.envelopeFor?.(call, step, baseEnvelope) ?? baseEnvelope;

      let executed = false;
      let detail = "";
      let spendThisStep = 0n;
      let txHash: string | undefined;

      await this.options.beforeGate?.(call, step);

      let outcome;
      try {
        outcome = await gate.run(
          {
            step,
            taskId: `${role}-step-${step}`,
            description: `${call.tool}: ${call.rationale}`,
            envelope,
          },
          async ({ intentHash, audit }) => {
            executed = true;
            const result = await tool.execute(call, { intentHash, audit });
            detail = result.detail;
            spendThisStep = result.spendUsd;
            txHash = result.txHash;
            return { result: null, spendUsd: result.spendUsd, txHashes: result.txHash ? [result.txHash] : [] };
          },
        );
      } catch (error) {
        // A revert while committing (e.g. an envelope whose deadline passed before the
        // transaction landed) is a refusal by the protocol: record it and stop the cycle.
        const message = (error as { shortMessage?: string }).shortMessage ?? (error as Error).message;
        transcript.status = "blocked";
        transcript.blockedAtStep = step;
        transcript.blockReason = `COMMIT_REJECTED: ${message}`;
        transcript.steps.push({
          ...blockedStep(step, call, "COMMIT_REJECTED", message, gate.kind),
          gate: { kind: gate.kind, allowed: false, reason: "COMMIT_REJECTED", reasonText: message, score: null },
          executed: false,
        });
        this.log(`    ✗ step ${step} ${call.tool} rejected at commit: ${message}`);
        break;
      }

      spent += outcome.allowed ? spendThisStep : 0n;
      transcript.spendUsd = formatUsd(spent);
      transcript.steps.push({
        step,
        tool: call.tool,
        action: call.action,
        requestedUsd: formatUsd(call.spendUsd),
        rationale: call.rationale,
        gate: {
          kind: gate.kind,
          allowed: outcome.allowed,
          reason: outcome.allowed ? "OK" : outcome.reason,
          reasonText: outcome.reasonText,
          score: outcome.score,
          intentHash: outcome.intentHash,
          merkleRoot: outcome.merkleRoot,
          auditHead: outcome.auditHead,
          cviBlocker: outcome.cviBlocker,
        },
        executed,
        detail: detail || outcome.reasonText,
        spendUsd: formatUsd(spendThisStep),
        txHash,
      });

      if (outcome.allowed) {
        transcript.commitments.push({
          intentHash: outcome.intentHash ?? "",
          commitTxHash: outcome.commitTxHash,
          attestTxHash: outcome.attestTxHash,
          merkleRoot: outcome.merkleRoot,
        });
        this.log(`    ✓ step ${step} ${call.tool} allowed — ${detail}`);
      } else {
        transcript.status = "blocked";
        transcript.blockedAtStep = step;
        transcript.blockReason = `${outcome.reason}: ${outcome.reasonText}`;
        this.log(`    ✗ step ${step} ${call.tool} BLOCKED (${outcome.reason}) — execute_fn ran: ${executed}`);
        // A blocked step stops the cycle: nothing after it is attempted.
        break;
      }
    }

    transcript.finishedAt = new Date().toISOString();
    this.options.afterSteps?.(transcript);
    return transcript;
  }
}

/** Actions each role may use; anything else is an envelope violation. */
export const ALLOWED_ACTIONS: Record<string, string[]> = {
  treasury: ["treasury.read", "cva.transfer", "cva.settle", "treasury.report"],
  trading: ["perpl.quote", "perpl.place_order", "perpl.cancel_order", "perpl.settle"],
};

export interface EnvelopeViolation {
  reason: "SPEND_EXCEEDED" | "ACTION_NOT_ALLOWED";
  message: string;
}

/**
 * The Cognitive-OS-side half of the guardrail: everything the on-chain gate cannot see about
 * the plan itself. Pure and cheap, so it runs before any transaction is committed.
 */
export function checkEnvelope(
  call: PlannedCall,
  limits: { remainingUsd: bigint; allowedActions: string[] },
): EnvelopeViolation | null {
  if (call.spendUsd > limits.remainingUsd) {
    return {
      reason: "SPEND_EXCEEDED",
      message: `proposed spend ${formatUsd(call.spendUsd)} USD exceeds the remaining cycle budget ${formatUsd(
        limits.remainingUsd,
      )} USD`,
    };
  }
  if (!limits.allowedActions.includes(call.action)) {
    return {
      reason: "ACTION_NOT_ALLOWED",
      message: `action "${call.action}" is outside the role envelope (${limits.allowedActions.join(", ")})`,
    };
  }
  return null;
}

function blockedStep(step: number, call: PlannedCall, reason: string, reasonText: string, kind: "avaira" | "simulated"): StepTranscript {
  return {
    step,
    tool: call.tool,
    action: call.action,
    requestedUsd: formatUsd(call.spendUsd),
    rationale: call.rationale,
    gate: { kind, allowed: false, reason, reasonText, score: null },
    executed: false,
    detail: reasonText,
    spendUsd: "0",
  };
}

/** Human-readable gate reason for a numeric enum, e.g. `CVI_UNVERIFIED`. */
export function reasonName(reason: GateReason | string): string {
  if (typeof reason === "string") return reason;
  return GateReason[reason] ?? String(reason);
}

export { GATE_REASON_TEXT };
