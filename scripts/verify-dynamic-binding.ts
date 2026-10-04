/**
 * Verifies the Workstream-2 EIP-712 agent-wallet binding flow end to end.
 *
 * The frontend (OperatorTools -> bindAgentWallet in src/lib/web3.js) does:
 *   1. read agentWalletNonce(agentId)
 *   2. sign the AgentWalletSet EIP-712 message with the NEW wallet (the Dynamic
 *      embedded wallet in production)
 *   3. submit setAgentWallet(agentId, newWallet, deadline, signature)
 *
 * This script runs that exact sequence against a live chain, using a local key as
 * the "embedded wallet" signer so it can run without a Dynamic environment.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseAbiItem,
  toEventSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const MANIFEST = process.env.AVAIRA_DEPLOYMENT ?? resolve(HERE, "../deployments/10143.local.json");
const OPERATOR_PK = (process.env.OPERATOR_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
// A distinct key plays the role of the Dynamic *embedded* wallet being bound.
const EMBEDDED_PK = (process.env.EMBEDDED_WALLET_PRIVATE_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 143 ? "Monad" : "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256)",
  "function registrationBond() view returns (uint256)",
  "function agentWalletNonce(uint256 agentId) view returns (uint256)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
]);

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const identity = manifest.identityRegistry as `0x${string}`;
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  const operator = privateKeyToAccount(OPERATOR_PK);
  const embedded = privateKeyToAccount(EMBEDDED_PK); // the "Dynamic embedded wallet"
  const operatorWallet = createWalletClient({ chain, transport: http(RPC_URL), account: operator });

  console.log(`rpc            : ${RPC_URL} (chain ${CHAIN_ID})`);
  console.log(`identity       : ${identity}`);
  console.log(`operator       : ${operator.address}`);
  console.log(`embedded wallet: ${embedded.address}  (signs the EIP-712 binding)`);

  // Register a fresh agent identity as the operator and read its id from the event.
  const bond = await publicClient.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "registrationBond" });
  const regTx = await operatorWallet.writeContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: ["ipfs://agent/dynamic-binding-verify"],
    value: bond,
    account: operator,
    chain: null,
  });
  const regReceipt = await publicClient.waitForTransactionReceipt({ hash: regTx });
  // Registered(uint256 indexed agentId, string agentURI, address indexed owner)
  const registeredSelector = toEventSelector(parseAbiItem("event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"));
  const registeredLog = regReceipt.logs.find(
    (l) => l.address.toLowerCase() === identity.toLowerCase() && l.topics[0] === registeredSelector,
  );
  if (!registeredLog) throw new Error("no Registered event emitted");
  const effectiveAgentId = BigInt(registeredLog.topics[1] ?? "0x1");
  console.log(`agent identity  : #${effectiveAgentId}`);

  // ── The exact frontend flow ────────────────────────────────────────────────
  const nonce = await publicClient.readContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "agentWalletNonce",
    args: [effectiveAgentId],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const typedData = {
    domain: { name: "AvairaIdentityRegistry", version: "1", chainId: CHAIN_ID, verifyingContract: identity },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet" as const,
    message: { agentId: effectiveAgentId, newWallet: embedded.address, nonce, deadline },
  };

  // The NEW wallet (embedded) signs the authorisation.
  const signature = await embedded.signTypedData(typedData);

  // The operator submits setAgentWallet.
  const txHash = await operatorWallet.writeContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "setAgentWallet",
    args: [effectiveAgentId, embedded.address, deadline, signature],
    account: operator,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  const bound = await publicClient.readContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "getAgentWallet",
    args: [effectiveAgentId],
  });

  console.log(`setAgentWallet tx : ${txHash}`);
  console.log(`bound wallet read : ${bound}`);
  if (bound.toLowerCase() === embedded.address.toLowerCase()) {
    console.log("\n✓ EIP-712 agent-wallet binding verified on chain (the Dynamic embedded-wallet flow).");
  } else {
    console.error("\n✗ binding mismatch");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-dynamic-binding failed:", err);
  process.exit(1);
});
