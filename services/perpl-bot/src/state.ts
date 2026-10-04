/**
 * Durable state + audit journal.
 *
 * The bot must be safe to restart: open orders are re-adopted, the realised PnL baseline and
 * the kill-switch latch survive a crash, and every cycle appends to a JSONL journal that the
 * `/status` endpoint and the transcripts read back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GateRecord {
  at: string;
  cycle: number;
  allowed: boolean;
  reason: string;
  score: number | null;
  intentHash?: string;
  message?: string;
}

export interface TradeRecord {
  at: string;
  cycle: number;
  kind: "place" | "cancel" | "fill" | "halt";
  pair: string;
  side?: string;
  price?: number;
  sizeUsd?: number;
  orderId?: string;
  txHash?: string;
  spendUsdThisCycle: number;
}

export interface BotState {
  agentId: string;
  pair: string;
  cycle: number;
  startedAt: string;
  updatedAt: string;
  halted: boolean;
  haltReason?: string;
  killSwitchTripped: boolean;
  /** Filed when the drawdown kill-switch fires: the evidence a slash would be based on. */
  slashReport?: { at: string; reason: string; pnlUsd: number; realisedPnlUsd: number; cycle: number };
  /** Orders the bot believes are resting on the exchange, keyed by orderId. */
  openOrders: Record<string, { orderId: string; side: string; price: number; sizeUsd: number; cycle: number }>;
  realisedPnlUsd: number;
  lastScore: number | null;
  cyclesAllowed: number;
  cyclesBlocked: number;
  gateDecisions: GateRecord[];
  trades: TradeRecord[];
}

const MAX_HISTORY = 500;

export function emptyState(agentId: string | bigint, pair: string): BotState {
  const now = new Date().toISOString();
  return {
    agentId: agentId.toString(),
    pair,
    cycle: 0,
    startedAt: now,
    updatedAt: now,
    halted: false,
    killSwitchTripped: false,
    openOrders: {},
    realisedPnlUsd: 0,
    lastScore: null,
    cyclesAllowed: 0,
    cyclesBlocked: 0,
    gateDecisions: [],
    trades: [],
  };
}

export class StateStore {
  private state: BotState;
  private readonly statePath: string;
  private readonly journalPath: string;

  constructor(stateFile: string, journalFile: string, agentId: string | bigint, pair: string) {
    this.statePath = resolve(stateFile);
    this.journalPath = resolve(journalFile);
    mkdirSync(dirname(this.statePath), { recursive: true });
    mkdirSync(dirname(this.journalPath), { recursive: true });

    if (existsSync(this.statePath)) {
      const loaded = JSON.parse(readFileSync(this.statePath, "utf8")) as BotState;
      // A resume keeps history but clears the volatile per-cycle view.
      this.state = { ...emptyState(agentId, pair), ...loaded, agentId: agentId.toString(), pair };
      this.state.updatedAt = new Date().toISOString();
    } else {
      this.state = emptyState(agentId, pair);
    }
    this.persist();
  }

  get current(): BotState {
    return this.state;
  }

  update(mutator: (state: BotState) => void): BotState {
    mutator(this.state);
    this.state.updatedAt = new Date().toISOString();
    this.persist();
    return this.state;
  }

  recordGate(record: Omit<GateRecord, "at">): void {
    this.update((state) => {
      state.gateDecisions.push({ at: new Date().toISOString(), ...record });
      state.gateDecisions = state.gateDecisions.slice(-MAX_HISTORY);
      state.lastScore = record.score;
      if (record.allowed) state.cyclesAllowed += 1;
      else state.cyclesBlocked += 1;
    });
    this.journal({ ...record, kind: "gate" });
  }

  recordTrade(record: Omit<TradeRecord, "at">): void {
    this.update((state) => {
      state.trades.push({ at: new Date().toISOString(), ...record });
      state.trades = state.trades.slice(-MAX_HISTORY);
    });
    this.journal({ ...record, kind: record.kind });
  }

  halt(reason: string): void {
    this.update((state) => {
      state.halted = true;
      state.haltReason = reason;
      if (reason.toLowerCase().includes("drawdown")) state.killSwitchTripped = true;
    });
    this.journal({ kind: "halt", reason, at: new Date().toISOString() });
  }

  /** Kill-switch evidence: recorded with the halt so a slash can be justified later. */
  reportSlash(detail: { reason: string; pnlUsd: number; realisedPnlUsd: number }): void {
    this.update((state) => {
      state.slashReport = { at: new Date().toISOString(), cycle: state.cycle, ...detail };
    });
    this.journal({ kind: "slash-report", at: new Date().toISOString(), ...detail });
  }

  resume(): void {
    this.update((state) => {
      state.halted = false;
      state.haltReason = undefined;
      state.killSwitchTripped = false;
    });
    this.journal({ kind: "resume", at: new Date().toISOString() });
  }

  private journal(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`);
    } catch {
      /* journaling must never take the bot down */
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch {
      /* a read-only disk degrades to in-memory state rather than a crash */
    }
  }
}
