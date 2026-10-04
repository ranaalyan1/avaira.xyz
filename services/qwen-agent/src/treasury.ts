/**
 * Treasury tool surface. Every tool call is executed inside `avaira.run()`
 * behind a task-budget RiskEnvelope; the envelope's `allowedActions` contains
 * exactly the one action the tool maps to, and `maxSpendUsd` is the remaining
 * task budget. The tool itself is a lightweight sim (offline-friendly); the
 * accountability layer (commit → gate → audit → attest → challenge window)
 * is fully on-chain.
 */
import type { ToolSpec } from "./types.js";

/** USD → micro-USD (1e6 = $1), matching the on-chain RiskEnvelope convention. */
function usdToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

export interface ToolContext {
  /** Mock ledger the simulated treasury operates on. */
  ledger: Record<string, number>;
}

export interface ToolResult {
  action: string;
  /** Spend recorded in the audit trail (micro-USD). */
  spendUsd: bigint;
  result: unknown;
}

export const TREASURY_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "treasury_balance",
      description: "Read current treasury balances by asset.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "treasury_quote",
      description: "Quote a swap between two treasury assets.",
      parameters: {
        type: "object",
        properties: {
          fromAsset: { type: "string" },
          toAsset: { type: "string" },
          amountUsd: { type: "number", description: "Notional in USD" },
        },
        required: ["fromAsset", "toAsset", "amountUsd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "treasury_swap",
      description: "Execute a swap between treasury assets. Costs a 10 bps execution fee.",
      parameters: {
        type: "object",
        properties: {
          fromAsset: { type: "string" },
          toAsset: { type: "string" },
          amountUsd: { type: "number", description: "Notional in USD" },
        },
        required: ["fromAsset", "toAsset", "amountUsd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cert_verify",
      description: "Verify an off-chain certificate before acting on it. Costs the provider fee.",
      parameters: {
        type: "object",
        properties: {
          certificate: { type: "string" },
          feeUsd: { type: "number", description: "Provider fee in USD" },
        },
        required: ["certificate", "feeUsd"],
      },
    },
  },
];

/** Maps tool names to their audit-trail action discriminator. */
export const TOOL_ACTIONS: Record<string, string> = {
  treasury_balance: "treasury.balance",
  treasury_quote: "treasury.quote",
  treasury_swap: "treasury.swap",
  cert_verify: "cert.verify",
};

export function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "treasury_balance":
      return { action: TOOL_ACTIONS[name]!, spendUsd: 0n, result: { ...ctx.ledger } };

    case "treasury_quote": {
      const amountUsd = Number(args.amountUsd ?? 0);
      return {
        action: TOOL_ACTIONS[name]!,
        spendUsd: 0n,
        result: {
          fromAsset: args.fromAsset,
          toAsset: args.toAsset,
          amountUsd,
          rate: 1.0,
          feeUsd: amountUsd * 0.001,
          executable: (ctx.ledger[String(args.fromAsset)] ?? 0) >= amountUsd,
        },
      };
    }

    case "treasury_swap": {
      const amountUsd = Number(args.amountUsd ?? 0);
      const from = String(args.fromAsset);
      const to = String(args.toAsset);
      if ((ctx.ledger[from] ?? 0) < amountUsd) {
        throw new Error(`insufficient treasury balance: ${from}=${ctx.ledger[from] ?? 0} < ${amountUsd}`);
      }
      const feeUsd = amountUsd * 0.001; // 10 bps execution fee
      ctx.ledger[from] = (ctx.ledger[from] ?? 0) - amountUsd;
      ctx.ledger[to] = (ctx.ledger[to] ?? 0) + amountUsd * 0.999;
      return {
        action: TOOL_ACTIONS[name]!,
        spendUsd: usdToMicro(feeUsd),
        result: { filledUsd: amountUsd, feeUsd, rate: 1.0, balances: { ...ctx.ledger } },
      };
    }

    case "cert_verify": {
      // The naive verifier accepts whatever it is handed; authenticity is the
      // challenge window's problem — that is precisely what scenario (c) proves.
      const feeUsd = Number(args.feeUsd ?? 0);
      return {
        action: TOOL_ACTIONS[name]!,
        spendUsd: usdToMicro(feeUsd),
        result: {
          certificate: args.certificate,
          verified: true,
          note: "mock verifier: signature bytes accepted without issuer check",
        },
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
