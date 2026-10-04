/**
 * Environment-driven configuration. Secrets only via env vars; every knob the
 * judges may want to change is listed in .env.example.
 */
import "dotenv/config";
import type { Hex } from "viem";

export interface BotConfig {
  chainId: number;
  rpcUrl: string;
  manifestPath?: string;

  operatorKey: Hex;
  agentId?: bigint;
  autoProvision: boolean;

  pair: string;
  /** "sim" = offline paper exchange (default, sandbox-friendly); "live" = PERPL_API_URL. */
  exchangeMode: "sim" | "live";
  perplApiUrl?: string;
  perplApiKey?: string;

  cycleMs: number;
  maxCycles: number;
  cycleBudgetUsd: number;
  startingCapitalUsd: number;

  gridLevels: number;
  gridSpreadBps: number;
  orderSizeMon: number;
  maxPositionQty: number;
  maxDrawdownPct: number;
  minScore: number;
  /** Reference MON price in USD used by the sim exchange and gas budgeting. */
  monUsd: number;
  gasReserveUsd: number;

  stateFile: string;
  port: number;
  forceBlock: boolean;
}

const DEFAULT_ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function loadConfig(): BotConfig {
  const chainId = Number(process.env.CHAIN_ID ?? 10143);
  const exchangeMode = (process.env.PERPL_MODE ?? "sim") as "sim" | "live";
  if (exchangeMode !== "sim" && exchangeMode !== "live") {
    throw new Error(`PERPL_MODE must be "sim" or "live", got "${exchangeMode}"`);
  }
  if (exchangeMode === "live" && !process.env.PERPL_API_URL) {
    throw new Error("PERPL_MODE=live requires PERPL_API_URL");
  }

  return {
    chainId,
    rpcUrl: process.env.PERPL_RPC_URL ?? process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
    manifestPath: process.env.PERPL_DEPLOYMENT ?? process.env.AVAIRA_DEPLOYMENT,

    operatorKey: (process.env.OPERATOR_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex,
    agentId: process.env.PERPL_AGENT_ID ? BigInt(process.env.PERPL_AGENT_ID) : undefined,
    autoProvision: (process.env.PERPL_AUTO_PROVISION ?? "1") === "1",

    pair: process.env.PERPL_PAIR ?? "MON/USDC",
    exchangeMode,
    perplApiUrl: process.env.PERPL_API_URL,
    perplApiKey: process.env.PERPL_API_KEY,

    cycleMs: Number(process.env.PERPL_CYCLE_MS ?? 15_000),
    maxCycles: Number(process.env.PERPL_MAX_CYCLES ?? Number.POSITIVE_INFINITY),
    cycleBudgetUsd: Number(process.env.PERPL_CYCLE_BUDGET_USD ?? 250),
    startingCapitalUsd: Number(process.env.PERPL_STARTING_CAPITAL_USD ?? 1000),

    gridLevels: Number(process.env.PERPL_GRID_LEVELS ?? 2),
    gridSpreadBps: Number(process.env.PERPL_GRID_SPREAD_BPS ?? 30),
    orderSizeMon: Number(process.env.PERPL_ORDER_SIZE_MON ?? 2),
    maxPositionQty: Number(process.env.PERPL_MAX_POSITION_QTY ?? 20),
    maxDrawdownPct: Number(process.env.PERPL_MAX_DRAWDOWN_PCT ?? 10),
    minScore: Number(process.env.PERPL_MIN_SCORE ?? 60),
    monUsd: Number(process.env.PERPL_MON_USD ?? 1),
    gasReserveUsd: Number(process.env.PERPL_GAS_RESERVE_USD ?? 0.5),

    stateFile: process.env.PERPL_STATE_FILE ?? new URL("../data/state.json", import.meta.url).pathname,
    port: Number(process.env.PORT ?? 8401),
    forceBlock: (process.env.PERPL_FORCE_BLOCK ?? "0") === "1",
  };
}

export const PERPL_ACTIONS = ["perpl.quote", "perpl.place_order", "perpl.cancel_order", "perpl.settle"] as const;
