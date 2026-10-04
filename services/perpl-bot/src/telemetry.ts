/**
 * Telemetry + operator surface.
 *
 *   GET  /status               — positions, PnL, gate decisions, tx hashes
 *   GET  /health               — liveness
 *   POST /admin/reset-halt     — operator acknowledgement; resumes after a halt
 *   POST /admin/block-next     — the next cycle intentionally runs into the gate
 */
import express from "express";
import type { BotConfig } from "./config.js";
import type { BotState } from "./types.js";

export interface TelemetryHandle {
  close: () => void;
  requestBlockNext: () => void;
  resetHalt: () => void;
}

export function startTelemetry(
  cfg: BotConfig,
  getState: () => BotState,
  getMeta: () => Record<string, unknown>,
  hooks: { requestBlockNext: () => void; resetHalt: () => void },
): TelemetryHandle {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const state = getState();
    res.json({ ok: !state.halted, halted: state.halted, cycles: state.cycles });
  });

  app.get("/status", (_req, res) => {
    const state = getState();
    res.json({
      service: "perpl-bot",
      ts: Date.now(),
      mode: cfg.exchangeMode,
      pair: cfg.pair,
      chainId: cfg.chainId,
      agentId: (getMeta().agentId as bigint | undefined)?.toString(),
      cycles: state.cycles,
      startedAt: state.startedAt,
      position: state.position,
      capitalUsd: state.capitalUsd,
      equityUsd: state.equityUsd,
      peakEquityUsd: state.peakEquityUsd,
      realizedPnlUsd: state.realizedPnlUsd,
      openOrders: state.openOrders.map((o) => ({ ...o, notionalUsd: o.notionalUsd.toString() })),
      halted: state.halted,
      gateDecisions: state.gateLog.slice(-50),
      cycles_: state.cycleLog.slice(-20),
      txHashes: state.txHashes.slice(-100),
      risk: {
        maxPositionQty: cfg.maxPositionQty,
        maxDrawdownPct: cfg.maxDrawdownPct,
        minScore: cfg.minScore,
        cycleBudgetUsd: cfg.cycleBudgetUsd,
      },
    });
  });

  app.post("/admin/block-next", (_req, res) => {
    hooks.requestBlockNext();
    res.json({ ok: true, note: "next cycle will be intentionally blocked by the gate" });
  });

  app.post("/admin/reset-halt", (_req, res) => {
    hooks.resetHalt();
    res.json({ ok: true, note: "halt cleared; the bot resumes next cycle" });
  });

  const server = app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`[perpl-bot] telemetry on http://0.0.0.0:${cfg.port}/status`);
  });

  return {
    close: () => server.close(),
    requestBlockNext: hooks.requestBlockNext,
    resetHalt: hooks.resetHalt,
  };
}
