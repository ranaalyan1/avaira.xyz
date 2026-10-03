/**
 * Avaira v2 — shared types.
 *
 * The whole thesis in one file: an agent commits what it is about to do, gets gated
 * before it acts, and anchors what it actually did. Reputation is derived from that
 * trail, never from raw feedback.
 */

/** Lifecycle of an agent inside Avaira's accountability layer (mirrors `AgentStatus`). */
export enum AgentStatus {
  NONE = 0,
  PENDING = 1,
  ACTIVE = 2,
  SUSPENDED = 3,
  BANNED = 4,
}

/** Why the gate allowed or blocked an action (mirrors `GateReason`). */
export enum GateReason {
  ALLOWED = 0,
  UNKNOWN_AGENT = 1,
  BANNED = 2,
  SUSPENDED = 3,
  STAKE_TOO_LOW = 4,
  SCORE_TOO_LOW = 5,
  INTENT_NOT_COMMITTED = 6,
  INTENT_EXPIRED = 7,
  INTENT_ALREADY_EXECUTED = 8,
  ENVELOPE_MISMATCH = 9,
}

/** Human-readable gate reasons, used in `run()` results and logs. */
export const GATE_REASON_TEXT: Record<GateReason, string> = {
  [GateReason.ALLOWED]: "allowed",
  [GateReason.UNKNOWN_AGENT]: "unknown agent: no ERC-8004 identity for this id",
  [GateReason.BANNED]: "banned: terminal accountability failure",
  [GateReason.SUSPENDED]: "suspended: stake slashed below requirement, re-collateralise and wait out the cooldown",
  [GateReason.STAKE_TOO_LOW]: "stake too low: lock more USDC against the agent identity",
  [GateReason.SCORE_TOO_LOW]: "score too low: Avaira Score below the protocol floor",
  [GateReason.INTENT_NOT_COMMITTED]: "intent not committed: commit the plan hash before executing",
  [GateReason.INTENT_EXPIRED]: "intent expired: the risk envelope deadline has passed",
  [GateReason.INTENT_ALREADY_EXECUTED]: "intent already executed: one commitment = one execution",
  [GateReason.ENVELOPE_MISMATCH]: "envelope mismatch: the local risk envelope differs from the committed one",
};

/**
 * The risk envelope an agent binds to a committed intent.
 * Enforced onchain by `checkGate` and provable after the fact by anyone.
 */
export interface RiskEnvelope {
  /** Maximum USD-denominated spend for this intent, in USDC units (6 decimals). */
  maxSpendUsd: bigint;
  /** Action discriminators the agent is allowed to perform. */
  allowedActions: string[];
  /** Unix seconds after which the intent is void. */
  deadline: bigint;
}

/** A single executed action, as published in the outcome Merkle tree. */
export interface ExecutedAction {
  action: string;
  spendUsd: bigint;
  /** Discriminates repeated identical actions; defaults to the audit sequence number. */
  nonce?: bigint;
}

export interface AvairaConfig {
  /** Monad RPC endpoint. */
  rpcUrl: string;
  /** Chain id (10143 testnet, 143 mainnet). */
  chainId: number;
  /** Deployed contract addresses (see `deployments/{chainId}.json`). */
  contracts: {
    identityRegistry: `0x${string}`;
    reputationRegistry: `0x${string}`;
    stakeRegistry: `0x${string}`;
    intentVault: `0x${string}`;
    validationRegistry?: `0x${string}`;
    creditMarket?: `0x${string}`;
    settlementToken?: `0x${string}`;
  };
  /** Agent operator account. Privy smart accounts (ERC-1271) work here. */
  account?: unknown;
  privateKey?: `0x${string}`;
  /** Gate latency budget for a committed intent to become visible, in ms. */
  commitVisibilityTimeoutMs?: number;
  /** Poll interval while waiting for commitment visibility, in ms. */
  pollIntervalMs?: number;
  /** Optional metrics endpoint (`POST {url}/api/metrics`). */
  metricsUrl?: string;
}

/** Result of `avaira.run()`. */
export type RunResult = CompletedRun | BlockedRun;

export interface CompletedRun {
  status: "completed";
  agentId: bigint;
  intentHash: `0x${string}`;
  outcomeHash: `0x${string}`;
  merkleRoot: `0x${string}`;
  score: number;
  /** Everything the caller needs to prove or audit the run. */
  timings: GateTimings;
  commitTxHash?: `0x${string}`;
  attestTxHash?: `0x${string}`;
  auditEntries: number;
  result: unknown;
}

export interface BlockedRun {
  status: "blocked";
  agentId: bigint;
  intentHash: `0x${string}`;
  score: number;
  reason: GateReason;
  /** Human-readable form of `reason`. */
  message: string;
  timings: GateTimings;
  commitTxHash?: `0x${string}`;
  /** Optional onchain trace of the denial (only written with `recordDecisions`). */
  decisionTxHash?: `0x${string}`;
}

/**
 * The numbers the submission is judged on. Measured client-side, per run,
 * against the live RPC — never estimated.
 */
export interface GateTimings {
  /** ms from submitting `commitIntent` to having the signed transaction accepted by the node. */
  commitSubmitMs: number;
  /** ms from submitting `commitIntent` to a satisfied intent-scoped `checkGate`. */
  gateLatencyMs: number;
  /** ms for the free agent-level `checkGate` call (no commitment required). */
  agentGateMs: number;
  /** ms spent in `execute_fn`. */
  executionMs: number;
  /** ms from `execute_fn` finishing to the attestation being accepted. */
  attestMs: number;
  /** Gate + execution: the pre-execution round trip an agent actually waits for. */
  totalMs: number;
  /** Whether the committed intent was visible to the gate before the timeout. */
  intentVisible: boolean;
}
