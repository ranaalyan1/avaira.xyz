/**
 * The circuit breaker — the "offchain enforcement" half of CHAINLESS.md.
 *
 * The on-chain gate decides a *single* execution. The breaker decides whether the
 * agent gets to ask again at all: a gate denial is data, but a burst of denials is
 * a compromised or broken agent hammering the gate, and the right answer to that
 * is to stop asking the chain and start paging the operator.
 *
 * States:
 *   CLOSED    normal operation; denials increment a rolling failure count
 *   OPEN      threshold reached — every /execute for this agent fails fast (no RPC call)
 *   HALF_OPEN cooldown elapsed — exactly one probe request goes through;
 *             an ALLOWED probe closes the breaker, a denied probe re-opens it
 */
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  /** Denials within `windowMs` that trip the breaker. */
  threshold: number;
  /** Rolling window for the denial count. */
  windowMs: number;
  /** How long OPEN lasts before a probe is allowed. */
  cooldownMs: number;
}

export const DEFAULT_CONFIG: BreakerConfig = {
  threshold: 3,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
};

export class CircuitBreaker {
  private readonly denials: Array<{ at: number }> = [];
  private state: BreakerState = "CLOSED";
  private trippedAt = 0;

  constructor(private readonly cfg: BreakerConfig = DEFAULT_CONFIG) {}

  /** Is the breaker willing to consult the gate right now? */
  permits(now: number): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (now - this.trippedAt >= this.cfg.cooldownMs) {
        this.state = "HALF_OPEN";
        return true; // one probe
      }
      return false;
    }
    return true; // HALF_OPEN: the single probe goes through
  }

  /** Record a gate decision. Returns the state after the update. */
  record(allowed: boolean, now: number): BreakerState {
    if (this.state === "HALF_OPEN") {
      if (allowed) {
        this.state = "CLOSED";
        this.denials.length = 0;
      } else {
        this.trip(now);
      }
      return this.state;
    }
    if (allowed) {
      this.denials.length = 0;
      this.state = "CLOSED";
      return this.state;
    }
    this.denials.push({ at: now });
    while (this.denials.length > 0 && now - this.denials[0]!.at > this.cfg.windowMs) {
      this.denials.shift();
    }
    if (this.denials.length >= this.cfg.threshold) this.trip(now);
    return this.state;
  }

  private trip(now: number): void {
    this.state = "OPEN";
    this.trippedAt = now;
    this.denials.length = 0;
  }

  /** Operator action: clear the breaker without waiting out the cooldown. */
  reset(): void {
    this.state = "CLOSED";
    this.trippedAt = 0;
    this.denials.length = 0;
  }

  get state_(): BreakerState {
    return this.state;
  }

  snapshot(now: number): { state: BreakerState; denialsInWindow: number } {
    return {
      state: this.state,
      denialsInWindow: this.denials.filter((d) => now - d.at <= this.cfg.windowMs).length,
    };
  }
}

/** Per-agent registry. One breaker per agent — one agent's compromise never grounds the fleet. */
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly cfg: BreakerConfig = DEFAULT_CONFIG) {}

  for(agentId: string): CircuitBreaker {
    let b = this.breakers.get(agentId);
    if (!b) {
      b = new CircuitBreaker(this.cfg);
      this.breakers.set(agentId, b);
    }
    return b;
  }

  reset(agentId: string): boolean {
    const b = this.breakers.get(agentId);
    if (!b) return false;
    b.reset();
    return true;
  }
}
