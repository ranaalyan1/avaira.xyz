/**
 * Verifies the Workstream-2 underwriter capital flow end to end on chain 10143:
 * an embedded wallet (local key standing in for the Dynamic embedded wallet)
 * approves USDC and calls AvairaCreditMarket.depositCollateral — the same
 * sequence `depositCollateral` in frontend/src/lib/web3.js executes.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const MANIFEST = process.env.AVAIRA_DEPLOYMENT ?? resolve(HERE, "../deployments/10143.local.json");
const EMBEDDED_PK = (process.env.EMBEDDED_WALLET_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const MARKET_ABI = parseAbi([
  "function depositCollateral(uint256 agentId, uint256 amount)",
  "function collateral(uint256 agentId) view returns (uint256)",
]);

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const chain = defineChain({
    id: CHAIN_ID,
    name: "verify",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const embedded = privateKeyToAccount(EMBEDDED_PK);
  const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: embedded });

  const usdc = manifest.settlementToken as `0x${string}`;
  const market = manifest.creditMarket as `0x${string}`;
  const agentId = BigInt(process.env.AGENT_ID ?? "1");
  const amount = 250_000_000n; // 250 USDC

  console.log(`embedded wallet : ${embedded.address}`);
  console.log(`credit market   : ${market}`);

  // 1. Mint test USDC (MockUSDC is permissionless on testnet).
  let tx = await wallet.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "mint", args: [embedded.address, amount], chain: null });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // 2. Approve the credit market.
  tx = await wallet.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "approve", args: [market, amount], chain: null });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // 3. Deposit collateral for the agent.
  const before = await publicClient.readContract({ address: market, abi: MARKET_ABI, functionName: "collateral", args: [agentId] });
  tx = await wallet.writeContract({ address: market, abi: MARKET_ABI, functionName: "depositCollateral", args: [agentId, amount], chain: null });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  const after = await publicClient.readContract({ address: market, abi: MARKET_ABI, functionName: "collateral", args: [agentId] });

  console.log(`deposit tx      : ${tx}`);
  console.log(`collateral      : ${before} -> ${after}`);
  if (after - before === amount) {
    console.log("\n✓ depositCollateral via embedded wallet verified on chain.");
  } else {
    console.error("\n✗ collateral delta mismatch");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-deposit-collateral failed:", err);
  process.exit(1);
});
