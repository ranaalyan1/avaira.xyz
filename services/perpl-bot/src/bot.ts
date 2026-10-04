/**
 * The trading loop. Every cycle is one gated `avaira.run()`:
 *
 *   1. risk checks (halted? kill switch? position cap?)
 *   2. envelope = { maxSpendUsd: gas-aware cycle budget,
 *                   allowedActions: perpl.*, deadline: cycle end }
 *   3. avaira.run(agentId, task, execute_fn)
 *        - gate blocked  → cycle recorded as blocked, bot halts + logs
 *        - gate allowed  → quote → cancel stale → place grid → settle,
 *                          every exchange call hash-chained into the audit
 *                          trail with its spendUsd
 *   4. persist state atomically; telemetry picks it up on /status
 */
import { GateReason, GATE_REASON_TEXT } from "../../../sdk/typescript/src/index.js";
import { PERPL_ACTIONS, type BotConfig } from "./config.js";
import type { Exchange } from "./exchange.js";
import { postScore, probeGasPrice, readScore, type GateContext } from "./gate.js";
import { checkDrawdown, checkPositionCap, checkScore, cycleBudgetUsd, markEquity } from "./risk.js";
import { saveState, trimLogs } from "./store.js";
import { applyFill, gridOrders } from "./strategy.js";
import type { BotState, CycleRecord, GateDecision, PlacedOrder } from "./types.js";

export interface CycleResult {
  record: CycleRecord;
  halted: boolean;
}

export async function runCycle(
  ctx: GateContext,
  exchange: Exchange,
  state: BotState,
  agentId: bigint,
  forceBlock: boolean,
): Promise<CycleResult> {
  const { cfg, avaira, publicClient } = ctx;
  const cycle = state.cycles + 1;
  state.cycles = cycle;
  const now = Date.now();

  const envelopeDeadline = BigInt(Math.floor(now / 1000) + Math.max(30, Math.ceil(cfg.cycleMs / 1000) * 2));
  const gate: GateDecision = {
    cycle,
    ts: now,
    outcome: "blocked",
    reason: "not-evaluated",
    envelope: {
      maxSpendUsd: "0",
      allowedActions: [...PERPL_ACTIONS],
      deadline: Number(envelopeDeadline),
    },
  };

  const baseRecord: CycleRecord = { cycle, ts: now, gate, executed: false };

  // ── local risk checks (fail-closed) ─────────────────────────────────────────
  if (state.halted) {
    gate.reason = `halted: ${state.halted.reason}`;
    state.cycleLog.push(baseRecord);
    return { record: baseRecord, halted: true };
  }
  const drawdown = checkDrawdown(state, cfg);
  if (!drawdown.ok) {
    halt(state, cycle, drawdown.reason!);
    gate.reason = drawdown.reason!;
    state.cycleLog.push(baseRecord);
    saveState(cfg.stateFile, trimLogs(state));
    return { record: baseRecord, halted: true };
  }

  // ── build the gas-aware budget + envelope ───────────────────────────────────
  const gasPrice = await probeGasPrice(ctx);
  const budgetUsd = cycleBudgetUsd(cfg, gasPrice);
  gate.envelope.maxSpendUsd = budgetUsd.toString();

  let executed = false;
  let spendUsd = 0n;
  let restoreScore: number | undefined;

  try {
    // ── intentional block: drop the score below the gate floor for this cycle ──
    // (driven by POST /admin/block-next, PERPL_FORCE_BLOCK, or demo:block)
    if (forceBlock) {
      restoreScore = await readScore(ctx, agentId);
      await postScore(ctx, agentId, Math.max(0, cfg.minScore - 20));
      gate.reason = "forced-block (intentional demo)";
    }

    const score = await readScore(ctx, agentId);
    gate.score = score;
    const scoreCheck = checkScore(score, cfg);
    if (!scoreCheck.ok && !forceBlock) {
      gate.reason = scoreCheck.reason!;
      halt(state, cycle, `score below floor: ${scoreCheck.reason}`);
      state.cycleLog.push(baseRecord);
      saveState(cfg.stateFile, trimLogs(state));
      return { record: baseRecord, halted: true };
    }

    const run = await avaira.run(
      agentId,
      {
        id: `perpl-cycle-${cycle}`,
        description: `${exchange.mode} market-making cycle on ${cfg.pair}`,
        pair: cfg.pair,
        cycle,
      },
      async ({ audit, envelope }) => {
        // 1. quote
        const quote = await exchange.quote(cfg.pair);
        audit.append("perpl.quote", 0n, { mid: quote.mid });

        // 2. cancel stale quotes from the previous cycle
        let cancelled = 0;
        for (const open of state.openOrders) {
          const txHash = await exchange.cancel(open);
          audit.append("perpl.cancel_order", 0n, { orderId: open.id, txHash });
          if (txHash) state.txHashes.push(txHash);
          cancelled += 1;
        }
        state.openOrders = [];

        // 3. place the new grid, clipped by the envelope budget + position cap
        const orders = gridOrders({ quote, position: state.position, budgetUsd: envelope.maxSpendUsd, cfg });
        const placed: PlacedOrder[] = [];
        for (const order of orders) {
          const cap = checkPositionCap(state.position, order.side === "buy" ? order.qty : -order.qty, cfg);
          if (!cap.ok) continue;
          if (spendUsd + order.notionalUsd > envelope.maxSpendUsd) break;
          const placedOrder = await exchange.place(order, cycle);
          spendUsd += order.notionalUsd;
          audit.append("perpl.place_order", order.notionalUsd, {
            side: order.side,
            price: order.price,
            qty: order.qty,
            txHash: placedOrder.txHash,
          });
          state.txHashes.push(placedOrder.txHash);
          placed.push(placedOrder);
        }
        state.openOrders = placed;

        // 4. settle the cycle: fills (resting orders crossed by the walk) move inventory
        const settlement = await exchange.settle();
        let fillsCount = 0;
        for (const fill of settlement.fills ?? []) {
          state.position = applyFill(state.position, fill.side, fill.price, fill.qty);
          state.txHashes.push(fill.txHash);
          fillsCount += 1;
        }
        audit.append("perpl.settle", settlement.feesUsd, {
          txHash: settlement.txHash,
          realizedPnlUsd: settlement.realizedPnlUsd.toString(),
          fills: fillsCount,
        });
        state.txHashes.push(settlement.txHash);
        state.realizedPnlUsd = (BigInt(state.realizedPnlUsd) + settlement.realizedPnlUsd).toString();

        return { mid: quote.mid, placed: placed.length, cancelled, fills: fillsCount };
      },
      {
        envelope: {
          maxSpendUsd: budgetUsd,
          allowedActions: [...PERPL_ACTIONS],
          deadline: envelopeDeadline,
        },
      },
    );

    if (run.status === "blocked") {
      gate.outcome = "blocked";
      gate.reason = `${GateReason[run.reason] ?? run.reason}: ${run.message ?? GATE_REASON_TEXT[run.reason]}`;
      gate.intentHash = run.intentHash;
      gate.commitTxHash = run.commitTxHash;
      // A gate block halts trading until an operator looks at it.
      halt(state, cycle, gate.reason);
    } else {
      executed = true;
      gate.outcome = "allowed";
      gate.reason = "ALLOWED";
      gate.intentHash = run.intentHash;
      gate.commitTxHash = run.commitTxHash;
      gate.attestTxHash = run.attestTxHash;
      if (run.commitTxHash) state.txHashes.push(run.commitTxHash);
      if (run.attestTxHash) state.txHashes.push(run.attestTxHash);

      const result = run.result as { mid: number; placed: number; cancelled: number; fills: number };
      const equity = markEquity(state, result.mid);
      state.equityUsd = equity.toString();
      if (equity > BigInt(state.peakEquityUsd)) state.peakEquityUsd = equity.toString();

      baseRecord.quoteMid = result.mid;
      baseRecord.placed = result.placed;
      baseRecord.cancelled = result.cancelled;
      baseRecord.fills = result.fills;
    }
  } catch (error) {
    gate.outcome = "blocked";
    gate.reason = `error: ${error instanceof Error ? error.message : String(error)}`;
    baseRecord.error = gate.reason;
    halt(state, cycle, gate.reason);
  } finally {
    // Always hand the score back after an intentional block.
    if (restoreScore !== undefined) {
      try {
        await postScore(ctx, agentId, restoreScore);
      } catch (err) {
        console.error(`[perpl-bot] failed to restore score: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  baseRecord.executed = executed;
  baseRecord.spendUsd = spendUsd.toString();
  state.gateLog.push(gate);
  state.cycleLog.push(baseRecord);
  saveState(cfg.stateFile, trimLogs(state));
  return { record: baseRecord, halted: state.halted !== null };
}

function halt(state: BotState, cycle: number, reason: string): void {
  if (state.halted) return;
  state.halted = { at: Date.now(), reason, cycle };
  console.error(`[perpl-bot] HALT @cycle ${cycle}: ${reason}`);
}

export function clearHalt(state: BotState): void {
  state.halted = null;
}
