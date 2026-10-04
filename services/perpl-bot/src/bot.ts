/**
 * The cycle.
 *
 *   1. observe   — mark price, open orders, positions, realised PnL
 *   2. plan      — the grid ladder for this cycle
 *   3. risk      — position cap / drawdown kill-switch / gas-aware sizing (pre-flight)
 *   4. gate      — avaira.run(): the intent is committed and the on-chain gate decides
 *   5. act       — cancel stale quotes and place the ladder *inside* execute_fn
 *   6. journal   — every placement/cancel with its spend and tx hash
 *
 * If the gate blocks, step 5 never happens and the bot halts with the on-chain reason.
 */
import { gateReasonName, type Gate, type CycleIntent } from "./gate";
import type { BotConfig } from "./config";
import type { OrderResult, PerplExchange, Position } from "./exchange";
import { assessRisk, planGrid, toOrderRequest, type DesiredQuote, type StrategyPlan } from "./strategy";
import { StateStore } from "./state";

export interface CycleReport {
  cycle: number;
  allowed: boolean;
  reason: string;
  reasonText: string;
  score: number | null;
  intentHash?: string;
  merkleRoot?: string;
  haltReason?: string;
  planned: number;
  placed: OrderResult[];
  cancelled: string[];
  spendUsdThisCycle: bigint;
  markPrice: number;
  realisedPnlUsd: number;
  unrealisedPnlUsd: number;
  openOrders: number;
}

export interface BotDeps {
  config: BotConfig;
  exchange: PerplExchange;
  gate: Gate;
  state: StateStore;
  log?: (...parts: unknown[]) => void;
  /** Test hooks. */
  now?: () => number;
}

export class PerplBot {
  private readonly log: (...parts: unknown[]) => void;
  private readonly now: () => number;

  constructor(private readonly deps: BotDeps) {
    this.log = deps.log ?? ((...parts: unknown[]) => console.log(...parts));
    this.now = deps.now ?? (() => Date.now());
  }

  get state() {
    return this.deps.state.current;
  }

  /** One full pass of the loop. Safe to call repeatedly; restart-safe via the state file. */
  async cycle(): Promise<CycleReport> {
    const { config, exchange, gate, state } = this.deps;
    const cycle = state.current.cycle + 1;
    state.update((draft) => {
      draft.cycle = cycle;
    });

    const market = await exchange.market(config.pair);
    const positions = await exchange.positions(config.pair);
    const realisedPnlUsd = await exchange.realisedPnlUsd();
    const unrealisedPnlUsd = positions.reduce((sum, position) => sum + position.unrealisedPnlUsd, 0);
    const plan = planGrid(config, market, cycle);

    /* ── 3. pre-flight risk (cheap, local, never trades) ─────────────────────── */
    const preflight = assessRisk(config, { positions, realisedPnlUsd, score: this.score() }, plan.quotes);
    if (!preflight.allowed) {
      const haltReason = `${preflight.reason}: ${preflight.message}`;
      state.recordGate({ cycle, allowed: false, reason: preflight.reason!, score: this.score(), message: preflight.message });
      // An ineligible agent halts outright; a transient position cap only skips this cycle.
      if (preflight.reason === "DRAWDOWN_KILL_SWITCH" || preflight.reason === "SCORE_TOO_LOW") {
        state.halt(haltReason);
        if (preflight.reason === "DRAWDOWN_KILL_SWITCH") {
          // The stake is what backs this agent: file the evidence a slash would rest on.
          state.reportSlash({
            reason: haltReason,
            pnlUsd: realisedPnlUsd + unrealisedPnlUsd,
            realisedPnlUsd,
          });
        }
        state.recordTrade({ cycle, kind: "halt", pair: config.pair, spendUsdThisCycle: 0 });
      }
      this.log(`  cycle ${cycle} blocked by risk: ${haltReason}`);
      return this.report(cycle, false, preflight.reason!, preflight.message ?? "", plan, [], [], 0n, market.markPrice, realisedPnlUsd, unrealisedPnlUsd, haltReason);
    }

    const quotes = preflight.clampedQuotes ?? plan.quotes;
    const cycleBudgetUsd = BigInt(Math.ceil(quotes.reduce((sum, quote) => sum + quote.sizeUsd, 0)));
    const cycleEnd = BigInt(Math.floor(this.now() / 1000) + Math.max(60, config.cycleSeconds) + 30);

    const intent: CycleIntent = {
      cycle,
      taskId: `${config.pair.replace("/", "-")}-cycle-${cycle}`,
      description: `Perpl grid cycle ${cycle} on ${config.pair}: ${quotes.length} quotes, ≤${cycleBudgetUsd} USD`,
      envelope: {
        maxSpendUsd: cycleBudgetUsd,
        allowedActions: ["perpl.quote", "perpl.place_order", "perpl.cancel_order", "perpl.settle"],
        deadline: cycleEnd,
      },
    };

    const placed: OrderResult[] = [];
    const cancelled: string[] = [];
    let spendUsdThisCycle = 0n;

    /* ── 4+5. the gate, then the market ──────────────────────────────────────── */
    let outcome;
    try {
      outcome = await gate.run(intent, async () => {
        // Cancel stale quotes first so the position never drifts past the cap.
        for (const order of Object.values(state.current.openOrders)) {
          const result = await exchange.cancelOrder(order.orderId);
          cancelled.push(order.orderId);
          state.update((draft) => {
            delete draft.openOrders[order.orderId];
          });
          state.recordTrade({
            cycle,
            kind: "cancel",
            pair: config.pair,
            orderId: order.orderId,
            txHash: result.txHash,
            spendUsdThisCycle: Number(spendUsdThisCycle),
          });
        }

        for (const quote of quotes) {
          const order = await exchange.placeOrder(toOrderRequest(plan, quote, `avaira-c${cycle}`));
          placed.push(order);
          if (order.status !== "rejected") spendUsdThisCycle += BigInt(Math.ceil(quote.sizeUsd));
          if (order.status === "open") {
            state.update((draft) => {
              draft.openOrders[order.orderId] = {
                orderId: order.orderId,
                side: order.side,
                price: order.price,
                sizeUsd: order.sizeUsd,
                cycle,
              };
            });
          }
          state.recordTrade({
            cycle,
            kind: order.status === "filled" ? "fill" : "place",
            pair: config.pair,
            side: order.side,
            price: order.price,
            sizeUsd: order.sizeUsd,
            orderId: order.orderId,
            txHash: order.txHash,
            spendUsdThisCycle: Number(spendUsdThisCycle),
          });
        }

        return { result: { placed: placed.length }, spendUsd: spendUsdThisCycle, txHashes: placed.map((order) => order.txHash as `0x${string}`).filter(Boolean) };
      });
    } catch (error) {
      const message = (error as Error).message;
      state.recordGate({ cycle, allowed: false, reason: "GATE_ERROR", score: this.score(), message });
      this.log(`  cycle ${cycle} gate error: ${message}`);
      return this.report(cycle, false, "GATE_ERROR", message, plan, placed, cancelled, 0n, market.markPrice, realisedPnlUsd, unrealisedPnlUsd);
    }

    state.recordGate({
      cycle,
      allowed: outcome.allowed,
      reason: outcome.allowed ? "OK" : gateReasonName(outcome.reason),
      score: outcome.score,
      intentHash: outcome.intentHash,
      message: outcome.allowed ? undefined : outcome.reasonText,
    });

    let haltReason: string | undefined;
    if (!outcome.allowed) {
      // A blocked gate halts the bot: an agent the protocol refuses to vouch for must not keep
      // quoting. The reason is persisted and surfaced on /status.
      haltReason = `GATE_BLOCKED ${gateReasonName(outcome.reason)}: ${outcome.reasonText}`;
      state.halt(haltReason);
      state.recordTrade({ cycle, kind: "halt", pair: config.pair, spendUsdThisCycle: 0 });
      this.log(`  cycle ${cycle} BLOCKED by the Avaira gate (${outcome.reason}): ${outcome.reasonText}`);
    } else {
      this.log(
        `  cycle ${cycle} allowed · ${placed.length} order(s) · ${
          placed.filter((order) => order.status === "filled").length
        } fill(s) · spent ${spendUsdThisCycle} USD`,
      );
    }

    return this.report(
      cycle,
      outcome.allowed,
      outcome.allowed ? "OK" : gateReasonName(outcome.reason),
      outcome.reasonText,
      plan,
      placed,
      cancelled,
      spendUsdThisCycle,
      market.markPrice,
      realisedPnlUsd,
      unrealisedPnlUsd,
      haltReason,
      outcome.merkleRoot,
      outcome.intentHash,
    );
  }

  private score(): number {
    const gate = this.deps.gate as Gate & { state?: { score: number } };
    return gate.state?.score ?? this.deps.state.current.lastScore ?? 78;
  }

  private report(
    cycle: number,
    allowed: boolean,
    reason: string,
    reasonText: string,
    plan: StrategyPlan,
    placed: OrderResult[],
    cancelled: string[],
    spendUsdThisCycle: bigint,
    markPrice: number,
    realisedPnlUsd: number,
    unrealisedPnlUsd: number,
    haltReason?: string,
    merkleRoot?: string,
    intentHash?: string,
  ): CycleReport {
    return {
      cycle,
      allowed,
      reason,
      reasonText,
      score: this.deps.state.current.lastScore,
      intentHash,
      merkleRoot,
      haltReason,
      planned: plan.quotes.length,
      placed,
      cancelled,
      spendUsdThisCycle,
      markPrice,
      realisedPnlUsd,
      unrealisedPnlUsd,
      openOrders: Object.keys(this.deps.state.current.openOrders).length,
    };
  }
}

/** Convenience: position summary for /status. */
export async function positionSummary(exchange: PerplExchange, pair: string): Promise<{ positions: Position[]; notionalUsd: number }> {
  const positions = await exchange.positions(pair);
  return { positions, notionalUsd: positions.reduce((sum, position) => sum + Math.abs(position.size) * position.markPrice, 0) };
}
