/** Shared types: config, LLM messages, transcript events. */
import "dotenv/config";
import type { Hex } from "viem";

export interface QwenConfig {
  chainId: number;
  rpcUrl: string;
  manifestPath?: string;
  operatorKey: Hex;
  challengerKey: Hex;
  agentId?: bigint;
  autoProvision: boolean;

  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;

  taskBudgetUsd: number;
  taskWindowSec: number;
  transcriptsDir: string;
}

const DEFAULT_ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEFAULT_CHALLENGER_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b406d2892";

export function loadQwenConfig(): QwenConfig {
  const apiKey = process.env.QWEN_API_KEY || undefined;
  const mock = process.env.QWEN_MOCK === "1" || (!apiKey && process.env.QWEN_MOCK !== "0");
  return {
    chainId: Number(process.env.CHAIN_ID ?? 10143),
    rpcUrl: process.env.QWEN_RPC_URL ?? process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
    manifestPath: process.env.QWEN_DEPLOYMENT ?? process.env.AVAIRA_DEPLOYMENT,
    operatorKey: (process.env.OPERATOR_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex,
    challengerKey: (process.env.CHALLENGER_PRIVATE_KEY ?? DEFAULT_CHALLENGER_KEY) as Hex,
    agentId: process.env.QWEN_AGENT_ID ? BigInt(process.env.QWEN_AGENT_ID) : undefined,
    autoProvision: (process.env.QWEN_AUTO_PROVISION ?? "1") === "1",
    apiKey,
    baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL ?? "qwen3.8-max",
    mock,
    taskBudgetUsd: Number(process.env.QWEN_TASK_BUDGET_USD ?? 500),
    taskWindowSec: Number(process.env.QWEN_TASK_WINDOW_SEC ?? 600),
    transcriptsDir: process.env.QWEN_TRANSCRIPTS_DIR ?? new URL("../transcripts", import.meta.url).pathname,
  };
}

/* ─────────────────────────────── LLM messages ─────────────────────────────── */

export interface ToolCallFn {
  name: string;
  arguments: string; // JSON-encoded
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFn;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/* ──────────────────────────────── transcripts ─────────────────────────────── */

export type TranscriptEvent =
  | { type: "plan"; text: string }
  | { type: "tool_call"; id: string; tool: string; args: unknown }
  | {
      type: "gate";
      tool: string;
      outcome: "allowed" | "blocked" | "clamped";
      reason: string;
      score?: number;
      intentHash?: string;
      commitTxHash?: string;
      attestTxHash?: string;
      envelope: { maxSpendUsd: string; allowedActions: string[]; deadline: number };
      detail?: unknown;
    }
  | { type: "execution"; tool: string; spendUsd: string; result: unknown }
  | { type: "settlement"; tool: string; outcomeHash: string; merkleRoot: string; attestTxHash?: string }
  | { type: "challenge"; leaf: unknown; proofDepth: number; txHash: string; slashed: string; bounty: string }
  | { type: "final"; text: string };

export interface Transcript {
  scenario: string;
  ts: number;
  model: string;
  mode: "live" | "mock";
  chainId: number;
  agentId?: string;
  task: { id: string; description: string };
  events: TranscriptEvent[];
}
