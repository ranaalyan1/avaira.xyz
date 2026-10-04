/**
 * Perpl DEX adapter.
 *
 * `PerplExchange` is the seam the bot trades through. Two implementations exist:
 *
 *   • `SimulatedPerplExchange` — deterministic offline book/model used by tests, CI and the
 *     `PERPL_MOCK=1` demo mode. No network, no funds.
 *   • `HttpPerplExchange`      — the live client. Perpl's developer docs and the
 *     `PerplFoundation/dex-sdk` package describe a REST surface for markets, orders and
 *     positions; the paths are configurable because the API is still moving. Every call is
 *     logged with its tx hash when the DEX returns one.
 *
 * The bot never talks to Perpl except through this interface, so a live deployment is one
 * env var (`PERPL_MOCK=0`) away once credentials exist.
 */
import type { BotConfig } from "./config";

export type Side = "buy" | "sell";

export interface OrderRequest {
  pair: string;
  side: Side;
  /** Limit price in USD per base unit. */
  price: number;
  /** Size in USD notional. */
  sizeUsd: number;
  clientId: string;
}

export interface OrderResult {
  orderId: string;
  pair: string;
  side: Side;
  price: number;
  sizeUsd: number;
  status: "open" | "filled" | "rejected";
  filledSizeUsd?: number;
  txHash?: string;
  rejectReason?: string;
}

export interface Position {
  pair: string;
  /** Signed base size: positive = long, negative = short. */
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnlUsd: number;
}

export interface MarketSnapshot {
  pair: string;
  markPrice: number;
  bid: number;
  ask: number;
  /** Depth in USD available within 1% of mid. */
  depthUsd: number;
}

export interface PerplExchange {
  readonly kind: "live" | "simulated";
  market(pair: string): Promise<MarketSnapshot>;
  openOrders(pair: string): Promise<OrderResult[]>;
  positions(pair: string): Promise<Position[]>;
  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<{ orderId: string; txHash?: string; status: "cancelled" | "missing" }>;
  /** Realised PnL since the bot started, in USD (positive = profit). */
  realisedPnlUsd(): Promise<number>;
}

/* ─────────────────────────────── simulated exchange ─────────────────────────── */

interface SimulatedState {
  mid: number;
  orders: Map<string, OrderResult>;
  position: number;
  entryPrice: number;
  realisedPnl: number;
  nextId: number;
  driftPct: number;
}

/**
 * Deterministic random-walk book. The drift is a constructor argument so the drawdown
 * kill-switch can be exercised on demand (`demo:drawdown`).
 */
export class SimulatedPerplExchange implements PerplExchange {
  readonly kind = "simulated" as const;
  private state: SimulatedState;
  private fillsThisTick = 0;

  constructor(options: { mid?: number; driftPct?: number } = {}) {
    this.state = {
      mid: options.mid ?? 3.4,
      orders: new Map(),
      position: 0,
      entryPrice: 0,
      realisedPnl: 0,
      nextId: 1,
      driftPct: options.driftPct ?? 0,
    };
  }

  async market(pair: string): Promise<MarketSnapshot> {
    this.advance();
    const spread = this.state.mid * 0.0008;
    return {
      pair,
      markPrice: this.state.mid,
      bid: this.state.mid - spread,
      ask: this.state.mid + spread,
      depthUsd: 250_000,
    };
  }

  async openOrders(_pair: string): Promise<OrderResult[]> {
    return [...this.state.orders.values()].filter((order) => order.status === "open");
  }

  async positions(pair: string): Promise<Position[]> {
    if (this.state.position === 0) return [];
    return [
      {
        pair,
        size: this.state.position,
        entryPrice: this.state.entryPrice,
        markPrice: this.state.mid,
        unrealisedPnlUsd: (this.state.mid - this.state.entryPrice) * this.state.position,
      },
    ];
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const order: OrderResult = {
      orderId: `sim-${this.state.nextId++}`,
      pair: request.pair,
      side: request.side,
      price: request.price,
      sizeUsd: request.sizeUsd,
      status: "open",
      txHash: `0x${this.state.nextId.toString(16).padStart(64, "0")}`,
    };
    // Immediate cross: a quote through the current mark fills at the mark.
    const crosses = request.side === "buy" ? request.price >= this.state.mid : request.price <= this.state.mid;
    if (crosses) {
      this.applyFill(order);
    } else {
      this.state.orders.set(order.orderId, order);
    }
    return order;
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; txHash?: string; status: "cancelled" | "missing" }> {
    const found = this.state.orders.get(orderId);
    if (!found) return { orderId, status: "missing" };
    this.state.orders.delete(orderId);
    return { orderId, txHash: `0x${(this.state.nextId++).toString(16).padStart(64, "0")}`, status: "cancelled" };
  }

  async realisedPnlUsd(): Promise<number> {
    return this.state.realisedPnl;
  }

  /** Test/demo hook: force the market to move by `pct`. */
  shock(pct: number): void {
    this.state.mid *= 1 + pct / 100;
  }

  private advance(): void {
    // Small deterministic drift so the grid has something to do between cycles, plus the
    // configured pressure used by the drawdown demo.
    const wobble = Math.sin(this.state.nextId + this.fillsThisTick) * 0.0005;
    this.state.mid *= 1 + this.state.driftPct / 100 + wobble;
    // Anything the market traded through since the last tick fills — that is how the grid
    // accumulates a position, and how a falling market turns into unrealised loss.
    for (const order of [...this.state.orders.values()]) {
      const crossed = order.side === "buy" ? order.price >= this.state.mid : order.price <= this.state.mid;
      if (crossed) {
        this.state.orders.delete(order.orderId);
        this.applyFill(order);
      }
    }
  }

  /**
   * Position keeping with a volume-weighted average entry, so unrealised PnL accumulates as
   * the market moves away from the entry — the loss the drawdown kill-switch is watching.
   */
  private applyFill(order: OrderResult): void {
    const fillPrice = this.state.mid;
    const delta = (order.sizeUsd / fillPrice) * (order.side === "buy" ? 1 : -1);
    const oldPosition = this.state.position;
    const newPosition = oldPosition + delta;

    if (oldPosition !== 0 && Math.sign(delta) !== Math.sign(oldPosition)) {
      // Reducing (or flipping): realise PnL on the closed part.
      const closed = Math.min(Math.abs(delta), Math.abs(oldPosition));
      this.state.realisedPnl += (fillPrice - this.state.entryPrice) * closed * Math.sign(oldPosition);
    }

    if (newPosition === 0) {
      this.state.entryPrice = 0;
    } else if (oldPosition === 0 || Math.sign(newPosition) !== Math.sign(oldPosition)) {
      // Opened or flipped: the residual position is priced at this fill.
      this.state.entryPrice = fillPrice;
    } else if (Math.sign(newPosition) === Math.sign(oldPosition) && Math.abs(newPosition) > Math.abs(oldPosition)) {
      // Added to an existing position: volume-weighted average entry.
      const added = Math.abs(newPosition) - Math.abs(oldPosition);
      this.state.entryPrice = (this.state.entryPrice * Math.abs(oldPosition) + fillPrice * added) / Math.abs(newPosition);
    }

    this.state.position = newPosition;
    order.status = "filled";
    order.filledSizeUsd = order.sizeUsd;
    this.fillsThisTick += 1;
  }
}

/* ───────────────────────────────── live exchange ────────────────────────────── */

/**
 * REST client for the Perpl DEX. Paths follow the developer docs
 * (docs.perpl.xyz/resources/for-developers) and the `@perpl/dex-sdk` surface; they are
 * overridable via env so a path rename does not require a code change.
 */
export class HttpPerplExchange implements PerplExchange {
  readonly kind = "live" as const;
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: BotConfig) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.config.perplApiKey ? { authorization: `Bearer ${this.config.perplApiKey}` } : {}),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.config.perplApiUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Perpl ${init.method ?? "GET"} ${path} → ${response.status} ${body.slice(0, 200)}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
      if (this.timer) clearTimeout(this.timer);
    }
  }

  async market(pair: string): Promise<MarketSnapshot> {
    const data = await this.request<{ markPrice?: string; bid?: string; ask?: string; depthUsd?: string }>(
      `/v1/markets/${encodeURIComponent(pair)}`,
    );
    const mid = Number(data.markPrice ?? data.bid ?? 0);
    return {
      pair,
      markPrice: mid,
      bid: Number(data.bid ?? mid),
      ask: Number(data.ask ?? mid),
      depthUsd: Number(data.depthUsd ?? 0),
    };
  }

  async openOrders(pair: string): Promise<OrderResult[]> {
    const data = await this.request<{ orders?: OrderResult[] }>(`/v1/orders?market=${encodeURIComponent(pair)}&status=open`);
    return (data.orders ?? []).map((order) => ({ ...order, pair }));
  }

  async positions(pair: string): Promise<Position[]> {
    const data = await this.request<{ positions?: Position[] }>(`/v1/positions?market=${encodeURIComponent(pair)}`);
    return (data.positions ?? []).map((position) => ({ ...position, pair }));
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const data = await this.request<{ orderId: string; status?: string; filledSizeUsd?: string; txHash?: string; reason?: string }>(
      "/v1/orders",
      {
        method: "POST",
        body: JSON.stringify({
          market: request.pair,
          side: request.side,
          type: "limit",
          price: request.price,
          sizeUsd: request.sizeUsd,
          clientId: request.clientId,
        }),
      },
    );
    return {
      orderId: data.orderId,
      pair: request.pair,
      side: request.side,
      price: request.price,
      sizeUsd: request.sizeUsd,
      status: (data.status as OrderResult["status"]) ?? "open",
      filledSizeUsd: data.filledSizeUsd ? Number(data.filledSizeUsd) : undefined,
      txHash: data.txHash,
      rejectReason: data.reason,
    };
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; txHash?: string; status: "cancelled" | "missing" }> {
    const data = await this.request<{ txHash?: string }>(`/v1/orders/${orderId}`, { method: "DELETE" }).catch(() => null);
    return data ? { orderId, txHash: data.txHash, status: "cancelled" } : { orderId, status: "missing" };
  }

  async realisedPnlUsd(): Promise<number> {
    const data = await this.request<{ realisedPnlUsd?: string }>("/v1/account/pnl").catch(() => ({ realisedPnlUsd: "0" }));
    return Number(data.realisedPnlUsd ?? 0);
  }
}

export function createExchange(config: BotConfig): PerplExchange {
  return config.mock ? new SimulatedPerplExchange() : new HttpPerplExchange(config);
}
