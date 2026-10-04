/**
 * Telemetry surface: `GET /status` renders everything a reviewer needs to see without
 * reading logs — live positions, PnL, the gate decisions (allowed and blocked) and the trade
 * history with explorer links.
 */
import { createServer, type Server } from "node:http";

import type { BotConfig } from "./config";
import type { PerplExchange } from "./exchange";
import type { StateStore } from "./state";

export interface StatusServerDeps {
  config: BotConfig;
  exchange: PerplExchange;
  state: StateStore;
  startedAt: string;
}

export function createStatusServer(deps: StatusServerDeps): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" || url.pathname === "/") {
      json(response, 200, { ok: true, service: "avaira-perpl-bot", exchange: deps.exchange.kind });
      return;
    }

    if (url.pathname === "/status") {
      const state = deps.state.current;
      let positions: unknown[] = [];
      let realisedPnlUsd = state.realisedPnlUsd;
      try {
        positions = await deps.exchange.positions(deps.config.pair);
        realisedPnlUsd = await deps.exchange.realisedPnlUsd();
      } catch (error) {
        positions = [{ error: (error as Error).message }];
      }
      const unrealised = (positions as { unrealisedPnlUsd?: number }[]).reduce(
        (sum, position) => sum + (position.unrealisedPnlUsd ?? 0),
        0,
      );
      json(response, 200, {
        service: "avaira-perpl-bot",
        exchange: deps.exchange.kind,
        gate: deps.config.mock ? "simulated" : "avaira",
        config: {
          pair: deps.config.pair,
          chainId: deps.config.chainId,
          gridLevels: deps.config.gridLevels,
          gridSpacingBps: deps.config.gridSpacingBps,
          orderSizeUsd: deps.config.orderSizeUsd,
          maxPositionUsd: deps.config.maxPositionUsd,
          maxDrawdownUsd: deps.config.maxDrawdownUsd,
          minScore: deps.config.minScore,
        },
        agentId: state.agentId,
        startedAt: deps.startedAt,
        uptimeSeconds: Math.round((Date.now() - new Date(deps.startedAt).getTime()) / 1000),
        cycle: state.cycle,
        halted: state.halted,
        haltReason: state.haltReason,
        killSwitchTripped: state.killSwitchTripped,
        cyclesAllowed: state.cyclesAllowed,
        cyclesBlocked: state.cyclesBlocked,
        lastScore: state.lastScore,
        positions,
        notionalUsd: (positions as { size?: number; markPrice?: number }[]).reduce(
          (sum, position) => sum + Math.abs(position.size ?? 0) * (position.markPrice ?? 0),
          0,
        ),
        pnl: { realisedUsd: realisedPnlUsd, unrealisedUsd: unrealised, totalUsd: realisedPnlUsd + unrealised },
        openOrders: Object.values(state.openOrders),
        gateDecisions: state.gateDecisions.slice(-50).reverse(),
        trades: state.trades.slice(-50).reverse(),
      });
      return;
    }

    json(response, 404, { error: "not found", routes: ["GET /status", "GET /health"] });
  });
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}
