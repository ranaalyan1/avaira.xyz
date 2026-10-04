/**
 * Avaira gate wiring: constructs the SDK client, provisions a gated agent
 * identity on first run, and exposes the score helpers used by the
 * intentional-block demo.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import {
  Avaira,
  loadDeployment,
  type DeploymentManifest,
} from "../../../sdk/typescript/src/index.js";
import type { BotConfig } from "./config.js";

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
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface GateContext {
  cfg: BotConfig;
  manifest: DeploymentManifest;
  avaira: Avaira;
  publicClient: PublicClient;
  operatorWallet: WalletClient;
  operatorAccount: LocalAccount;
  chain: ReturnType<typeof defineChain>;
}

export function buildGateContext(cfg: BotConfig): GateContext {
  const manifest = loadDeployment(cfg.chainId, cfg.manifestPath);
  const chain = defineChain({
    id: cfg.chainId,
    name: `avaira-${cfg.chainId}`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const operatorAccount = privateKeyToAccount(cfg.operatorKey);
  return {
    cfg,
    manifest,
    avaira: new Avaira({
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      contracts: manifest,
      privateKey: cfg.operatorKey,
    }),
    publicClient: createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient,
    operatorWallet: createWalletClient({ chain, transport: http(cfg.rpcUrl), account: operatorAccount }),
    operatorAccount,
    chain,
  };
}

/**
 * Registers + stakes + scores an agent so it can trade through the gate.
 * Idempotent: tops up stake and score only when below the floors.
 */
export async function provisionAgent(ctx: GateContext, agentUri = "ipfs://agent/perpl-bot"): Promise<bigint> {
  const { manifest, publicClient, operatorWallet, operatorAccount } = ctx;

  const bond = await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "registrationBond",
  });
  const regTx = await operatorWallet.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentUri],
    value: bond,
    account: operatorAccount,
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: regTx, timeout: 120_000 });
  const selector = receipt.logs.find(
    (l) => l.address.toLowerCase() === manifest.identityRegistry.toLowerCase() && l.topics.length === 3,
  );
  if (!selector) throw new Error("agent registration emitted no Registered event");
  const agentId = BigInt(selector.topics[1]!);

  await topUpStake(ctx, agentId);
  await postScore(ctx, agentId, 78);
  console.log(`[gate] provisioned agent #${agentId} (register ${regTx})`);
  return agentId;
}

export async function topUpStake(ctx: GateContext, agentId: bigint): Promise<void> {
  const { manifest, publicClient, operatorWallet, operatorAccount } = ctx;
  const minStake = await publicClient.readContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "minStake",
  });
  const current = await publicClient.readContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "stakeOf",
    args: [agentId],
  });
  if (current >= minStake) return;
  const needed = minStake - current + 50_000_000n;
  const me = operatorAccount.address;
  let tx: Hex = await operatorWallet.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [me, needed],
    account: operatorAccount,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  tx = await operatorWallet.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [manifest.stakeRegistry, needed],
    account: operatorAccount,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
  tx = await operatorWallet.writeContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "stake",
    args: [agentId, needed],
    account: operatorAccount,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
}

export async function postScore(ctx: GateContext, agentId: bigint, score: number): Promise<void> {
  const { manifest, operatorWallet, operatorAccount, publicClient } = ctx;
  const tx = await operatorWallet.writeContract({
    address: manifest.reputationRegistry,
    abi: REPUTATION_ABI,
    functionName: "postAvairaScore",
    args: [agentId, score],
    account: operatorAccount,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
}

export async function readScore(ctx: GateContext, agentId: bigint): Promise<number> {
  const score = await ctx.publicClient.readContract({
    address: ctx.manifest.reputationRegistry,
    abi: REPUTATION_ABI,
    functionName: "scoreOf",
    args: [agentId],
  });
  return Number(score);
}

/** Rough gas price probe; falls back to 1 gwei when the node does not answer. */
export async function probeGasPrice(ctx: GateContext): Promise<bigint> {
  try {
    const price = await ctx.publicClient.getGasPrice();
    return price > 0n ? price : 1_000_000_000n;
  } catch {
    return 1_000_000_000n;
  }
}
