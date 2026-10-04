/**
 * Chain wiring for the treasury agent: SDK client, agent provisioning
 * (register + stake + score), score helpers for the overspend scenario, and
 * the challenger flow for the deviation scenario.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import {
  Avaira,
  AuditTrail,
  INTENT_VAULT_ABI,
  loadDeployment,
  STAKE_REGISTRY_ABI,
  type DeploymentManifest,
} from "../../../sdk/typescript/src/index.js";

/** MockUSDC surface (permissionless mint on test chains). */
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
import type { QwenConfig } from "./types.js";

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256)",
  "function registrationBond() view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
const STAKE_ABI = parseAbi([
  "function stake(uint256 agentId, uint256 amount)",
  "function stakeOf(uint256 agentId) view returns (uint256)",
  "function minStake() view returns (uint256)",
]);
const REPUTATION_ABI = parseAbi([
  "function postAvairaScore(uint256 agentId, uint8 score)",
  "function scoreOf(uint256 agentId) view returns (uint8)",
]);

export interface Ctx {
  cfg: QwenConfig;
  manifest: DeploymentManifest;
  avaira: Avaira;
  publicClient: PublicClient;
  operatorWallet: WalletClient;
  operator: LocalAccount;
  challengerWallet: WalletClient;
  challenger: LocalAccount;
}

export function buildCtx(cfg: QwenConfig): Ctx {
  const manifest = loadDeployment(cfg.chainId, cfg.manifestPath);
  const chain = defineChain({
    id: cfg.chainId,
    name: `avaira-${cfg.chainId}`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const operator = privateKeyToAccount(cfg.operatorKey);
  const challenger = privateKeyToAccount(cfg.challengerKey);
  return {
    cfg,
    manifest,
    avaira: new Avaira({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, contracts: manifest, privateKey: cfg.operatorKey }),
    publicClient: createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient,
    operatorWallet: createWalletClient({ chain, transport: http(cfg.rpcUrl), account: operator }),
    operator,
    challengerWallet: createWalletClient({ chain, transport: http(cfg.rpcUrl), account: challenger }),
    challenger,
  };
}

export async function provisionAgent(ctx: Ctx): Promise<bigint> {
  const { manifest, publicClient, operatorWallet, operator } = ctx;
  const bond = await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "registrationBond",
  });
  const regTx = await operatorWallet.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: ["ipfs://agent/qwen-treasury"],
    value: bond,
    account: operator,
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: regTx, timeout: 120_000 });
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === manifest.identityRegistry.toLowerCase() && l.topics.length === 3,
  );
  if (!log) throw new Error("registration emitted no Registered event");
  const agentId = BigInt(log.topics[1]!);

  // Stake above the floor.
  const minStake = await publicClient.readContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "minStake",
  });
  const needed = minStake + 50_000_000n;
  let tx: Hex = await operatorWallet.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [operator.address, needed],
    account: operator,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  tx = await operatorWallet.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [manifest.stakeRegistry, needed],
    account: operator,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  tx = await operatorWallet.writeContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "stake",
    args: [agentId, needed],
    account: operator,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });

  await postScore(ctx, agentId, 82);
  console.log(`[qwen-agent] provisioned treasury agent #${agentId}`);
  return agentId;
}

export async function postScore(ctx: Ctx, agentId: bigint, score: number): Promise<void> {
  const tx = await ctx.operatorWallet.writeContract({
    address: ctx.manifest.reputationRegistry,
    abi: REPUTATION_ABI,
    functionName: "postAvairaScore",
    args: [agentId, score],
    account: ctx.operator,
    chain: null,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
}

export async function readScore(ctx: Ctx, agentId: bigint): Promise<number> {
  return Number(
    await ctx.publicClient.readContract({
      address: ctx.manifest.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: "scoreOf",
      args: [agentId],
    }),
  );
}

export async function agentStatus(ctx: Ctx, agentId: bigint): Promise<number> {
  return Number(
    await ctx.publicClient.readContract({
      address: ctx.manifest.stakeRegistry,
      abi: STAKE_REGISTRY_ABI,
      functionName: "statusOf",
      args: [agentId],
    }),
  );
}

export const AGENT_STATUS_NAMES = ["NONE", "PENDING", "ACTIVE", "SUSPENDED", "BANNED"];

/* ─────────────────────── scenario (c): deviation challenge ─────────────────── */

export interface ChallengeOutcome {
  txHash: Hex;
  slashed: bigint;
  bounty: bigint;
  leaf: { action: string; spendUsd: bigint; nonce: bigint };
  proofDepth: number;
}

/** Sends the challenger 1 MON when it cannot afford gas. */
export async function ensureChallengerFunded(ctx: Ctx): Promise<void> {
  const balance = await ctx.publicClient.getBalance({ address: ctx.challenger.address });
  if (balance >= 10n ** 17n) return; // >= 0.1 MON
  const tx = await ctx.operatorWallet.sendTransaction({
    to: ctx.challenger.address,
    value: 10n ** 18n,
    account: ctx.operator,
    chain: null,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
}

/**
 * Challenges an attested outcome using a deviation leaf straight out of the
 * agent's own audit trail (leaf encoding is byte-identical to the contract's).
 * The challenger posts the challengerBond in USDC first.
 */
export async function challengeDeviation(
  ctx: Ctx,
  agentId: bigint,
  intentHash: Hex,
  trail: AuditTrail,
  envelope: { maxSpendUsd: bigint; allowedActions: string[] },
): Promise<ChallengeOutcome> {
  const { manifest, publicClient, challengerWallet, challenger } = ctx;

  await ensureChallengerFunded(ctx);

  const deviations = trail.deviations(envelope);
  if (deviations.length === 0) throw new Error("no deviation found in the audit trail");
  const entry = deviations[0]!;
  const index = trail.all().findIndex((e) => e.seq === entry.seq);

  const bond = await publicClient.readContract({
    address: manifest.intentVault,
    abi: INTENT_VAULT_ABI,
    functionName: "challengerBond",
  });

  const usdcBefore = await publicClient.readContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [challenger.address],
  });

  if (bond > 0n) {
    // Fund + approve the challenger bond.
    let tx: Hex = await challengerWallet.writeContract({
      address: manifest.settlementToken,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [challenger.address, bond],
      account: challenger,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    tx = await challengerWallet.writeContract({
      address: manifest.settlementToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [manifest.intentVault, bond],
      account: challenger,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  }

  const leaf = {
    agentId,
    intentHash,
    action: entry.action,
    spendUsd: entry.spendUsd,
    nonce: entry.nonce,
  };
  const proof = trail.proofFor(index);

  const txHash = await challengerWallet.writeContract({
    address: manifest.intentVault,
    abi: INTENT_VAULT_ABI,
    functionName: "challengeDeviation",
    args: [agentId, intentHash, leaf, proof],
    account: challenger,
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("challengeDeviation reverted");

  const usdcAfter = await publicClient.readContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [challenger.address],
  });

  // Decode DeviationUpheld(agentId, intentHash, challenger, bounty, slashed).
  let slashed = 0n;
  let bounty = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: INTENT_VAULT_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "DeviationUpheld") {
        bounty = (decoded.args as unknown as { bounty: bigint }).bounty;
        slashed = (decoded.args as unknown as { slashed: bigint }).slashed;
      }
    } catch {
      /* not our event */
    }
  }

  return {
    txHash,
    slashed,
    bounty,
    leaf: { action: entry.action, spendUsd: entry.spendUsd, nonce: entry.nonce },
    proofDepth: proof.length,
  };
}
