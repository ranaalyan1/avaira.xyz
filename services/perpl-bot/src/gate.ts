/**
 * Avaira gate seam.
 *
 * `AvairaGate` is the real thing: every cycle is committed as an intent and executed through
 * `avaira.run()`, so the on-chain pre-execution gate decides whether the bot may quote at all.
 * A blocked decision never reaches `execute_fn`.
 *
 * `SimulatedGate` mirrors that contract in-process (score/status/spend checks, same shape) so
 * the bot, its tests and the offline demo can run without a chain. Decisions are labelled
 * `gate: "simulated"` everywhere they surface — the demo never pretends to be on-chain.
 */
import { Avaira, GateReason, GATE_REASON_TEXT, loadDeployment, type RiskEnvelope } from "@avaira/sdk";
import type { Hex } from "viem";

import type { BotConfig } from "./config";

export interface CycleIntent {
  cycle: number;
  /** Task id recorded on-chain; unique per cycle so intents never collide. */
  taskId: string;
  description: string;
  envelope: RiskEnvelope;
}

export interface GateOutcome<T> {
  allowed: boolean;
  reason: GateReason;
  reasonText: string;
  score: number | null;
  intentHash?: Hex;
  merkleRoot?: Hex;
  blockedBy?: "agent" | "intent" | "simulated" | "error";
  /** Wallet that failed the CVI requirement, when the block was CVI_UNVERIFIED. */
  cviBlocker?: Hex;
  result?: T;
  /** Everything `execute_fn` did, so the caller can journal the spend. */
  actions: { action: string; spendUsd: bigint; txHash?: Hex; detail?: string }[];
}

export interface Gate {
  readonly kind: "avaira" | "simulated";
  run<T>(intent: CycleIntent, executeFn: (ctx: { envelope: RiskEnvelope; intentHash: Hex }) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>): Promise<GateOutcome<T>>;
}

/* ───────────────────────────────── live gate ────────────────────────────────── */

export class AvairaGate implements Gate {
  readonly kind = "avaira" as const;
  private readonly avaira: Avaira;

  constructor(config: BotConfig) {
    const deployment = loadDeployment(config.chainId, config.deploymentPath);
    this.avaira = new Avaira({
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      privateKey: config.agentPrivateKey as Hex | undefined,
      contracts: {
        intentVault: deployment.intentVault,
        identityRegistry: deployment.identityRegistry,
        stakeRegistry: deployment.stakeRegistry,
        reputationRegistry: deployment.reputationRegistry,
        complianceGate: deployment.complianceGate,
      },
    });
  }

  async run<T>(
    intent: CycleIntent,
    executeFn: (ctx: { envelope: RiskEnvelope; intentHash: Hex }) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>,
  ): Promise<GateOutcome<T>> {
    const actions: GateOutcome<T>["actions"] = [];
    const outcome = await this.avaira.run(
      BigInt(this.agentId()),
      { id: intent.taskId, description: intent.description, cycle: intent.cycle },
      async ({ envelope, intentHash }) => {
        const executed = await executeFn({ envelope, intentHash });
        actions.push({ action: "perpl.cycle", spendUsd: executed.spendUsd, txHash: executed.txHashes?.[0], detail: "cycle executed" });
        return executed.result;
      },
      { envelope: intent.envelope, recordDecisions: true },
    );

    if (outcome.status === "blocked") {
      return {
        allowed: false,
        reason: outcome.reason,
        reasonText: outcome.message ?? GATE_REASON_TEXT[outcome.reason] ?? String(outcome.reason),
        score: outcome.score ?? null,
        intentHash: outcome.intentHash,
        blockedBy: outcome.reason === GateReason.CVI_UNVERIFIED ? "intent" : "agent",
        cviBlocker: outcome.cviBlocker,
        actions,
      };
    }

    return {
      allowed: true,
      reason: GateReason.ALLOWED,
      reasonText: "allowed",
      score: outcome.score ?? null,
      intentHash: outcome.intentHash,
      merkleRoot: outcome.merkleRoot,
      result: outcome.result as T,
      actions,
    };
  }

  agentId(): string {
    return process.env.AGENT_ID ?? "1";
  }
}

/* ─────────────────────────────── simulated gate ─────────────────────────────── */

export interface SimulatedGateState {
  score: number;
  status: "active" | "paused" | "frozen" | "suspended";
  cviValid: boolean;
  /** Simulated spend already consumed inside the current envelope. */
  spentUsd?: bigint;
}

export class SimulatedGate implements Gate {
  readonly kind = "simulated" as const;

  constructor(private state: SimulatedGateState, private readonly agentId = "1") {}

  setState(patch: Partial<SimulatedGateState>): void {
    this.state = { ...this.state, ...patch };
  }

  async run<T>(
    intent: CycleIntent,
    executeFn: (ctx: { envelope: RiskEnvelope; intentHash: Hex }) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>,
  ): Promise<GateOutcome<T>> {
    const intentHash = `0x${Buffer.from(`cycle-${intent.cycle}-${this.agentId}`).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;

    // Mirrors AvairaIntentVault.checkGate ordering: status → score → envelope sanity.
    if (this.state.status !== "active") {
      return blocked(GateReason.SUSPENDED, this.state.score, intentHash);
    }
    if (this.state.score < 60) {
      return blocked(GateReason.SCORE_TOO_LOW, this.state.score, intentHash);
    }
    if (intent.envelope.maxSpendUsd <= 0n) {
      return blocked(GateReason.ENVELOPE_MISMATCH, this.state.score, intentHash);
    }
    if (/cva\./.test(intent.envelope.allowedActions.join(",")) && !this.state.cviValid) {
      return { ...blocked(GateReason.CVI_UNVERIFIED, this.state.score, intentHash), blockedBy: "intent" };
    }
    if (intent.envelope.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      return blocked(GateReason.INTENT_EXPIRED, this.state.score, intentHash);
    }

    const executed: { result: T; spendUsd: bigint; txHashes?: Hex[] } = await executeFn({ envelope: intent.envelope, intentHash });
    if (executed.spendUsd > intent.envelope.maxSpendUsd) {
      return {
        ...blocked(GateReason.ENVELOPE_MISMATCH, this.state.score, intentHash),
        blockedBy: "intent",
        reasonText: `cycle spend ${executed.spendUsd} USD exceeded the envelope cap ${intent.envelope.maxSpendUsd} USD`,
      };
    }

    return {
      allowed: true,
      reason: GateReason.ALLOWED,
      reasonText: "allowed (simulated gate)",
      score: this.state.score,
      intentHash,
      result: executed.result,
      actions: [
        { action: "perpl.cycle", spendUsd: executed.spendUsd, txHash: executed.txHashes?.[0], detail: "cycle executed" },
      ],
    };
  }
}

/** Numeric enum → `"SCORE_TOO_LOW"` style label for logs and `/status`. */
export function gateReasonName(reason: GateReason): string {
  return GateReason[reason] ?? String(reason);
}

function blocked(reason: GateReason, score: number, intentHash: Hex): GateOutcome<never> {
  return {
    allowed: false,
    reason,
    reasonText: GATE_REASON_TEXT[reason] ?? String(reason),
    score,
    intentHash,
    blockedBy: "simulated",
    actions: [],
  };
}
