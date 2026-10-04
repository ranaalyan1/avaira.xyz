/**
 * Perpl exchange access.
 *
 * Two implementations behind one interface:
 *  - SimExchange  — offline paper book with a drifting mid; every order gets a
 *                   deterministic pseudo tx hash so the audit trail and the
 *                   /status telemetry stay realistic. Default (PERPL_MODE=sim),
 *                   and the only mode usable from a sandboxed machine.
 *  - HttpExchange — thin fetch client for a real Perpl endpoint (PERPL_MODE=live,
 *                   PERPL_API_URL). Errors propagate; the bot treats an
 *                   unreachable exchange as a failed cycle and halts safely.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import type { Fill, GridOrder, PlacedOrder, Quote, Settlement } from "./types.js";
import { usdToMicro } from "./types.js";

export interface Exchange {
  readonly mode: "sim" | "live";
  quote(pair: string): Promise<Quote>;
  place(order: GridOrder, cycle: number): Promise<PlacedOrder>;
  cancel(order: PlacedOrder): Promise<string | null>;
  settle(): Promise<Settlement>;
}

/* ─────────────────────────────── sim exchange ─────────────────────────────── */

export class SimExchange implements Exchange {
  readonly mode = "sim" as const;
  private mid: number;
  private seq = 0;
  private fills: Fill[] = [];
  private realizedPnlUsd = 0n;
  /** Resting quotes that did not cross the mid when placed. */
  private book = new Map<string, GridOrder>();
  /** Internal FIFO inventory for realised-PnL accounting. */
  private invQty = 0;
  private invAvg = 0;
  private lastSettledPnlUsd = 0n;

  constructor(private pair: string, private monUsd: number, private seed = 42) {
    this.mid = monUsd > 0 ? monUsd : 1;
  }

  private rand(): number {
    // Mulberry32 — deterministic per seed, stable across restarts is not required.
    this.seed |= 0;
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private txHash(label: string): string {
    this.seq += 1;
    return keccak256(
      encodeAbiParameters(parseAbiParameters("string label, uint256 seq, uint256 ts"), [
        `${this.pair}:${label}`,
        BigInt(this.seq),
        BigInt(Date.now()),
      ]),
    );
  }

  async quote(_pair?: string, ticks = 25): Promise<Quote> {
    // The market keeps moving between bot cycles: advance the walk `ticks`
    // times (±8 bps each), sweeping the book for crossings on every tick so
    // resting grid quotes actually get lifted when price reaches them.
    for (let i = 0; i < ticks; i++) {
      const drift = (this.rand() - 0.5) * 0.0016 * this.mid;
      this.mid = Math.max(0.01, this.mid + drift);
      this.sweepBook();
    }

    const halfSpread = this.mid * 0.0004;
    return {
      pair: this.pair,
      mid: this.mid,
      bid: this.mid - halfSpread,
      ask: this.mid + halfSpread,
      depth: 500,
      ts: Date.now(),
    };
  }

  async place(order: GridOrder, cycle: number): Promise<PlacedOrder> {
    const id = `sim-${this.seq + 1}`;
    const txHash = this.txHash("place");
    // An aggressive order that already crosses the mid fills immediately.
    const crosses = order.side === "buy" ? order.price >= this.mid : order.price <= this.mid;
    if (crosses) {
      this.recordFill(id, order);
    } else {
      this.book.set(id, order);
    }
    return { ...order, id, txHash, placedAt: Date.now(), cycle };
  }

  async cancel(order: PlacedOrder): Promise<string | null> {
    this.book.delete(order.id);
    return this.txHash(`cancel:${order.id}`);
  }

  /** Fills every resting quote the current mid has crossed. */
  private sweepBook(): void {
    for (const [id, order] of this.book) {
      const crossed = order.side === "buy" ? this.mid <= order.price : this.mid >= order.price;
      if (crossed) {
        this.recordFill(id, order);
        this.book.delete(id);
      }
    }
  }

  private recordFill(id: string, order: GridOrder): void {
    const txHash = this.txHash("fill");
    this.fills.push({ orderId: id, side: order.side, price: order.price, qty: order.qty, usd: order.notionalUsd, txHash });
    // FIFO inventory for realised PnL.
    const signed = order.side === "buy" ? order.qty : -order.qty;
    const nextQty = this.invQty + signed;
    if (nextQty === 0 || this.invQty === 0 || Math.sign(this.invQty) === Math.sign(signed)) {
      this.invAvg = nextQty === 0 ? 0 : (Math.abs(this.invQty) * this.invAvg + order.qty * order.price) / Math.abs(nextQty);
      this.invQty = nextQty;
    } else {
      // reducing: realise the edge against the average entry.
      const closed = Math.min(Math.abs(this.invQty), order.qty);
      const edge = order.side === "buy" ? this.invAvg - order.price : order.price - this.invAvg;
      this.realizedPnlUsd += usdToMicro(edge * closed);
      this.invQty = nextQty;
    }
  }

  async settle(): Promise<Settlement> {
    const volumeUsd = this.fills.reduce((sum, f) => sum + f.usd, 0n);
    const feesUsd = volumeUsd / 10_000n; // 1 bp taker fee
    const fills = this.fills;
    this.fills = [];
    // Realise the PnL delta since the last settlement.
    const realizedPnlUsd = this.realizedPnlUsd - this.lastSettledPnlUsd;
    this.lastSettledPnlUsd = this.realizedPnlUsd;
    return {
      txHash: this.txHash("settle"),
      realizedPnlUsd,
      feesUsd,
      fills,
    };
  }

  cumulativePnlUsd(): bigint {
    return this.realizedPnlUsd;
  }
}

/* ─────────────────────────────── live exchange ────────────────────────────── */

export class HttpExchange implements Exchange {
  readonly mode = "live" as const;

  constructor(private baseUrl: string, private apiKey?: string, private pair = "MON/USDC") {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`Perpl API ${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  quote(): Promise<Quote> {
    return this.request<Quote>(`/quote?pair=${encodeURIComponent(this.pair)}`);
  }

  async place(order: GridOrder): Promise<PlacedOrder> {
    const body = await this.request<{ orderId: string; txHash: string }>("/order", {
      method: "POST",
      body: JSON.stringify({ pair: this.pair, ...order, notionalUsd: order.notionalUsd.toString() }),
    });
    return { ...order, id: body.orderId, txHash: body.txHash, placedAt: Date.now(), cycle: -1 };
  }

  async cancel(order: PlacedOrder): Promise<string | null> {
    const body = await this.request<{ txHash?: string }>(`/order/${order.id}`, { method: "DELETE" });
    return body.txHash ?? null;
  }

  settle(): Promise<Settlement> {
    return this.request<Settlement>("/settle", { method: "POST" });
  }
}

export function createExchange(
  mode: "sim" | "live",
  pair: string,
  monUsd: number,
  apiUrl?: string,
  apiKey?: string,
): Exchange {
  return mode === "live" ? new HttpExchange(apiUrl ?? "", apiKey, pair) : new SimExchange(pair, monUsd);
}
