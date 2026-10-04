/**
 * Grid market-making strategy for the deepest pair (default MON/USDC).
 *
 * Each cycle quotes `gridLevels` resting bids and asks around mid at a fixed
 * basis-point spacing, sized `orderSizeMon`, subject to:
 *   - the hard position cap (no side may push |inventory| past maxPositionQty),
 *   - the cycle's risk budget (notional is clipped to what the envelope allows,
 *     gas reserve already deducted by the risk module).
 *
 * The strategy is deliberately dumb: the point of this service is the gate,
 * not the alpha.
 */
import type { BotConfig } from "./config.js";
import type { GridOrder, Position, Quote } from "./types.js";
import { usdToMicro } from "./types.js";

export interface StrategyInput {
  quote: Quote;
  position: Position;
  budgetUsd: bigint;
  cfg: BotConfig;
}

export function gridOrders(input: StrategyInput): GridOrder[] {
  const { quote, position, budgetUsd, cfg } = input;
  const orders: GridOrder[] = [];
  let remaining = budgetUsd;

  const spacing = cfg.gridSpreadBps / 10_000;

  for (let level = 1; level <= cfg.gridLevels; level++) {
    // ── bid: only if buying keeps us inside the position cap ──
    const afterBuy = position.qty + cfg.orderSizeMon;
    if (Math.abs(afterBuy) <= cfg.maxPositionQty) {
      const price = quote.mid * (1 - spacing * level);
      const notional = usdToMicro(price * cfg.orderSizeMon);
      if (notional <= remaining) {
        orders.push({ side: "buy", price, qty: cfg.orderSizeMon, notionalUsd: notional });
        remaining -= notional;
      }
    }

    // ── ask: only if selling keeps us inside the position cap ──
    const afterSell = position.qty - cfg.orderSizeMon;
    if (Math.abs(afterSell) <= cfg.maxPositionQty) {
      const price = quote.mid * (1 + spacing * level);
      const notional = usdToMicro(price * cfg.orderSizeMon);
      if (notional <= remaining) {
        orders.push({ side: "sell", price, qty: cfg.orderSizeMon, notionalUsd: notional });
        remaining -= notional;
      }
    }

    if (remaining <= 0n) break;
  }

  return orders;
}

/** Inventory + average price after a fill at (side, price, qty). */
export function applyFill(position: Position, side: "buy" | "sell", price: number, qty: number): Position {
  const signed = side === "buy" ? qty : -qty;
  const nextQty = position.qty + signed;
  if (nextQty === 0) return { ...position, qty: 0, avgPrice: 0 };
  const sameDirection = position.qty === 0 || Math.sign(position.qty) === Math.sign(signed);
  const avgPrice = sameDirection
    ? (Math.abs(position.qty) * position.avgPrice + qty * price) / Math.abs(nextQty)
    : position.avgPrice; // reducing: keep entry price for PnL
  return { ...position, qty: nextQty, avgPrice };
}
