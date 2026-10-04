/**
 * Chain-mode bootstrap: makes sure there is an agent the protocol will vouch for.
 *
 * Registers + stakes + scores the agent and registers a Cleanverse CVI credential for its
 * wallet (required for `cva.*` intents by `AvairaIntentVault.checkGate`). Idempotent enough to
 * call on every demo run: it re-registers a fresh identity each time so a previous run's
 * expired credentials or slashed stake cannot mask a regression.
 */
import { ComplianceClient, signCVIClaim, type DeploymentManifest } from "@avaira/sdk";
import { keccak256, parseAbi, stringToHex, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface SetupOptions {
  manifest: DeploymentManifest;
  publicClient: PublicClient;
  admin: WalletClient;
  issuerKey: Hex;
  rpcUrl: string;
}

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256 agentId)",
  "function registrationBond() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nextAgentId() view returns (uint256)",
]);

const STAKE_ABI = parseAbi(["function stake(uint256 agentId, uint256 amount)", "function isEligible(uint256 agentId) view returns (bool)"]);

const REPUTATION_ABI = parseAbi(["function postAvairaScore(uint256 agentId, uint8 score)"]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

/**
 * Registers (or refreshes) a Cleanverse CVI credential for `wallet`.
 * Permissionless on-chain, so any operator can onboard a counterparty it does not control.
 */
export async function registerCVIFor(options: {
  wallet: Hex;
  manifest: DeploymentManifest;
  publicClient: PublicClient;
  account: Account;
  issuerKey: Hex;
  rpcUrl: string;
  label?: string;
}): Promise<Hex> {
  const { wallet, manifest, publicClient, account, issuerKey, rpcUrl } = options;
  const compliance = new ComplianceClient({
    rpcUrl,
    chainId: manifest.chainId,
    complianceGate: manifest.complianceGate!,
    cvaToken: manifest.cvaToken!,
    account,
  });
  const credentialHash = keccak256(
    stringToHex(JSON.stringify({ wallet, payload: options.label ?? "qwen-agent", ts: Date.now() })),
  );
  const nonce = await compliance.credentialNonce(wallet);
  const signature = await signCVIClaim({
    chainId: manifest.chainId,
    gate: manifest.complianceGate!,
    wallet,
    credentialHash,
    nonce,
    issuerPrivateKey: issuerKey,
  });
  const hash = await compliance.submitCredential(wallet, credentialHash, signature);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export interface ReadyAgent {
  agentId: bigint;
  wallet: Hex;
  credentialHash: Hex;
  score: number;
}

export async function ensureAgentReady(options: SetupOptions): Promise<ReadyAgent> {
  const { manifest, publicClient, admin, issuerKey, rpcUrl: RPC_URL } = options;
  const owner = admin.account!.address;
  const score = 78;

  const bond = (await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "registrationBond",
  })) as bigint;

  const registerHash = await admin.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [`ipfs://avaira/qwen/treasury-agent-${Date.now()}`],
    value: bond,
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: registerHash });
  const agentId = ((await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "nextAgentId",
  })) as bigint) - 1n;

  // Fund for staking: the test USDC is permissionless.
  const stakeAmount = BigInt(manifest.minStake ?? 100_000_000);
  const mintHash = await admin.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [owner, stakeAmount * 2n],
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  const approveHash = await admin.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [manifest.stakeRegistry, stakeAmount * 2n],
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const stakeHash = await admin.writeContract({
    address: manifest.stakeRegistry,
    abi: STAKE_ABI,
    functionName: "stake",
    args: [agentId, stakeAmount],
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: stakeHash });

  const scoreHash = await admin.writeContract({
    address: manifest.reputationRegistry,
    abi: REPUTATION_ABI,
    functionName: "postAvairaScore",
    args: [agentId, score],
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: scoreHash });

  // CVI: the treasury wallet must carry a valid Cleanverse credential before any cva.* intent.
  const cviHash = await registerCVIFor({
    wallet: owner,
    manifest,
    publicClient,
    account: admin.account!,
    issuerKey,
    rpcUrl: RPC_URL,
    label: "qwen-treasury",
  });

  // Working capital for the treasury leg.
  const cva = manifest.cvaToken!;
  const mintCvaHash = await admin.writeContract({
    address: cva,
    abi: parseAbi(["function mint(address to, uint256 amount)"]),
    functionName: "mint",
    args: [owner, 1_000_000n * 10n ** 18n],
    chain: null,
    account: admin.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintCvaHash });

  return { agentId, wallet: owner, credentialHash: cviHash, score };
}
