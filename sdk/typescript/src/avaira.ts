/**
 * Avaira v2 — `avaira.run(task, execute_fn)` with an onchain pre-execution gate.
 *
 * The v1 SDK ran a local validator and trusted itself. v2 does not trust the agent, the
 * SDK, or the operator:
 *
 *   1. commitIntent  — keccak256 of the full plan + risk envelope, submitted to Monad
 *                      (fire-and-forget: we never block on a receipt)
 *   2. checkGate     — a free `eth_call` against the latest state. Monad's 400ms blocks
 *                      and 800ms finality are what make this a *pre-execution* gate
 *                      rather than a 12-second Ethereum stall.
 *   3. execute_fn    — only if the gate allows; every action is hash-chained locally
 *   4. attestOutcome — anchor the outcome hash + Merkle root of the trail onchain, which
 *                      opens a 24h window in which anyone can prove a deviation.
 *
 * Latency is measured on every step and reported, never estimated.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  toHex,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AuditTrail } from "./audit.js";
import {
  COMPLIANCE_GATE_ABI,
  GATE_AGENT_ABI,
  GATE_INTENT_ABI,
  IDENTITY_REGISTRY_ABI,
  INTENT_VAULT_ABI,
  REPUTATION_REGISTRY_ABI,
  STAKE_REGISTRY_ABI,
  monadMainnet,
  monadTestnet,
} from "./abi.js";
import { MetricsReporter } from "./metrics.js";
import {
  AgentStatus,
  CVIStatus,
  GateReason,
  GATE_REASON_TEXT,
  type AvairaConfig,
  type ExecutedAction,
  type GateTimings,
  type RiskEnvelope,
  type RunResult,
} from "./types.js";

const ONE_HOUR = 3600n;

export interface RunOptions {
  /** Risk envelope bounding this intent. Defaults to `{ maxSpendUsd: 0n, allowedActions: [], deadline: now+1h }`. */
  envelope?: Partial<RiskEnvelope>;
  /** Records the trail locally only; set false to skip. Default true. */
  audit?: boolean;
  /** Writes blocked/allowed decisions onchain so denials are explorer-visible. Default false. */
  recordDecisions?: boolean;
  /** Overrides `commitVisibilityTimeoutMs` for this run. */
  commitVisibilityTimeoutMs?: number;
}

export class Avaira {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly account?: Account;
  readonly config: AvairaConfig;
  private readonly metrics?: MetricsReporter;
  private nonceCounter = 0n;

  constructor(config: AvairaConfig) {
    this.config = config;
    const chain = config.chainId === 143 ? monadMainnet : monadTestnet;
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient;

    if (config.privateKey) {
      this.account = privateKeyToAccount(config.privateKey);
    } else if (config.account) {
      this.account = config.account as Account;
    }
    if (this.account) {
      this.walletClient = createWalletClient({ chain, transport: http(config.rpcUrl), account: this.account });
    }
    if (config.metricsUrl) this.metrics = new MetricsReporter(config.metricsUrl, config.chainId);
  }

  /* ─────────────────────────────  the product  ───────────────────────────── */

  /**
   * Runs `execute_fn` behind the Avaira gate.
   *
   * Returns `"completed"` with the anchored outcome, or `"blocked"` with the onchain
   * reason — in which case `execute_fn` is never called.
   */
  async run<T>(
    agentId: bigint,
    task: { id: string; description?: string; [key: string]: unknown },
    executeFn: (ctx: { audit: AuditTrail; envelope: RiskEnvelope; intentHash: Hex }) => Promise<T> | T,
    options: RunOptions = {},
  ): Promise<RunResult> {
    if (!this.walletClient || !this.account) {
      throw new Error("Avaira.run requires a signer (privateKey or account)");
    }

    const envelope = this.resolveEnvelope(options.envelope);
    const nonce = this.nextNonce();
    const envelopeHash = this.hashEnvelope(envelope);
    const planHash = keccak256(
      encodeAbiParameters(parseAbiParameters("string domain, uint256 agentId, string taskId, string taskJson, bytes32 envelopeHash, uint256 nonce"), [
        "Avaira.Intent.v1",
        agentId,
        task.id,
        JSON.stringify(task),
        envelopeHash,
        nonce,
      ]),
    );

    // ── 1. the free agent-level gate: no commitment required, one RPC round trip ──
    const agentGateStart = now();
    const [agentAllowed, agentScore, agentReason] = await this.checkGate(agentId);
    const agentGateMs = now() - agentGateStart;

    const timings: GateTimings = {
      commitSubmitMs: 0,
      gateLatencyMs: 0,
      agentGateMs,
      executionMs: 0,
      attestMs: 0,
      totalMs: 0,
      intentVisible: false,
    };

    if (!agentAllowed) {
      await this.metrics?.record({
        agentId: agentId.toString(),
        intentHash: planHash,
        allowed: false,
        reason: agentReason,
        score: agentScore,
        timings,
      });
      return {
        status: "blocked",
        agentId,
        intentHash: planHash,
        score: agentScore,
        reason: agentReason,
        message: GATE_REASON_TEXT[agentReason],
        timings,
      };
    }

    // ── 2. commit the intent — fire and forget, never await a receipt ────────────
    const t0 = now();
    const commitPromise = this.commitIntent(agentId, planHash, envelope);
    const commitTxHash = await commitPromise;
    timings.commitSubmitMs = now() - t0;

    // ── 3. the gate, bound to that commitment ────────────────────────────────────
    const gate = await this.waitForIntentGate(agentId, planHash, envelopeHash, options.commitVisibilityTimeoutMs);
    timings.gateLatencyMs = now() - t0;
    timings.intentVisible = gate.allowed;
    const score = gate.score > 0 ? gate.score : agentScore;

    if (!gate.allowed) {
      const decisionTxHash = options.recordDecisions
        ? await this.recordGateDecision(agentId, planHash, false, gate.reason, Math.round(timings.gateLatencyMs))
        : undefined;
      await this.metrics?.record({
        agentId: agentId.toString(),
        intentHash: planHash,
        allowed: false,
        reason: gate.reason,
        score,
        timings,
      });
      return {
        status: "blocked",
        agentId,
        intentHash: planHash,
        score,
        reason: gate.reason,
        message: GATE_REASON_TEXT[gate.reason],
        timings,
        commitTxHash,
        decisionTxHash,
      };
    }

    // ── 4. execute, hash-chaining every action locally ───────────────────────────
    const audit = new AuditTrail(agentId, planHash);
    const executionStart = now();
    let result: T;
    try {
      result = await executeFn({ audit, envelope, intentHash: planHash });
    } catch (error) {
      timings.executionMs = now() - executionStart;
      timings.totalMs = timings.gateLatencyMs + timings.executionMs;
      await this.metrics?.record({
        agentId: agentId.toString(),
        intentHash: planHash,
        allowed: true,
        reason: GateReason.ALLOWED,
        score,
        timings,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    timings.executionMs = now() - executionStart;

    // ── 5. anchor the outcome + Merkle root of the audit trail ───────────────────
    const attestStart = now();
    const merkleRoot = audit.merkleRoot();
    const outcomeHash = audit.headHash;
    const attestTxHash = options.audit === false
      ? undefined
      : await this.attestOutcome(agentId, planHash, outcomeHash, merkleRoot);
    timings.attestMs = now() - attestStart;
    timings.totalMs = timings.gateLatencyMs + timings.executionMs;

    await this.metrics?.record({
      agentId: agentId.toString(),
      intentHash: planHash,
      allowed: true,
      reason: GateReason.ALLOWED,
      score,
      timings,
      auditEntries: audit.size,
    });

    return {
      status: "completed",
      agentId,
      intentHash: planHash,
      outcomeHash,
      merkleRoot,
      score,
      timings,
      commitTxHash,
      attestTxHash,
      auditEntries: audit.size,
      result,
    };
  }

  /* ─────────────────────────────  onchain surface  ───────────────────────── */

  /** Submits `commitIntent` and resolves with the transaction hash as soon as it is accepted. */
  async commitIntent(agentId: bigint, intentHash: Hex, envelope: RiskEnvelope): Promise<Hex> {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.config.contracts.intentVault,
      abi: INTENT_VAULT_ABI,
      functionName: "commitIntent",
      args: [
        agentId,
        intentHash,
        {
          maxSpendUsd: envelope.maxSpendUsd,
          allowedActions: envelope.allowedActions,
          deadline: envelope.deadline,
        },
      ],
      account: this.account!,
      chain: null,
    });
  }

  /** Anchors the outcome hash and the Merkle root of the local audit trail. */
  async attestOutcome(agentId: bigint, intentHash: Hex, outcomeHash: Hex, merkleRoot: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    return wallet.writeContract({
      address: this.config.contracts.intentVault,
      abi: INTENT_VAULT_ABI,
      functionName: "attestOutcome",
      args: [agentId, intentHash, outcomeHash, merkleRoot],
      account: this.account!,
      chain: null,
    });
  }

  /** The gate. Free, read-only, never waits for a transaction. */
  async checkGate(agentId: bigint): Promise<[boolean, number, GateReason]> {
    const [allowed, score, reason] = await this.publicClient.readContract({
      address: this.config.contracts.intentVault,
      abi: GATE_AGENT_ABI,
      functionName: "checkGate",
      args: [agentId],
    });
    return [allowed, Number(score), Number(reason) as GateReason];
  }

  /** The gate, bound to a specific commitment and envelope. */
  async checkGateForIntent(agentId: bigint, intentHash: Hex, envelopeHash: Hex): Promise<[boolean, number, GateReason]> {
    const [allowed, score, reason] = await this.publicClient.readContract({
      address: this.config.contracts.intentVault,
      abi: GATE_INTENT_ABI,
      functionName: "checkGate",
      args: [agentId, intentHash, envelopeHash],
    });
    return [allowed, Number(score), Number(reason) as GateReason];
  }

  async statusOf(agentId: bigint): Promise<AgentStatus> {
    const status = await this.publicClient.readContract({
      address: this.config.contracts.stakeRegistry,
      abi: STAKE_REGISTRY_ABI,
      functionName: "statusOf",
      args: [agentId],
    });
    return Number(status) as AgentStatus;
  }

  async stakeOf(agentId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.contracts.stakeRegistry,
      abi: STAKE_REGISTRY_ABI,
      functionName: "stakeOf",
      args: [agentId],
    });
  }

  async isEligible(agentId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.contracts.stakeRegistry,
      abi: STAKE_REGISTRY_ABI,
      functionName: "isEligible",
      args: [agentId],
    });
  }

  async scoreOf(agentId: bigint): Promise<number> {
    const score = await this.publicClient.readContract({
      address: this.config.contracts.reputationRegistry,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "scoreOf",
      args: [agentId],
    });
    return Number(score);
  }

  async gradeOf(agentId: bigint): Promise<string> {
    return this.publicClient.readContract({
      address: this.config.contracts.reputationRegistry,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "gradeOf",
      args: [agentId],
    });
  }

  async agentRegistry(): Promise<string> {
    return this.publicClient.readContract({
      address: this.config.contracts.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "agentRegistry",
    });
  }

  /** Operator of an agent id — the account allowed to commit intents for it. */
  async ownerOf(agentId: bigint): Promise<`0x${string}`> {
    return this.publicClient.readContract({
      address: this.config.contracts.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "ownerOf",
      args: [agentId],
    });
  }

  /* ─────────────────────── Cleanverse CVI/CVA compliance ─────────────────── */

  private complianceGateAddress(): `0x${string}` {
    const gate = this.config.contracts.complianceGate;
    if (!gate) throw new Error("Avaira: complianceGate not configured for this deployment");
    return gate;
  }

  /** Effective Cleanverse CVI status of `wallet` (NONE/VALID/EXPIRED/REVOKED). */
  async cviStatusOf(wallet: `0x${string}`): Promise<CVIStatus> {
    const status = await this.publicClient.readContract({
      address: this.complianceGateAddress(),
      abi: COMPLIANCE_GATE_ABI,
      functionName: "statusOf",
      args: [wallet],
    });
    return Number(status) as CVIStatus;
  }

  /** True when `wallet` holds a valid, unexpired, unrevoked CVI credential. */
  async isCviVerified(wallet: `0x${string}`): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.complianceGateAddress(),
      abi: COMPLIANCE_GATE_ABI,
      functionName: "isWalletVerified",
      args: [wallet],
    });
  }

  /** Non-reverting Travel-Rule check for a CVA transfer. */
  async checkCvaTransfer(
    from: `0x${string}`,
    to: `0x${string}`,
  ): Promise<{ allowed: boolean; failing: `0x${string}`; reason: CVIStatus }> {
    const [allowed, failing, reason] = await this.publicClient.readContract({
      address: this.complianceGateAddress(),
      abi: COMPLIANCE_GATE_ABI,
      functionName: "checkCVATransfer",
      args: [from, to],
    });
    return { allowed, failing, reason: Number(reason) as CVIStatus };
  }

  /**
   * Registers (or refreshes) a wallet-bound CVI credential onchain.
   *
   * `issuerSignature` must be the configured Cleanverse issuer's EIP-191 personal
   * signature over `keccak256(abi.encode(wallet, credentialHash, expiry))`. This is
   * normally produced by the offchain CVI verification service (`services/cvi`),
   * which calls the Cleanverse CCP API before signing; exposed here so tests and
   * demos can drive the full flow with a locally held issuer key.
   */
  async verifyCvi(
    wallet: `0x${string}`,
    credentialHash: `0x${string}`,
    expiry: bigint,
    issuerSignature: `0x${string}`,
  ): Promise<`0x${string}`> {
    const w = this.requireWallet();
    return w.writeContract({
      address: this.complianceGateAddress(),
      abi: COMPLIANCE_GATE_ABI,
      functionName: "verifyCVI",
      args: [wallet, credentialHash, expiry, issuerSignature],
      account: this.account!,
      chain: null,
    });
  }

  /**
   * Builds the EIP-191 personal-sign digest payload the Cleanverse issuer signs for a
   * CVI credential: `keccak256(abi.encode(wallet, credentialHash, expiry))`.
   */
  cviCredentialPayload(wallet: `0x${string}`, credentialHash: `0x${string}`, expiry: bigint): Hex {
    return keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32 typehash, address wallet, bytes32 credentialHash, uint64 expiry"),
        [
          keccak256(toHex("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)")),
          wallet,
          credentialHash,
          expiry,
        ],
      ),
    );
  }

  /* ─────────────────────────────────  helpers  ──────────────────────────────── */

  /** EIP-712-style struct hash of an envelope; identical to `RiskEnvelopeLib.hash`. */
  hashEnvelope(envelope: RiskEnvelope): Hex {
    return keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32 typehash, uint256 maxSpendUsd, bytes32 allowedActionsHash, uint64 deadline"),
        [
          keccak256(
            toHex("RiskEnvelope(uint256 maxSpendUsd,bytes32 allowedActionsHash,uint64 deadline)"),
          ),
          envelope.maxSpendUsd,
          keccak256(encodeAbiParameters(parseAbiParameters("string[]"), [envelope.allowedActions])),
          envelope.deadline,
        ],
      ),
    );
  }

  /**
   * Polls the intent-scoped gate until it clears or the budget is spent.
   *
   * This is the only place the SDK waits on the chain, and it waits on *speculative*
   * inclusion (latest state), never on full finality — slashing-critical paths are the
   * only ones that need the latter.
   */
  async waitForIntentGate(
    agentId: bigint,
    intentHash: Hex,
    envelopeHash: Hex,
    timeoutMs = this.config.commitVisibilityTimeoutMs ?? 2000,
  ): Promise<{ allowed: boolean; score: number; reason: GateReason }> {
    const pollInterval = this.config.pollIntervalMs ?? 100;
    const deadline = now() + timeoutMs;
    let last: [boolean, number, GateReason] = [false, 0, GateReason.INTENT_NOT_COMMITTED];

    for (;;) {
      try {
        last = await this.checkGateForIntent(agentId, intentHash, envelopeHash);
        // A committed intent is visible: any other answer is final for this run.
        if (last[0] || last[2] !== GateReason.INTENT_NOT_COMMITTED) {
          return { allowed: last[0], score: last[1], reason: last[2] };
        }
      } catch {
        // transient RPC error: keep polling until the budget runs out
      }
      if (now() >= deadline) return { allowed: false, score: last[1], reason: GateReason.INTENT_NOT_COMMITTED };
      await sleep(pollInterval);
    }
  }

  private async recordGateDecision(
    agentId: bigint,
    intentHash: Hex,
    allowed: boolean,
    reason: GateReason,
    latencyMs: number,
  ): Promise<Hex | undefined> {
    try {
      const wallet = this.requireWallet();
      return await wallet.writeContract({
        address: this.config.contracts.intentVault,
        abi: INTENT_VAULT_ABI,
        functionName: "recordGateDecision",
        args: [agentId, intentHash, allowed, reason, Math.min(Math.round(latencyMs), 0xffffffff)],
        account: this.account!,
        chain: null,
      });
    } catch {
      return undefined;
    }
  }

  private resolveEnvelope(partial?: Partial<RiskEnvelope>): RiskEnvelope {
    return {
      maxSpendUsd: partial?.maxSpendUsd ?? 0n,
      allowedActions: partial?.allowedActions ?? [],
      deadline: partial?.deadline ?? BigInt(Math.floor(Date.now() / 1000)) + ONE_HOUR,
    };
  }

  private nextNonce(): bigint {
    this.nonceCounter += 1n;
    return BigInt(`${Date.now()}${this.nonceCounter}`);
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient) throw new Error("Avaira: no signer configured");
    return this.walletClient;
  }
}

export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience: derives a run summary from an audit trail (used by the demo + dashboards). */
export function summariseActions(actions: ExecutedAction[]): { count: number; totalUsd: bigint; actions: string[] } {
  return {
    count: actions.length,
    totalUsd: actions.reduce((sum, a) => sum + a.spendUsd, 0n),
    actions: [...new Set(actions.map((a) => a.action))],
  };
}
