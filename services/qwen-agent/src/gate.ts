/**
 * Avaira gate seam for the Qwen agent.
 *
 * `AvairaGate` is production: every tool call is committed as an intent and executed inside
 * `avaira.run()`, so the on-chain pre-execution gate (identity, stake, score, envelope, and
 * the Cleanverse CVI requirement for `cva.*` actions) decides before the tool runs.
 *
 * `SimulatedGate` mirrors the same decision order in-process for tests and offline demos.
 */
import { AuditTrail, Avaira, GateReason, GATE_REASON_TEXT, loadDeployment, type RiskEnvelope } from "@avaira/sdk";
import type { Hex } from "viem";

export interface StepIntent {
  step: number;
  taskId: string;
  description: string;
  envelope: RiskEnvelope;
}

export interface GateOutcome<T> {
  allowed: boolean;
  reason: string;
  reasonText: string;
  score: number | null;
  intentHash?: Hex;
  merkleRoot?: Hex;
  /** Head of the (uncommitted) local audit chain in simulated mode. */
  auditHead?: Hex;
  commitTxHash?: Hex;
  attestTxHash?: Hex;
  cviBlocker?: Hex;
  blockedBy?: "agent" | "intent" | "simulated" | "error";
  result?: T;
  spendUsd: bigint;
}

export interface ExecuteCtx {
  envelope: RiskEnvelope;
  intentHash: Hex;
  audit: AuditTrail;
}

export interface Gate {
  readonly kind: "avaira" | "simulated";
  run<T>(
    intent: StepIntent,
    executeFn: (ctx: ExecuteCtx) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>,
  ): Promise<GateOutcome<T>>;
}

/* ───────────────────────────────── live gate ────────────────────────────────── */

export interface AvairaGateConfig {
  chainId: number;
  rpcUrl: string;
  deploymentPath?: string;
  agentId: bigint;
  privateKey?: Hex;
  /** Writes blocked/allowed decisions on-chain so denials are explorer-visible. */
  recordDecisions?: boolean;
}

export class AvairaGate implements Gate {
  readonly kind = "avaira" as const;
  private readonly avaira: Avaira;

  constructor(private readonly config: AvairaGateConfig) {
    const deployment = loadDeployment(config.chainId, config.deploymentPath);
    this.avaira = new Avaira({
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      privateKey: config.privateKey,
      contracts: {
        intentVault: deployment.intentVault,
        identityRegistry: deployment.identityRegistry,
        stakeRegistry: deployment.stakeRegistry,
        reputationRegistry: deployment.reputationRegistry,
        complianceGate: deployment.complianceGate,
      },
    });
  }

  get client(): Avaira {
    return this.avaira;
  }

  async run<T>(
    intent: StepIntent,
    executeFn: (ctx: ExecuteCtx) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>,
  ): Promise<GateOutcome<T>> {
    const outcome = await this.avaira.run(
      this.config.agentId,
      { id: intent.taskId, description: intent.description, step: intent.step },
      async (ctx) => {
        const executed = await executeFn({ envelope: ctx.envelope, intentHash: ctx.intentHash, audit: ctx.audit });
        return executed.result;
      },
      { envelope: intent.envelope, recordDecisions: this.config.recordDecisions ?? true },
    );

    if (outcome.status === "blocked") {
      return {
        allowed: false,
        reason: GateReason[outcome.reason] ?? String(outcome.reason),
        reasonText: outcome.message ?? GATE_REASON_TEXT[outcome.reason] ?? String(outcome.reason),
        score: outcome.score ?? null,
        intentHash: outcome.intentHash,
        commitTxHash: outcome.commitTxHash,
        cviBlocker: outcome.cviBlocker,
        blockedBy: outcome.commitTxHash ? "intent" : "agent",
        spendUsd: 0n,
      };
    }

    return {
      allowed: true,
      reason: "OK",
      reasonText: "allowed",
      score: outcome.score ?? null,
      intentHash: outcome.intentHash,
      merkleRoot: outcome.merkleRoot,
      commitTxHash: outcome.commitTxHash,
      attestTxHash: outcome.attestTxHash,
      spendUsd: 0n, // the caller reports the real spend from the tool result
    };
  }
}

/* ─────────────────────────────── simulated gate ─────────────────────────────── */

export interface SimulatedGateState {
  score: number;
  status: "active" | "paused" | "suspended" | "banned";
  cviValid: boolean;
}

export class SimulatedGate implements Gate {
  readonly kind = "simulated" as const;

  constructor(private state: SimulatedGateState, private readonly agentId: bigint = 1n) {}

  setState(patch: Partial<SimulatedGateState>): void {
    this.state = { ...this.state, ...patch };
  }

  async run<T>(
    intent: StepIntent,
    executeFn: (ctx: ExecuteCtx) => Promise<{ result: T; spendUsd: bigint; txHashes?: Hex[] }>,
  ): Promise<GateOutcome<T>> {
    const intentHash = `0x${Buffer.from(`step-${intent.step}-${this.agentId}`).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;
    // A real hash-chained trail, so tools behave identically offline and on-chain. It is not
    // anchored by the simulated gate, so `merkleRoot` stays undefined in the outcome.
    const audit = new AuditTrail(this.agentId, intentHash);

    if (this.state.status !== "active") {
      return blocked("SUSPENDED", this.state.score, intentHash, GATE_REASON_TEXT[GateReason.SUSPENDED]);
    }
    if (this.state.score < 60) {
      return blocked("SCORE_TOO_LOW", this.state.score, intentHash, GATE_REASON_TEXT[GateReason.SCORE_TOO_LOW]);
    }
    if (intent.envelope.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      return blocked("INTENT_EXPIRED", this.state.score, intentHash, GATE_REASON_TEXT[GateReason.INTENT_EXPIRED]);
    }
    if (intent.envelope.allowedActions.some((action) => action.startsWith("cva.")) && !this.state.cviValid) {
      return {
        ...blocked("CVI_UNVERIFIED", this.state.score, intentHash, GATE_REASON_TEXT[GateReason.CVI_UNVERIFIED]),
        blockedBy: "intent",
      };
    }

    const executed = await executeFn({ envelope: intent.envelope, intentHash, audit });
    const auditHead = audit.headHash;
    if (executed.spendUsd > intent.envelope.maxSpendUsd) {
      // The on-chain vault cannot see inside execute_fn; the deviation is caught by the
      // post-hoc Merkle challenge instead (scenario c). The simulated gate mirrors that.
      return {
        allowed: true,
        reason: "OK",
        reasonText: "allowed — spend above the envelope will be provable by challengeDeviation",
        score: this.state.score,
        intentHash,
        auditHead,
        spendUsd: executed.spendUsd,
      };
    }

    return {
      allowed: true,
      reason: "OK",
      reasonText: "allowed (simulated gate)",
      score: this.state.score,
      intentHash,
      auditHead,
      spendUsd: executed.spendUsd,
    };
  }
}

function blocked(
  reason: string,
  score: number,
  intentHash: Hex,
  reasonText?: string,
): GateOutcome<never> {
  return {
    allowed: false,
    reason,
    reasonText: reasonText ?? reason,
    score,
    intentHash,
    blockedBy: "simulated",
    spendUsd: 0n,
  };
}
