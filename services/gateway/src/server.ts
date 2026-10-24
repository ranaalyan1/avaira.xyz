/**
 * The Avaira Gateway — HTTP decision service in front of the on-chain gate.
 *
 *   POST /execute   auth (HMAC) → replay guard → circuit breaker → checkGate (eth_call)
 *                   → 200 {decision} | 401 | 403 | 409 | 423 | 503
 *   GET  /health    liveness + breaker population
 *   GET  /breaker/:agentId   breaker state for an agent (operator tooling)
 *   POST /breaker/:agentId/reset   operator reset (requires the admin key)
 *
 * The gateway NEVER executes the action and NEVER broadcasts a transaction. It
 * answers one question: "does the chain's gate permit this execution right now?"
 * What the caller does with that answer is their accountability — which is the
 * exact accountability the protocol exists to create.
 */
import { createHash } from "node:crypto";
import {
  agentKey,
  bodyHash,
  canonical,
  verifySignature,
  NonceRegistry,
  DRIFT_MS,
} from "./auth.js";
import { BreakerRegistry, DEFAULT_CONFIG, type BreakerConfig } from "./breaker.js";
import { reasonName, type GateClient, type GateDecision } from "./gate.js";

export interface GatewayOptions {
  seed: string;
  adminSeed: string;
  gate: GateClient;
  breakerCfg?: BreakerConfig;
  now?: () => number;
}

export interface ExecuteRequest {
  agentId: string;
  intentHash: string;
  envelopeHash: string;
  nonce: string;
  timestamp: number;
  /** opaque action payload; hashed, never interpreted by the gateway */
  action?: unknown;
}

export type GatewayResponse =
  | { status: 200; body: { decision: "ALLOWED" | "DENIED"; reason: string; score: number; latencyMs: number; breaker: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 409; body: { error: string } }
  | { status: 423; body: { error: string; breaker: string } }
  | { status: 503; body: { error: string } }
  | { status: 404; body: { error: string } };

export class Gateway {
  private readonly nonces = new NonceRegistry(DRIFT_MS);
  private readonly breakers: BreakerRegistry;
  private readonly now: () => number;

  constructor(private readonly opts: GatewayOptions) {
    this.breakers = new BreakerRegistry(opts.breakerCfg ?? DEFAULT_CONFIG);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Route table, small enough to dispatch by hand. */
  handle(
    method: "POST" | "GET",
    path: string,
    headers: { signature?: string; "x-admin-signature"?: string },
    body: ExecuteRequest,
  ): Promise<GatewayResponse> {
    if (method === "GET" && path === "/health") return Promise.resolve(this.health());
    if (method === "POST" && path === "/execute") return this.execute(headers.signature ?? "", body);
    if (method === "GET" && path.startsWith("/breaker/"))
      return Promise.resolve(this.breakerState(path.slice("/breaker/".length)));
    if (method === "POST" && path.endsWith("/reset") && path.startsWith("/breaker/"))
      return this.breakerReset(path.split("/")[2] ?? "", headers["x-admin-signature"] ?? "");
    return Promise.resolve({ status: 404, body: { error: "not found" } } as GatewayResponse);
  }

  async execute(signature: string, req: ExecuteRequest): Promise<GatewayResponse> {
    const t = this.now();
    // 1. Time window — reject stale requests before touching the nonce registry.
    if (Math.abs(t - Number(req.timestamp)) > DRIFT_MS) {
      return { status: 401, body: { error: "timestamp outside drift window" } };
    }
    // 2. HMAC over exactly the fields that authorize the action.
    const key = agentKey(this.opts.seed, req.agentId);
    const canon = canonical({
      agentId: req.agentId,
      intentHash: req.intentHash,
      envelopeHash: req.envelopeHash,
      nonce: req.nonce,
      timestamp: Number(req.timestamp),
      bodyHash: bodyHash(JSON.stringify(req.action ?? {})),
    });
    if (!verifySignature(key, canon, signature)) {
      return { status: 401, body: { error: "bad signature" } };
    }
    // 3. Single-use nonce: a captured request dies on its second trip.
    if (!this.nonces.consume(req.agentId, req.nonce, Number(req.timestamp), t)) {
      return { status: 409, body: { error: "nonce replayed or expired" } };
    }
    // 4. Circuit breaker: an agent in OPEN never reaches the RPC.
    const breaker = this.breakers.for(req.agentId);
    if (!breaker.permits(t)) {
      return {
        status: 423,
        body: { error: "circuit breaker open", breaker: breaker.state_ },
      };
    }
    // 5. The gate itself — one read-only call.
    let decision: GateDecision;
    try {
      decision = await this.opts.gate.check(
        BigInt(req.agentId),
        req.intentHash as `0x${string}`,
        req.envelopeHash as `0x${string}`,
      );
    } catch (err) {
      // RPC failure: record nothing, fail closed. The breaker counts *denials*,
      // not infrastructure errors — an outage must not ground the fleet.
      return { status: 503, body: { error: `gate unreachable: ${String(err)}` } };
    }
    // 6. Record the decision in the breaker and answer.
    const state = breaker.record(decision.allowed, t);
    return {
      status: 200,
      body: {
        decision: decision.allowed ? "ALLOWED" : "DENIED",
        reason: reasonName(decision.reason),
        score: decision.score,
        latencyMs: decision.latencyMs,
        breaker: state,
      },
    };
  }

  private health(): GatewayResponse {
    return {
      status: 200,
      body: {
        decision: "ALLOWED",
        reason: `vault=${this.opts.gate.vaultAddress()}`,
        score: 0,
        latencyMs: 0,
        breaker: "ok",
      },
    };
  }

  private breakerState(agentId: string): GatewayResponse {
    const b = this.breakers.for(agentId);
    return {
      status: 200,
      body: {
        decision: "ALLOWED",
        reason: JSON.stringify(b.snapshot(this.now())),
        score: 0,
        latencyMs: 0,
        breaker: b.state_,
      },
    };
  }

  private async breakerReset(agentId: string, adminSig: string): Promise<GatewayResponse> {
    const canon = `admin:reset:${agentId}`;
    const key = agentKey(this.opts.adminSeed, "admin");
    if (!verifySignature(key, canon, adminSig)) {
      return { status: 403, body: { error: "admin reset requires the admin key" } };
    }
    return {
      status: 200,
      body: {
        decision: "ALLOWED",
        reason: this.breakers.reset(agentId) ? "breaker reset" : "no breaker to reset",
        score: 0,
        latencyMs: 0,
        breaker: "CLOSED",
      },
    };
  }
}

/** A zero-dependency server wrapper (node:http) so the service is runnable as-is. */
export function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
