/**
 * Gate relay — the only part of the gateway that talks to the chain, and only ever
 * with `eth_call` (read-only). The gateway never broadcasts: settlement is the
 * operator's wallet's job (or the SDK's). This service is a *decision* service.
 *
 * The relay reads the vault address from the deployment manifest that
 * `make deploy-robinhood` wrote, so it can never point at a stale address while
 * claiming otherwise — the manifest is the source of truth.
 */
import { createPublicClient, http, type PublicClient, type Chain } from "viem";
import {
  robinhoodTestnet,
  robinhoodMainnet,
  GATE_INTENT_ABI,
  GATE_REASON_LABELS,
} from "@avaira/sdk";

export interface GateDecision {
  allowed: boolean;
  score: number;
  reason: number;
  latencyMs: number;
}

export interface GateClient {
  check(agentId: bigint, intentHash: `0x${string}`, envelopeHash: `0x${string}`): Promise<GateDecision>;
  vaultAddress(): `0x${string}`;
}

export function reasonName(reason: number): string {
  return GATE_REASON_LABELS[reason] ?? `unknown_${reason}`;
}

export class RobinhoodGateClient implements GateClient {
  private readonly client: PublicClient;
  private readonly vault: `0x${string}`;

  constructor(opts: { rpcUrl: string; chainId: number; vault: `0x${string}` }) {
    const chain = (opts.chainId === 4663 ? robinhoodMainnet : robinhoodTestnet) as unknown as Chain;
    this.client = createPublicClient({ chain, transport: http(opts.rpcUrl) });
    this.vault = opts.vault;
  }

  vaultAddress(): `0x${string}` {
    return this.vault;
  }

  async check(
    agentId: bigint,
    intentHash: `0x${string}`,
    envelopeHash: `0x${string}`,
  ): Promise<GateDecision> {
    const t0 = Date.now();
    const result = (await this.client.readContract({
      address: this.vault,
      abi: GATE_INTENT_ABI,
      functionName: "checkGate",
      args: [agentId, intentHash, envelopeHash],
    })) as unknown as readonly [boolean, bigint, bigint];
    return {
      allowed: result[0],
      score: Number(result[1]),
      reason: Number(result[2]),
      latencyMs: Date.now() - t0,
    };
  }
}

/** A stub for tests: answers from a queue, never touches a network. */
export class StubGateClient implements GateClient {
  constructor(private answers: Array<GateDecision>) {}
  check(): Promise<GateDecision> {
    const next = this.answers.shift() ?? { allowed: true, score: 78, reason: 0, latencyMs: 1 };
    return Promise.resolve(next);
  }
  vaultAddress(): `0x${string}` {
    return "0x0000000000000000000000000000000000000000";
  }
}

/** Reads the vault address out of a deployment manifest the same way the SDK does. */
export function vaultFromManifest(manifest: { intentVault: string }): `0x${string}` {
  return manifest.intentVault as `0x${string}`;
}
