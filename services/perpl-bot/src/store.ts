/**
 * JSON-file persistence so the bot restarts safely: positions, open orders,
 * equity peak (for the kill switch), gate log and tx hashes survive restarts.
 * Writes are atomic (tmp file + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotState } from "./types.js";

export function freshState(): BotState {
  return {
    startedAt: Date.now(),
    cycles: 0,
    position: { pair: "MON/USDC", qty: 0, avgPrice: 0 },
    capitalUsd: "0",
    equityUsd: "0",
    peakEquityUsd: "0",
    realizedPnlUsd: "0",
    openOrders: [],
    gateLog: [],
    cycleLog: [],
    txHashes: [],
    halted: null,
  };
}

export function loadState(path: string): BotState {
  if (!existsSync(path)) return freshState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BotState;
    if (typeof parsed.cycles !== "number" || !parsed.position) return freshState();
    parsed.capitalUsd ??= "0"; // tolerate state written before capital tracking existed
    return parsed;
  } catch {
    return freshState();
  }
}

/** BigInts (order notionals) serialise as decimal strings; the loader never does arithmetic on them. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function saveState(path: string, state: BotState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, jsonReplacer, 2));
  renameSync(tmp, path);
}

/** Bounded logs so a multi-day run cannot grow the state file without limit. */
export function trimLogs(state: BotState, keep = 200): BotState {
  if (state.gateLog.length > keep) state.gateLog = state.gateLog.slice(-keep);
  if (state.cycleLog.length > keep) state.cycleLog = state.cycleLog.slice(-keep);
  if (state.txHashes.length > keep * 2) state.txHashes = state.txHashes.slice(-keep * 2);
  return state;
}
