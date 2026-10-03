/**
 * @avaira/sdk — accountability for the agent economy, enforced on Monad.
 *
 * x402 lets agents pay. ERC-8004 lets agents be identified. Avaira makes agents
 * accountable in real time and turns that record into capital access.
 *
 * ```ts
 * import { Avaira, GateReason } from "@avaira/sdk";
 *
 * const avaira = new Avaira({
 *   rpcUrl: "https://testnet-rpc.monad.xyz",
 *   chainId: 10143,
 *   contracts: deployment,          // deployments/10143.json
 *   privateKey: process.env.AVAIRA_PRIVATE_KEY,
 * });
 *
 * const run = await avaira.run(
 *   agentId,
 *   { id: "invoice-4821", description: "reconcile Q3 invoices" },
 *   async ({ audit, envelope }) => {
 *     audit.append("web.search", 0n);              // hash-chained locally
 *     const data = await reconcile();
 *     audit.append("mcp.call", 250_000n);          // <= envelope.maxSpendUsd
 *     return data;
 *   },
 *   { envelope: { maxSpendUsd: 5_000_000n, allowedActions: ["web.search", "mcp.call"] } },
 * );
 *
 * if (run.status === "blocked") {
 *   console.error("gate blocked the action:", run.message);
 * }
 * ```
 */
export { Avaira, now, sleep, summariseActions } from "./avaira.js";
export type { RunOptions } from "./avaira.js";
export { AuditTrail, hashLeaf, hashPair, merkleProof, merkleRoot } from "./audit.js";
export type { AuditEntry } from "./audit.js";
export { MetricsReporter, percentile, stats } from "./metrics.js";
export type { RunMetric } from "./metrics.js";
export {
  AgentStatus,
  GateReason,
  GATE_REASON_TEXT,
} from "./types.js";
export type {
  AvairaConfig,
  BlockedRun,
  CompletedRun,
  ExecutedAction,
  GateTimings,
  RiskEnvelope,
  RunResult,
} from "./types.js";
export { monadMainnet, monadTestnet } from "./abi.js";
export { loadDeployment, defaultRpcUrl } from "./deployment.js";
export type { DeploymentManifest } from "./deployment.js";
export {
  CREDIT_MARKET_ABI,
  ERC20_ABI,
  GATE_AGENT_ABI,
  GATE_INTENT_ABI,
  IDENTITY_REGISTRY_ABI,
  INTENT_VAULT_ABI,
  REPUTATION_REGISTRY_ABI,
  STAKE_REGISTRY_ABI,
  VALIDATION_REGISTRY_ABI,
} from "./abi.js";

/** Canonical Solidity → SDK reason mapping for dashboards. */
export const GATE_REASON_LABELS = [
  "allowed",
  "unknown agent",
  "banned",
  "suspended",
  "stake too low",
  "score too low",
  "intent not committed",
  "intent expired",
  "intent already executed",
  "envelope mismatch",
] as const;
