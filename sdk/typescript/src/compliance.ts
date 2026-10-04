/**
 * Avaira v2 — Cleanverse CVI/CVA compliance helpers (Workstream 1).
 *
 * The on-chain rule is simple: a CVA balance cannot move unless BOTH counterparties hold a
 * valid, wallet-bound Cleanverse Verified Identity credential. Everything here exists so an
 * agent runtime or the Avaira CVI service can:
 *
 *   1. canonicalise an off-chain CCP identity verification into a `credentialHash`,
 *   2. sign the EIP-712 `CVIClaim` an authorised Cleanverse issuer must produce,
 *   3. submit/refresh it on-chain and read the resulting status,
 *   4. preview a gated transfer without spending gas.
 *
 * Nothing here trusts the caller: the gate recovers the issuer from the signature and
 * checks it against its own issuer allow-list, so a forged credential is unusable.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { COMPLIANCE_GATE_ABI, monadMainnet, monadTestnet, CVA_TOKEN_ABI } from "./abi.js";

/** Mirror of the on-chain `CVIStatus` enum. */
export enum CVIStatus {
  NONE = 0,
  VALID = 1,
  EXPIRED = 2,
  REVOKED = 3,
}

export const CVI_STATUS_TEXT: Record<CVIStatus, string> = {
  [CVIStatus.NONE]: "no credential: this wallet has never passed Cleanverse identity verification",
  [CVIStatus.VALID]: "valid: identity verified and wallet-bound",
  [CVIStatus.EXPIRED]: "expired: the credential must be refreshed by the issuer",
  [CVIStatus.REVOKED]: "revoked: the issuer withdrew this credential",
};

/** EIP-712 domain of `AvairaComplianceGate` (name + version are constants on-chain). */
export const CVI_EIP712_DOMAIN_NAME = "AvairaComplianceGate";
export const CVI_EIP712_DOMAIN_VERSION = "1";

/**
 * `CVIClaim(address wallet,bytes32 credentialHash,uint64 expiry,uint256 nonce)`.
 * The canonical 3-argument `verifyCVI` path instead signs the TTL-free short claim, whose
 * validity window is gate policy — that keeps the signature valid regardless of which block
 * lands it.
 */
export const CVI_CLAIM_TYPE = {
  CVIClaimShort: [
    { name: "wallet", type: "address" },
    { name: "credentialHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
  CVIClaim: [
    { name: "wallet", type: "address" },
    { name: "credentialHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface CVIClaimInput {
  chainId: number;
  /** Deployed `AvairaComplianceGate`. */
  gate: `0x${string}`;
  wallet: `0x${string}`;
  credentialHash: Hex;
  nonce: bigint;
}

export interface CVIClaimWithExpiryInput extends CVIClaimInput {
  expiry: bigint;
}

/** Canonical credential hash of an off-chain CCP verification result. */
export function hashIdentityPayload(payload: unknown, salt = "cleanverse:ccp:v1"): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string salt, string payload"), [
      salt,
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ]),
  );
}

function cviDomain(input: { chainId: number; gate: `0x${string}` }) {
  return {
    name: CVI_EIP712_DOMAIN_NAME,
    version: CVI_EIP712_DOMAIN_VERSION,
    chainId: input.chainId,
    verifyingContract: input.gate,
  } as const;
}

/** Typed-data payload for the canonical (TTL-free) claim the gate's `verifyCVI` expects. */
export function buildCVIClaimTypedData(input: CVIClaimInput) {
  return {
    domain: cviDomain(input),
    types: { CVIClaimShort: CVI_CLAIM_TYPE.CVIClaimShort },
    primaryType: "CVIClaimShort" as const,
    message: {
      wallet: input.wallet,
      credentialHash: input.credentialHash,
      nonce: input.nonce,
    },
  };
}

/** Typed-data payload for the issuer-expiry claim (`verifyCVIWithExpiry`). */
export function buildCVIClaimWithExpiryTypedData(input: CVIClaimWithExpiryInput) {
  return {
    domain: cviDomain(input),
    types: { CVIClaim: CVI_CLAIM_TYPE.CVIClaim },
    primaryType: "CVIClaim" as const,
    message: {
      wallet: input.wallet,
      credentialHash: input.credentialHash,
      expiry: input.expiry,
      nonce: input.nonce,
    },
  };
}

/**
 * Signs a CVI claim with the issuer key. Only run this inside the Avaira CVI service (or a
 * demo with a throwaway key) — the issuer key is what authorises a wallet-bound credential.
 */
export async function signCVIClaim(
  input: CVIClaimInput & { issuerPrivateKey: Hex },
): Promise<Hex> {
  const account = privateKeyToAccount(input.issuerPrivateKey);
  const client = createWalletClient({
    chain: input.chainId === 143 ? monadMainnet : monadTestnet,
    transport: http(),
    account,
  });
  return client.signTypedData({
    account,
    ...buildCVIClaimTypedData(input),
  } as never);
}

/** Signs an issuer-expiry CVI claim (CCP KYC validity carried on-chain). */
export async function signCVIClaimWithExpiry(
  input: CVIClaimWithExpiryInput & { issuerPrivateKey: Hex },
): Promise<Hex> {
  const account = privateKeyToAccount(input.issuerPrivateKey);
  const client = createWalletClient({
    chain: input.chainId === 143 ? monadMainnet : monadTestnet,
    transport: http(),
    account,
  });
  return client.signTypedData({
    account,
    ...buildCVIClaimWithExpiryTypedData(input),
  } as never);
}

/* ─────────────────────────── on-chain convenience wrappers ─────────────────────────── */

export interface ComplianceClientConfig {
  rpcUrl: string;
  chainId: number;
  complianceGate: `0x${string}`;
  cvaToken?: `0x${string}`;
  privateKey?: Hex;
  account?: Account;
}

export class ComplianceClient {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly config: ComplianceClientConfig;

  constructor(config: ComplianceClientConfig) {
    this.config = config;
    const chain = config.chainId === 143 ? monadMainnet : monadTestnet;
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient;
    const account = config.account ?? (config.privateKey ? privateKeyToAccount(config.privateKey) : undefined);
    if (account) this.walletClient = createWalletClient({ chain, transport: http(config.rpcUrl), account });
  }

  /** Effective status, accounting for expiry at the current block. */
  async statusOf(wallet: `0x${string}`): Promise<CVIStatus> {
    const status = await this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "credentialStatusOf",
      args: [wallet],
    });
    return Number(status) as CVIStatus;
  }

  async isValid(wallet: `0x${string}`): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "isCVIValid",
      args: [wallet],
    });
  }

  async credentialNonce(wallet: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "credentialNonce",
      args: [wallet],
    });
  }

  async credentialOf(wallet: `0x${string}`) {
    return this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "credentialOf",
      args: [wallet],
    });
  }

  /** The EIP-712 digest the issuer must sign (canonical TTL-free claim). */
  async hashCVIClaim(wallet: `0x${string}`, credentialHash: Hex, nonce?: bigint): Promise<Hex> {
    const resolvedNonce = nonce ?? (await this.credentialNonce(wallet));
    return this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "hashCVIClaim",
      args: [wallet, credentialHash, resolvedNonce],
    });
  }

  /** Non-reverting preview used by the dashboard and the trading bot before moving CVA. */
  async previewTransfer(from: `0x${string}`, to: `0x${string}`, amount: bigint) {
    const [allowed, fromStatus, toStatus, blockingWallet] = await this.publicClient.readContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "previewGateCVATransfer",
      args: [from, to, amount],
    });
    return {
      allowed,
      fromStatus: Number(fromStatus) as CVIStatus,
      toStatus: Number(toStatus) as CVIStatus,
      blockingWallet: blockingWallet as `0x${string}`,
    };
  }

  /** Submits a credential the issuer already signed. Permissionless by design. */
  async submitCredential(wallet: `0x${string}`, credentialHash: Hex, issuerSignature: Hex): Promise<Hex> {
    const walletClient = this.requireWallet();
    return walletClient.writeContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "verifyCVI",
      args: [wallet, issuerSignature, credentialHash],
      account: this.walletClient!.account!,
      chain: null,
    });
  }

  /**
   * Revokes a wallet's credential (issuer/admin call). The gate then refuses that wallet with
   * `CVI_REVOKED`, including for `cva.*` intents evaluated by the intent vault.
   */
  async revokeCredential(wallet: `0x${string}`): Promise<Hex> {
    const walletClient = this.requireWallet();
    return walletClient.writeContract({
      address: this.config.complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "revokeCVI",
      args: [wallet],
      account: this.walletClient!.account!,
      chain: null,
    });
  }

  /** Records a blocked transfer so the denial is visible on the explorer. */
  async recordBlockedTransfer(
    from: `0x${string}`,
    to: `0x${string}`,
    amount: bigint,
    allowed = false,
  ): Promise<Hex | undefined> {
    if (!this.walletClient) return undefined;
    try {
      return await this.walletClient.writeContract({
        address: this.config.complianceGate,
        abi: COMPLIANCE_GATE_ABI,
        functionName: "recordGatedTransfer",
        args: [from, to, amount, allowed],
        account: this.walletClient.account!,
        chain: null,
      });
    } catch {
      return undefined;
    }
  }

  /** CVA balance of `wallet` (0 when no token is configured). */
  async cvaBalanceOf(wallet: `0x${string}`): Promise<bigint> {
    if (!this.config.cvaToken) return 0n;
    return this.publicClient.readContract({
      address: this.config.cvaToken,
      abi: CVA_TOKEN_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient) throw new Error("ComplianceClient: no signer configured");
    return this.walletClient;
  }
}

/**
 * Parses the gate's revert data into the reason an integrator cares about.
 * Custom errors are the *point* here — the token reverts with its own reason, so an
 * unverified transfer is legible without any off-chain bookkeeping.
 */
export function decodeCVIRejection(data?: Hex): { reason: string; wallet?: `0x${string}` } | undefined {
  if (!data || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  const arg = data.length >= 74 ? (`0x${data.slice(34, 74)}` as `0x${string}`) : undefined;
  switch (selector) {
    // Selectors computed from the Solidity custom errors (cast sig).
    case "0x9e2b6191": // CVI_MISSING(address)
      return { reason: "CVI_MISSING", wallet: arg };
    case "0xd47fd532": // CVI_EXPIRED(address,uint64)
      return { reason: "CVI_EXPIRED", wallet: arg };
    case "0xe2722f45": // CVI_REVOKED(address)
      return { reason: "CVI_REVOKED", wallet: arg };
    case "0x2cf34f73": // CVI_UNKNOWN_ISSUER(address)
      return { reason: "CVI_UNKNOWN_ISSUER", wallet: arg };
    case "0x44ee0f0d": // CVI_INVALID_EXPIRY(uint64)
      return { reason: "CVI_INVALID_EXPIRY", wallet: arg };
    case "0x6651dac1": // CVI_NONCE_MISMATCH(uint256,uint256)
      return { reason: "CVI_NONCE_MISMATCH" };
    default:
      return undefined;
  }
}
