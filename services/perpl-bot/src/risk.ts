/**
 * Risk module: position cap, drawdown kill-switch, gas-aware budgeting.
 *
 * Everything here is defensive and fail-closed — any ambiguity halts the bot
 * rather than trading.
 */
import type { BotConfig } from "./config.js";
import type { BotState, Position } from "./types.js";
import { microToUsd, usdToMicro } from "./types.js";

export interface RiskCheck {
  ok: boolean;
  reason?: string;
}

/** Hard inventory cap — no order may push |position| past maxPositionQty. */
export function checkPositionCap(position: Position, deltaQty: number, cfg: BotConfig): RiskCheck {
  const next = Math.abs(position.qty + deltaQty);
  if (next > cfg.maxPositionQty) {
    return {
      ok: false,
      reason: `position cap: |${position.qty} + ${deltaQty}| > ${cfg.maxPositionQty}`,
    };
  }
  return { ok: true };
}

/**
 * Max-drawdown kill switch. Equity is measured against the running peak; a
 * breach halts the bot until an operator explicitly resets it.
 */
export function checkDrawdown(state: BotState, cfg: BotConfig): RiskCheck {
  const equity = Number(state.equityUsd);
  const peak = Number(state.peakEquityUsd);
  if (peak <= 0) return { ok: true };
  const drawdownPct = ((peak - equity) / peak) * 100;
  if (drawdownPct >= cfg.maxDrawdownPct) {
    return { ok: false, reason: `drawdown kill switch: ${drawdownPct.toFixed(2)}% >= ${cfg.maxDrawdownPct}%` };
  }
  return { ok: true };
}

/**
 * Gas-aware cycle budget: the on-chain parts of a gated cycle (commitIntent,
 * attestOutcome, plus the gate reads) cost MON; we reserve `gasReserveUsd` plus
 * a per-chain estimate and never let order notional consume that reserve.
 */
export function cycleBudgetUsd(cfg: BotConfig, gasPriceWei: bigint): bigint {
  const budget = usdToMicro(cfg.cycleBudgetUsd);
  // ~250k gas of on-chain overhead per cycle (commit + attest + margin).
  const gasUnits = 250_000n;
  const gasCostMon = Number((gasUnits * gasPriceWei) / 10n ** 18n);
  const gasCostUsd = gasCostMon * cfg.monUsd;
  const reserve = usdToMicro(Math.max(cfg.gasReserveUsd, gasCostUsd));
  const spendable = budget - reserve;
  return spendable > 0n ? spendable : 0n;
}

/** Pre-cycle score floor. The gate enforces this on-chain too (minScore); we check early for clearer logs. */
export function checkScore(score: number, cfg: BotConfig): RiskCheck {
  if (score < cfg.minScore) {
    return { ok: false, reason: `score ${score} < minScore ${cfg.minScore}` };
  }
  return { ok: true };
}

/** Mark-to-market equity in micro-USD: capital + realized PnL + inventory mark vs entry. */
export function markEquity(state: BotState, mid: number): bigint {
  const capital = BigInt(state.capitalUsd);
  const realized = BigInt(state.realizedPnlUsd);
  const p = state.position;
  const markUsd = (mid - p.avgPrice) * p.qty; // signed, USD
  return capital + realized + usdToMicro(markUsd);
}

export { microToUsd };
