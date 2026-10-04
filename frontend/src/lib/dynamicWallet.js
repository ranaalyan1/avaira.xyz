/**
 * Dynamic embedded-wallet adapters (Workstream 2).
 *
 * Dynamic exposes EVM wallets through different adapters depending on the connector:
 *   • viem  — `primaryWallet.connector.getWalletClient()` → signTypedData / writeContract
 *   • ethers — `primaryWallet.getSigner()`                → signer.signTypedData / Contract
 *
 * Both are supported here so a passkey-embedded wallet and a MetaMask connection behave
 * identically for the operator flows. Nothing in this file trusts the wallet: every value it
 * signs is re-verified on-chain by `AvairaIdentityRegistry` (EIP-712 + ERC-1271) or by
 * `AvairaCreditMarket`.
 */
import { createPublicClient, http, parseAbi } from "viem";

import {
  AGENT_WALLET_SET_TYPE,
  CHAIN_ID,
  CONTRACTS,
  IDENTITY_DOMAIN,
  RPC_URL,
} from "./dynamicConfig";

export const IDENTITY_ABI = parseAbi([
  "function agentWalletNonce(uint256 agentId) view returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function hashAgentWalletSet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

export const MARKET_ABI = parseAbi([
  "function depositCollateral(uint256 agentId, uint256 amount)",
  "function collateral(uint256 agentId) view returns (uint256)",
  "function debt(uint256 agentId) view returns (uint256)",
  "function collateralRatioBps(uint256 agentId) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const publicClient = createPublicClient({ transport: http(RPC_URL) });

function explorer(txHash) {
  if (!txHash) return null;
  return `${process.env.REACT_APP_EXPLORER_URL || "https://testnet.monadscan.com"}/tx/${txHash}`;
}

export { explorer };

/* ────────────────────────────── wallet adapters ────────────────────────────── */

/**
 * Resolves a signer for `primaryWallet` regardless of connector flavour.
 * Returns `{ address, kind, signTypedData, writeContract, sendTransaction }`.
 */
export async function resolveSigner(primaryWallet) {
  if (!primaryWallet) throw new Error("Connect a wallet first (Dynamic embedded wallet recommended)");

  const address = primaryWallet.address;

  // viem connector (Dynamic's preferred adapter)
  const viemConnector = primaryWallet.connector;
  if (viemConnector && typeof viemConnector.getWalletClient === "function") {
    try {
      const walletClient = await viemConnector.getWalletClient(CHAIN_ID);
      if (walletClient && typeof walletClient.signTypedData === "function") {
        return {
          address,
          kind: "viem",
          signTypedData: (args) => walletClient.signTypedData({ account: address, ...args }),
          writeContract: (request) => walletClient.writeContract({ account: address, chain: null, ...request }),
        };
      }
    } catch {
      /* fall through to the ethers adapter */
    }
  }

  // ethers adapter (also what the Dynamic <EthereumWalletConnectors/> ethers path returns)
  if (typeof primaryWallet.getSigner === "function") {
    const signer = await primaryWallet.getSigner();
    if (signer) {
      return {
        address,
        kind: "ethers",
        signTypedData: (args) => signer.signTypedData(args.domain, args.types, args.message),
        writeContract: async ({ address: to, abi, functionName, args, value }) => {
          const { Contract } = await import("ethers");
          const contract = new Contract(to, abi, signer);
          const tx = await contract[functionName](...(args || []), value ? { value } : {});
          return tx.hash ?? tx;
        },
      };
    }
  }

  // Newest SDK surface: the wallet itself can sign typed data.
  if (typeof primaryWallet.signTypedData === "function") {
    return {
      address,
      kind: "wallet",
      signTypedData: (args) => primaryWallet.signTypedData(args.domain, args.types, args.message),
      writeContract: async () => {
        throw new Error("This wallet adapter can sign but not send transactions");
      },
    };
  }

  throw new Error("Unsupported wallet adapter: neither viem, ethers nor signTypedData is available");
}

/* ─────────────────────── EIP-712 agent wallet binding ─────────────────────── */

/**
 * Signs the EIP-712 `AgentWalletSet` authorisation with the Dynamic embedded wallet and
 * submits `setAgentWallet` on-chain.
 *
 * The signature is produced by `newWallet` (the embedded wallet) and verified by the
 * registry with `SignatureChecker` (ecrecover for EOAs, ERC-1271 for smart wallets), so the
 * same flow works for passkey-backed embedded accounts.
 */
export async function bindAgentWalletWithDynamic({ primaryWallet, agentId, onStep = () => {} }) {
  if (!CONTRACTS.identityRegistry) throw new Error("REACT_APP_IDENTITY_REGISTRY is not set");

  const signer = await resolveSigner(primaryWallet);
  const newWallet = signer.address;

  // `setAgentWallet` is owner-gated on purpose: the agent owner must send the transaction,
  // while `newWallet` produces the EIP-712 signature. Check before asking for a signature so
  // the failure is actionable instead of an on-chain revert.
  onStep("checking agent ownership");
  const owner = await publicClient.readContract({
    address: CONTRACTS.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "ownerOf",
    args: [BigInt(agentId)],
  });
  if (owner.toLowerCase() !== newWallet.toLowerCase()) {
    const approved = await publicClient
      .readContract({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_ABI,
        functionName: "isApprovedForAll",
        args: [owner, newWallet],
      })
      .catch(() => false);
    if (!approved) {
      throw new Error(
        `Agent #${agentId} is owned by ${owner.slice(0, 6)}…${owner.slice(-4)}, not by this wallet. ` +
          "Either connect the owner wallet, or have the owner approve this wallet as an operator " +
          "(setApprovalForAll) before signing the binding.",
      );
    }
  }

  onStep("reading nonce");
  const nonce = await publicClient.readContract({
    address: CONTRACTS.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "agentWalletNonce",
    args: [BigInt(agentId)],
  });

  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const deadline = latest.timestamp + 3600n;

  const domain = {
    ...IDENTITY_DOMAIN,
    chainId: CHAIN_ID,
    verifyingContract: CONTRACTS.identityRegistry,
  };

  onStep("awaiting signature");
  const signature = await signer.signTypedData({
    domain,
    types: AGENT_WALLET_SET_TYPE,
    primaryType: "AgentWalletSet",
    message: {
      agentId: BigInt(agentId),
      newWallet,
      nonce,
      deadline,
    },
  });

  // Sanity check before spending gas: the registry must agree on the digest.
  const digest = await publicClient.readContract({
    address: CONTRACTS.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "hashAgentWalletSet",
    args: [BigInt(agentId), newWallet, nonce, deadline],
  });

  onStep("submitting setAgentWallet");
  const txHash = await signer.writeContract({
    address: CONTRACTS.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "setAgentWallet",
    args: [BigInt(agentId), newWallet, deadline, signature],
  });

  return { txHash, newWallet, nonce, deadline, digest, explorerUrl: explorer(txHash), adapter: signer.kind };
}

/* ────────────────────── underwriter collateral deposit ────────────────────── */

/**
 * Deposits collateral for `agentId` from the Dynamic embedded wallet:
 * `approve` the settlement token, then `depositCollateral` on the credit market.
 */
export async function depositCollateralWithDynamic({
  primaryWallet,
  agentId,
  amountUsdc,
  onStep = () => {},
}) {
  if (!CONTRACTS.creditMarket || !CONTRACTS.settlementToken) {
    throw new Error("REACT_APP_CREDIT_MARKET / REACT_APP_SETTLEMENT_TOKEN are not set");
  }

  const signer = await resolveSigner(primaryWallet);
  const amount = BigInt(amountUsdc);

  onStep("checking allowance");
  const allowance = await publicClient.readContract({
    address: CONTRACTS.settlementToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer.address, CONTRACTS.creditMarket],
  });

  if (allowance < amount) {
    onStep("approving settlement token");
    await signer.writeContract({
      address: CONTRACTS.settlementToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.creditMarket, amount],
    });
  }

  onStep("depositing collateral");
  const txHash = await signer.writeContract({
    address: CONTRACTS.creditMarket,
    abi: MARKET_ABI,
    functionName: "depositCollateral",
    args: [BigInt(agentId), amount],
  });

  return { txHash, explorerUrl: explorer(txHash), adapter: signer.kind };
}

/** Reads the collateral position so the underwriter sees the result without a reload. */
export async function readCollateralPosition(agentId) {
  if (!CONTRACTS.creditMarket) return null;
  const [collateral, debt, ratioBps] = await Promise.all([
    publicClient.readContract({
      address: CONTRACTS.creditMarket,
      abi: MARKET_ABI,
      functionName: "collateral",
      args: [BigInt(agentId)],
    }),
    publicClient
      .readContract({ address: CONTRACTS.creditMarket, abi: MARKET_ABI, functionName: "debt", args: [BigInt(agentId)] })
      .catch(() => 0n),
    publicClient
      .readContract({
        address: CONTRACTS.creditMarket,
        abi: MARKET_ABI,
        functionName: "collateralRatioBps",
        args: [BigInt(agentId)],
      })
      .catch(() => 0n),
  ]);
  return { collateral, debt, ratioBps: Number(ratioBps) };
}
