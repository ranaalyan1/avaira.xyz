/**
 * Shared types for the Perpl trading bot.
 *
 * Money convention: USD amounts are micro-USD (1e6 = $1.00), matching the
 * on-chain RiskEnvelope / USDC convention used across Avaira.
 */

export type Side = "buy" | "sell";

export interface Quote {
  pair: string;
  /** Mid price in USDC per base unit (MON). */
  mid: number;
  bid: number;
  ask: number;
  /** Depth of the reference book in base units. */
  depth: number;
  ts: number;
}

export interface GridOrder {
  side: Side;
  price: number;
  qty: number;
  /** Notional in micro-USD. */
  notionalUsd: bigint;
}

export interface PlacedOrder extends GridOrder {
  id: string;
  txHash: string;
  placedAt: number;
  cycle: number;
}

export interface Fill {
  orderId: string;
  side: Side;
  price: number;
  qty: number;
  /** Realized spend (buy) or proceeds (sell) in micro-USD. */
  usd: bigint;
  txHash: string;
}

export interface Settlement {
  txHash: string;
  realizedPnlUsd: bigint;
  feesUsd: bigint;
  /** Fills that happened since the previous settlement (resting orders crossed by the mid). */
  fills?: Fill[];
}

export type GateOutcome = "allowed" | "blocked";

export interface GateDecision {
  cycle: number;
  ts: number;
  outcome: GateOutcome;
  reason: string;
  score?: number;
  intentHash?: string;
  commitTxHash?: string;
  attestTxHash?: string;
  envelope: {
    maxSpendUsd: string;
    allowedActions: string[];
    deadline: number;
  };
}

export interface CycleRecord {
  cycle: number;
  ts: number;
  gate: GateDecision;
  executed: boolean;
  quoteMid?: number;
  placed?: number;
  cancelled?: number;
  fills?: number;
  spendUsd?: string;
  error?: string;
}

export interface Position {
  pair: string;
  /** Net inventory in base units (MON); negative = short. */
  qty: number;
  /** Average entry price (USDC per base unit). */
  avgPrice: number;
}

export interface BotState {
  startedAt: number;
  cycles: number;
  position: Position;
  /** Starting capital in micro-USD; equity and drawdown are measured against it. */
  capitalUsd: string;
  /** Equity in micro-USD (capital + realised PnL + marked inventory). */
  equityUsd: string;
  peakEquityUsd: string;
  realizedPnlUsd: string;
  openOrders: PlacedOrder[];
  gateLog: GateDecision[];
  cycleLog: CycleRecord[];
  txHashes: string[];
  halted: null | { at: number; reason: string; cycle: number };
}

export const MICRO = 1_000_000n;

export function usdToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

export function microToUsd(micro: bigint): number {
  return Number(micro) / 1_000_000;
}
