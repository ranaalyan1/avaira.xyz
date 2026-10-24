/**
 * HMAC authentication + single-use nonce registry (the replay guard).
 *
 * Rules this module enforces, and why:
 *
 *   1. Every /execute request is signed with HMAC-SHA256 over a canonical string of
 *      *exactly* the fields that authorize the action. Nothing outside the signed
 *      envelope may influence a decision (AUDIT.md finding 8's lesson, generalized).
 *   2. The per-agent key is derived from the installation seed
 *      (HMAC(seed, "agent:" + agentId)) — the same witness-key pattern the rest of
 *      the protocol uses. The raw seed never leaves the operator's machine.
 *   3. Nonces are single-use within a time-drift window. A captured request cannot
 *      be replayed, and a request older than DRIFT_MS is rejected outright —
 *      the OAuth login-CSRF finding (11) applied to execution instead of login.
 *   4. Signature comparison is constant-time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DRIFT_MS = 5 * 60 * 1000;

/** Canonical string that both sides sign. Order is fixed; adding a field is a wire break. */
export function canonical(params: {
  agentId: string;
  intentHash: string;
  envelopeHash: string;
  nonce: string;
  timestamp: number;
  bodyHash: string;
}): string {
  return [
    params.agentId,
    params.intentHash,
    params.envelopeHash,
    params.nonce,
    String(params.timestamp),
    params.bodyHash,
  ].join("\n");
}

/** Per-agent key derived from the seed. Never the seed itself. */
export function agentKey(seed: string, agentId: string): Buffer {
  return createHmac("sha256", seed).update(`agent:${agentId}`).digest();
}

/** hex(sha256(body)) — binds the opaque action payload to the signature without parsing it. */
export function bodyHash(body: string): string {
  return createHmac("sha256", "body-hash-domain").update(body).digest("hex");
}

export function sign(key: Buffer, canonicalString: string): string {
  return createHmac("sha256", key).update(canonicalString).digest("hex");
}

export function verifySignature(
  key: Buffer,
  canonicalString: string,
  presented: string,
): boolean {
  const expected = Buffer.from(sign(key, canonicalString), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(presented, "hex");
  } catch {
    return false;
  }
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/**
 * Single-use nonce registry. O(n) map for now — bounded by the TTL sweep — which is
 * the honest bound for a per-agent gateway; a real deployment would swap the Map for
 * the on-chain `PermitNonceRegistry` pattern.
 */
export class NonceRegistry {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = DRIFT_MS) {}

  /** true = fresh and inside the window; false = replayed or expired. */
  consume(agentId: string, nonce: string, timestamp: number, now: number): boolean {
    if (Math.abs(now - timestamp) > this.ttlMs) return false;
    this.sweep(now);
    const key = `${agentId}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private sweep(now: number): void {
    for (const [k, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(k);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
