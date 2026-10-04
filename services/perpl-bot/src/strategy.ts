/**
 * Grid strategy + risk kernel.
 *
 * The strategy is deliberately boring: quote `gridLevels` bids and asks around the mark at a
 * fixed bps spacing, each for `orderSizeUsd`. All the interesting behaviour is in the risk
 * kernel, which is what the Avaira gate is protecting:
 *
 *   • hard position cap        — never let net exposure exceed `maxPositionUsd`
 *   • drawdown kill-switch     — realised + unrealised loss beyond `maxDrawdownUsd` halts the
 *                                bot and files a slash-report (the agent's stake is at risk)
 *   • minimum Avaira score     — below `minScore` the bot refuses to quote at all
 *   • gas-aware sizing         — every cycle reserves `gasBufferUsd` for Monad gas
 */
import type { BotConfig } from "./config";
import type { MarketSnapshot, OrderRequest, Position, Side } from "./exchange";

export interface DesiredQuote {
  side: Side;
  price: number;
  sizeUsd: number;
  level: number;
}

export interface StrategyPlan {
  pair: string;
  markPrice: number;
  quotes: DesiredQuote[];
  /** Cycles the plan wants cancelled before placing new quotes. */
  cancelAll: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: "POSITION_CAP" | "DRAWDOWN_KILL_SWITCH" | "SCORE_TOO_LOW" | "INSUFFICIENT_GAS_BUDGET" | "OK";
  message?: string;
  clampedQuotes?: DesiredQuote[];
}

/** Pure: current mid → the ladder of quotes the bot wants on the book. */
export function planGrid(config: BotConfig, market: MarketSnapshot, cycle: number): StrategyPlan {
  const quotes: DesiredQuote[] = [];
  const spacing = market.markPrice * (config.gridSpacingBps / 10_000);
  for (let level = 1; level <= config.gridLevels; level += 1) {
    // Alternate the ladder every cycle so resting orders do not sit stale forever.
    const rotate = cycle % 2 === 0 ? 0 : 0.5;
    const offset = spacing * (level + rotate);
    const sizeUsd = config.orderSizeUsd;
    quotes.push({ side: "buy", price: round(market.markPrice - offset), sizeUsd, level });
    quotes.push({ side: "sell", price: round(market.markPrice + offset), sizeUsd, level });
  }
  return { pair: market.pair, markPrice: market.markPrice, quotes, cancelAll: true };
}

export function toOrderRequest(plan: StrategyPlan, quote: DesiredQuote, clientPrefix: string): OrderRequest {
  return {
    pair: plan.pair,
    side: quote.side,
    price: quote.price,
    sizeUsd: quote.sizeUsd,
    clientId: `${clientPrefix}-${quote.side}-L${quote.level}`,
  };
}

/**
 * Pure risk kernel. Returns whether this cycle may quote, and the clips the bot may keep —
 * exposure is clamped before the request ever reaches the exchange.
 */
export function assessRisk(
  config: BotConfig,
  snapshot: { positions: Position[]; realisedPnlUsd: number; score: number },
  quotes: DesiredQuote[],
): RiskDecision {
  if (snapshot.score < config.minScore) {
    return {
      allowed: false,
      reason: "SCORE_TOO_LOW",
      message: `Avaira score ${snapshot.score} < minimum ${config.minScore}`,
    };
  }

  const unrealised = snapshot.positions.reduce((sum, position) => sum + position.unrealisedPnlUsd, 0);
  const pnl = snapshot.realisedPnlUsd + unrealised;
  if (pnl <= -Math.abs(config.maxDrawdownUsd)) {
    return {
      allowed: false,
      reason: "DRAWDOWN_KILL_SWITCH",
      message: `drawdown ${pnl.toFixed(2)} USD breached the ${config.maxDrawdownUsd} USD limit — halting and reporting a slash`,
    };
  }

  // Net exposure after the worst-case fill of every quote in this plan.
  const currentNotional = snapshot.positions.reduce((sum, position) => sum + Math.abs(position.size) * position.markPrice, 0);
  const plannedNotional = quotes.reduce((sum, quote) => sum + quote.sizeUsd, 0);
  const headroom = config.maxPositionUsd - currentNotional - config.gasBufferUsd;
  if (headroom <= 0) {
    return {
      allowed: false,
      reason: "POSITION_CAP",
      message: `position ${currentNotional.toFixed(2)} USD leaves no headroom under the ${config.maxPositionUsd} USD cap`,
    };
  }
  if (plannedNotional > headroom) {
    const clamped: DesiredQuote[] = [];
    let budget = headroom;
    for (const quote of [...quotes].sort((a, b) => a.level - b.level)) {
      if (budget < 1) break;
      const sizeUsd = Math.min(quote.sizeUsd, budget);
      clamped.push({ ...quote, sizeUsd: round(sizeUsd) });
      budget -= sizeUsd;
    }
    if (clamped.length === 0) {
      return { allowed: false, reason: "INSUFFICIENT_GAS_BUDGET", message: "gas buffer consumes the remaining position headroom" };
    }
    return { allowed: true, reason: "OK", clampedQuotes: clamped, message: `clamped ${quotes.length} quotes to ${clamped.length}` };
  }

  return { allowed: true, reason: "OK" };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
