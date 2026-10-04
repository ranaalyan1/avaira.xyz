/**
 * On-chain actions for the Avaira v2 stack on Monad Testnet (chain id 10143),
 * driven by whatever signer the user connected — in particular a Dynamic
 * embedded wallet (Workstream 2: no MetaMask required).
 *
 * Contract addresses are read from the deployment manifest served out of
 * `frontend/public/deployments/` (deployments/10143.json first, then the local
 * demo manifest), so a redeploy never requires a frontend change.
 */
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
} from "viem";

export const MONAD_TESTNET = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.REACT_APP_MONAD_RPC || "https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
  testnet: true,
});

export const IDENTITY_REGISTRY_ABI = parseAbi([
  "function agentWalletNonce(uint256 agentId) view returns (uint256)",
  "function hashAgentWalletSet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function withdraw()",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function registrationBond() view returns (uint256)",
]);

export const CREDIT_MARKET_ABI = parseAbi([
  "function depositCollateral(uint256 agentId, uint256 amount)",
  "function collateral(uint256 agentId) view returns (uint256)",
  "function debt(uint256 agentId) view returns (uint256)",
  "function collateralRatioBps(uint256 agentId) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

let publicClient;
export function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: MONAD_TESTNET, transport: http(MONAD_TESTNET.rpcUrls.default.http[0]) });
  }
  return publicClient;
}

let manifestPromise;
/** Loads deployments/10143.json (or the local demo manifest) from the public dir. */
export async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      for (const path of ["/deployments/10143.json", "/deployments/10143.local.json"]) {
        try {
          const res = await fetch(path);
          if (res.ok) return await res.json();
        } catch { /* try next candidate */ }
      }
      throw new Error("No deployment manifest found under /deployments/ — run `make deploy-monad` or the local CVI demo first.");
    })();
  }
  return manifestPromise;
}

/**
 * Resolves an executable wallet client from a Dynamic wallet object.
 * Dynamic exposes `getWalletClient()` (viem WalletClient) on EVM wallets —
 * embedded wallets included, where signing is relayed to the embedded signer.
 */
export async function resolveWalletClient(wallet) {
  if (!wallet) throw new Error("No Dynamic wallet connected");
  const client = typeof wallet.getWalletClient === "function" ? await wallet.getWalletClient() : null;
  if (client && typeof client.signTypedData === "function") return client;
  throw new Error("Connected wallet does not expose a signing client");
}

/** EIP-712 domain + types for AvairaIdentityRegistry's AgentWalletSet binding. */
export function agentWalletSetTypedData(identityRegistry, chainId, message) {
  return {
    domain: {
      name: "AvairaIdentityRegistry",
      version: "1",
      chainId,
      verifyingContract: identityRegistry,
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message,
  };
}

/**
 * Binds `newWallet` as the execution wallet of `agentId`:
 *   1. reads the live EIP-712 nonce for the agent
 *   2. the NEW WALLET signs the AgentWalletSet message (Dynamic embedded wallet)
 *   3. the connected operator wallet submits `setAgentWallet`
 * Returns the transaction hash.
 */
export async function bindAgentWallet({ wallet, agentId, newWallet }) {
  const manifest = await loadManifest();
  const identityRegistry = manifest.identityRegistry;
  const client = await resolveWalletClient(wallet);
  const rpc = getPublicClient();
  const agentIdBig = BigInt(agentId);

  const [nonce] = await Promise.all([
    rpc.readContract({ address: identityRegistry, abi: IDENTITY_REGISTRY_ABI, functionName: "agentWalletNonce", args: [agentIdBig] }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const typedData = agentWalletSetTypedData(identityRegistry, MONAD_TESTNET.id, {
    agentId: agentIdBig,
    newWallet,
    nonce,
    deadline,
  });

  // The wallet being bound must authorise the binding with its own EIP-712 signature.
  // When the embedded wallet binds itself, the same Dynamic signer produces it.
  const signature = await client.signTypedData({ ...typedData, account: newWallet });

  const txHash = await client.writeContract({
    address: identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "setAgentWallet",
    args: [agentIdBig, newWallet, deadline, signature],
    account: wallet.address,
    chain: MONAD_TESTNET,
  });
  await rpc.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return txHash;
}

/** Reads the wallet currently bound to `agentId` (zero address when none). */
export async function getAgentWallet(agentId) {
  const manifest = await loadManifest();
  return getPublicClient().readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "getAgentWallet",
    args: [BigInt(agentId)],
  });
}

/**
 * Deposits `amountUsdc` (6-decimal string) of collateral for `agentId` on the
 * AvairaCreditMarket via the connected (embedded) wallet: approve then deposit.
 */
export async function depositCollateral({ wallet, agentId, amountUsdc }) {
  const manifest = await loadManifest();
  const creditMarket = manifest.creditMarket;
  const usdc = manifest.settlementToken;
  if (!creditMarket || !usdc) throw new Error("Manifest is missing creditMarket/settlementToken");

  const client = await resolveWalletClient(wallet);
  const rpc = getPublicClient();
  const amount = BigInt(Math.round(parseFloat(amountUsdc) * 1e6));
  if (amount <= 0n) throw new Error("Amount must be positive");

  const allowance = await rpc.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [wallet.address, creditMarket],
  });
  if (allowance < amount) {
    const approveTx = await client.writeContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [creditMarket, amount],
      account: wallet.address,
      chain: MONAD_TESTNET,
    });
    await rpc.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
  }

  const txHash = await client.writeContract({
    address: creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: "depositCollateral",
    args: [BigInt(agentId), amount],
    account: wallet.address,
    chain: MONAD_TESTNET,
  });
  await rpc.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return txHash;
}

/**
 * Claims any pending native-MON payouts (bond refunds / escrowed bounties)
 * accrued to the connected wallet on the identity registry.
 */
export async function claimPendingWithdrawals({ wallet }) {
  const manifest = await loadManifest();
  const client = await resolveWalletClient(wallet);
  const rpc = getPublicClient();
  const pending = await rpc.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "pendingWithdrawals",
    args: [wallet.address],
  });
  if (pending === 0n) return { txHash: null, claimed: "0" };
  const txHash = await client.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "withdraw",
    args: [],
    account: wallet.address,
    chain: MONAD_TESTNET,
  });
  await rpc.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return { txHash, claimed: (Number(pending) / 1e18).toString() };
}

/** Low-level fallback: encode + send a raw contract call via an EIP-1193 provider. */
export async function sendRawContractCall(provider, { to, data, from }) {
  return provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data }],
  });
}

export function encodeSetAgentWallet(agentId, newWallet, deadline, signature) {
  return encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "setAgentWallet",
    args: [BigInt(agentId), newWallet, deadline, signature],
  });
}
