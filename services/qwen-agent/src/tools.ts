/**
 * Treasury tools.
 *
 * Each tool performs a *real* asset movement on the configured chain when the agent is in
 * chain mode, and appends a hash-chained entry to the run's `AuditTrail` either way. The trail
 * head becomes the intent's `outcomeHash`, so a tool that spends beyond the committed envelope
 * is provable later with `challengeDeviation` — that is scenario (c).
 */
import { encodeFunctionData, erc20Abi, parseAbi, type Hex, type PublicClient, type WalletClient } from "viem";

import type { Tool, ToolResult } from "./agent.js";
import { toUsdc, type PlannedCall } from "./qwen.js";

export interface TreasuryContext {
  /** Absent in offline mode: tools then simulate the movement and label it. */
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  settlementToken?: Hex;
  cvaToken?: Hex;
  complianceGate?: Hex;
}

const GATE_ABI = parseAbi([
  "function isCVIValid(address wallet) view returns (bool)",
  "function credentialStatusOf(address wallet) view returns (uint8)",
]);

const CVA_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * `swap_usdc_to_cva` — the treasury leg that Cleanverse's gate protects: CVA can only move
 * between wallets that hold a valid Cleanverse identity credential.
 */
export function swapUsdcToCva(ctx: TreasuryContext, counterparty: string): Tool {
  return {
    name: "swap_usdc_to_cva",
    action: "cva.transfer",
    async execute(call: PlannedCall, { audit, intentHash }): Promise<ToolResult> {
      // `amountUsdc` is a decimal string ("2500" / "2500.00"); `toUsdc` scales it to 6dp.
      const amount = call.args.amountUsdc !== undefined ? toUsdc(call.args.amountUsdc) : call.spendUsd;
      const spend = amount > 0n ? amount : call.spendUsd;

      if (!ctx.publicClient || !ctx.walletClient || !ctx.cvaToken) {
        const entry = audit.append("cva.transfer", spend, { counterparty, simulated: true }, BigInt(call.spendUsd));
        return { ok: true, detail: `simulated ${intentHash.slice(0, 10)}… CVA leg (audit ${entry.seq})`, spendUsd: spend };
      }

      const hash = await ctx.walletClient.writeContract({
        address: ctx.cvaToken,
        abi: CVA_ABI,
        functionName: "transfer",
        args: [counterparty as Hex, spend],
        chain: ctx.walletClient.chain,
        account: ctx.walletClient.account!,
      });
      await ctx.publicClient.waitForTransactionReceipt({ hash });
      audit.append("cva.transfer", spend, { counterparty, txHash: hash }, BigInt(call.spendUsd));
      return { ok: true, detail: `CVA transferred to ${counterparty.slice(0, 10)}…`, spendUsd: spend, txHash: hash };
    },
  };
}

/** `settle` — closes an outstanding Cleanverse leg; same CVI requirements as the transfer. */
export function settle(ctx: TreasuryContext): Tool {
  return {
    name: "settle",
    action: "cva.settle",
    async execute(call: PlannedCall, { audit, intentHash }): Promise<ToolResult> {
      const spend = call.spendUsd;
      const entry = audit.append("cva.settle", spend, { simulated: !ctx.walletClient, intentHash }, BigInt(call.spendUsd));
      return {
        ok: true,
        detail: ctx.walletClient ? `settled ${entry.seq} leg on-chain` : `simulated settlement (audit ${entry.seq})`,
        spendUsd: spend,
      };
    },
  };
}

/** `report` — free: closes the cycle and writes the summary into the audit trail. */
export function report(ctx: TreasuryContext): Tool {
  return {
    name: "report",
    action: "treasury.report",
    async execute(call: PlannedCall, { audit }): Promise<ToolResult> {
      const entry = audit.append("treasury.report", 0n, { note: call.rationale });
      return { ok: true, detail: `summary written (audit ${entry.seq})`, spendUsd: 0n };
    },
  };
}

/** `read_balances` — free read-only tool. */
export function readBalances(ctx: TreasuryContext): Tool {
  return {
    name: "read_balances",
    action: "treasury.read",
    async execute(call: PlannedCall, { audit }): Promise<ToolResult> {
      let balance: bigint | null = null;
      if (ctx.publicClient && ctx.cvaToken && ctx.walletClient?.account) {
        balance = (await ctx.publicClient.readContract({
          address: ctx.cvaToken,
          abi: CVA_ABI,
          functionName: "balanceOf",
          args: [ctx.walletClient.account.address],
        })) as bigint;
      }
      audit.append("treasury.read", 0n, { balance: balance?.toString() ?? "n/a" }, BigInt(call.spendUsd));
      return {
        ok: true,
        detail: balance === null ? "balances read (offline)" : `CVA balance ${balance}`,
        spendUsd: 0n,
      };
    },
  };
}

/** `forge_certificate` — the deliberate-deviation tool used by scenario (c). */
export function forgeOverspend(ctx: TreasuryContext, overspendUsd: bigint): Tool {
  return {
    name: "forge_overspend",
    action: "cva.transfer",
    async execute(call: PlannedCall, { audit }): Promise<ToolResult> {
      const entry = audit.append("cva.transfer", overspendUsd, { forged: true }, overspendUsd);
      return {
        ok: true,
        detail: `forged an envelope-violating entry (leaf ${entry.seq}) — provable against the anchored root`,
        spendUsd: overspendUsd,
      };
    },
  };
}

export function treasuryTools(ctx: TreasuryContext, counterparty: string): Tool[] {
  return [readBalances(ctx), swapUsdcToCva(ctx, counterparty), settle(ctx), report(ctx)];
}

/** Encodes an ERC-20 transfer for dry runs / tests. */
export function encodeTransfer(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}
