/**
 * CVI orchestration: CCP verification → EIP-712 issuer signature → on-chain credential.
 *
 * The service is a *courier*, not an authority: it cannot mint a credential the issuer has
 * not signed, and the gate recovers the issuer address on-chain before storing anything.
 * That is why `verifyCVI` itself is permissionless.
 */
import { ComplianceClient, CVIStatus, signCVIClaim, signCVIClaimWithExpiry } from "@avaira/sdk";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CleanverseCCPClient, credentialHashFor, type IdentityPayload } from "./cleanverse.js";
import { requireIssuerKey, type CVIConfig } from "./config.js";

export interface VerifyRequest {
  wallet: `0x${string}`;
  identityPayload: IdentityPayload;
  /** Optional issuer-chosen TTL (seconds). Omit for the gate's default validity. */
  expirySeconds?: number;
}

export interface VerifyOutcome {
  wallet: `0x${string}`;
  status: "verified" | "rejected" | "pending";
  credentialHash?: Hex;
  issuerSignature?: Hex;
  expiry?: number;
  txHash?: Hex;
  credentialStatus: CVIStatus;
  /** `live` when the decision came from the Cleanverse CCP, `mock` for the offline demo path. */
  mode: "live" | "mock";
  referenceId: string;
  ccp: unknown;
  error?: string;
}

export class CVIService {
  private readonly config: CVIConfig;
  private readonly ccp: CleanverseCCPClient;
  private readonly compliance: ComplianceClient;

  constructor(config: CVIConfig) {
    this.config = config;
    this.ccp = new CleanverseCCPClient({
      mode: config.mode,
      baseUrl: config.cleanverseBaseUrl,
      verifyPath: config.cleanverseVerifyPath,
      appId: config.cleanverseAppId,
      apiKey: config.cleanverseApiKey,
    });
    this.compliance = new ComplianceClient({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      complianceGate: config.complianceGate,
      cvaToken: config.cvaToken,
      privateKey: config.submitterPrivateKey,
    });
  }

  /** Current credential status for a wallet, straight from the chain. */
  async statusOf(wallet: `0x${string}`): Promise<CVIStatus> {
    return this.compliance.statusOf(wallet);
  }

  /** Full credential record (wallet, hash, expiry, status, issuer, verifiedAt). */
  async credentialOf(wallet: `0x${string}`) {
    const [, credentialHash, expiry, status, issuer, verifiedAt] = await this.compliance.credentialOf(wallet);
    return {
      wallet,
      credentialHash,
      expiry: Number(expiry),
      status: Number(status) as CVIStatus,
      issuer,
      verifiedAt: Number(verifiedAt),
    };
  }

  /**
   * Verifies `wallet` against the Cleanverse CCP and, on `verified`, registers a
   * wallet-bound CVI credential on-chain. The transaction hash is returned for the explorer.
   */
  async verify(request: VerifyRequest): Promise<VerifyOutcome> {
    const { wallet, identityPayload } = request;
    const ccp = await this.ccp.verifyIdentity({ wallet, identityPayload });

    if (ccp.status !== "verified") {
      return {
        wallet,
        status: ccp.status,
        credentialStatus: await this.compliance.statusOf(wallet),
        mode: ccp.mode,
        referenceId: ccp.referenceId,
        ccp: ccp.raw,
        error: `Cleanverse CCP returned ${ccp.status}: no credential was registered`,
      };
    }

    const credentialHash = credentialHashFor({
      appId: this.config.cleanverseAppId,
      wallet,
      result: ccp,
      identityPayload,
    });

    // Verify the issuer key on-chain is actually an authorised issuer before signing.
    const issuerKey = requireIssuerKey(this.config);
    const issuerAddress = privateKeyToAccount(issuerKey).address;
    const authorised = await this.isAuthorisedIssuer(issuerAddress);
    if (!authorised) {
      return {
        wallet,
        status: "verified",
        credentialHash,
        credentialStatus: await this.compliance.statusOf(wallet),
        mode: ccp.mode,
        referenceId: ccp.referenceId,
        ccp: ccp.raw,
        error: `issuer ${issuerAddress} is not authorised on ${this.config.complianceGate}; call setIssuer() first`,
      };
    }

    const nonce = await this.compliance.credentialNonce(wallet);
    const requestedValidity = request.expirySeconds ?? (process.env.CVI_ISSUER_EXPIRY === "1" ? this.config.credentialValiditySeconds : 0);
    const useIssuerExpiry = requestedValidity > 0;
    // Chain clock, not wall clock: local chains and testnets can diverge from the host.
    const latest = await this.compliance.publicClient.getBlock({ blockTag: "latest" });
    const expiry = latest.timestamp + BigInt(requestedValidity || this.config.credentialValiditySeconds);

    const issuerSignature = useIssuerExpiry
      ? await signCVIClaimWithExpiry({
          chainId: this.config.chainId,
          gate: this.config.complianceGate,
          wallet,
          credentialHash,
          nonce,
          expiry,
          issuerPrivateKey: issuerKey,
        })
      : await signCVIClaim({
          chainId: this.config.chainId,
          gate: this.config.complianceGate,
          wallet,
          credentialHash,
          nonce,
          issuerPrivateKey: issuerKey,
        });

    const txHash = useIssuerExpiry
      ? await this.submitWithExpiry(wallet, credentialHash, expiry, nonce, issuerSignature)
      : await this.compliance.submitCredential(wallet, credentialHash, issuerSignature);

    // Wait for inclusion: the API must never report a credential state it has not committed.
    await this.wait(txHash);
    const credential = await this.credentialOf(wallet);
    return {
      wallet,
      status: "verified",
      credentialHash,
      issuerSignature,
      expiry: Number(credential.expiry),
      txHash,
      credentialStatus: credential.status,
      mode: ccp.mode,
      referenceId: ccp.referenceId,
      ccp: ccp.raw,
    };
  }

  /** Revokes a credential (issuer/admin key required on-chain). */
  async revoke(wallet: `0x${string}`): Promise<Hex> {
    const account = privateKeyToAccount(requireIssuerKey(this.config));
    const walletClient = createWalletClient({ account, transport: http(this.config.rpcUrl) });
    const hash = await walletClient.writeContract({
      address: this.config.complianceGate,
      abi: [
        {
          type: "function",
          name: "revokeCVI",
          stateMutability: "nonpayable",
          inputs: [{ name: "wallet", type: "address" }],
          outputs: [],
        },
      ] as const,
      functionName: "revokeCVI",
      args: [wallet],
      account,
      chain: null,
    });
    await this.wait(hash);
    return hash;
  }

  /** Awaits a transaction receipt so callers only ever see committed state. */
  private async wait(hash: Hex): Promise<void> {
    await this.compliance.publicClient.waitForTransactionReceipt({ hash });
  }

  private async submitWithExpiry(
    wallet: `0x${string}`,
    credentialHash: Hex,
    expiry: bigint,
    nonce: bigint,
    signature: Hex,
  ): Promise<Hex> {
    const account = privateKeyToAccount(requireIssuerKey(this.config));
    const walletClient = createWalletClient({ account, transport: http(this.config.rpcUrl) });
    return walletClient.writeContract({
      address: this.config.complianceGate,
      abi: [
        {
          type: "function",
          name: "verifyCVIWithExpiry",
          stateMutability: "nonpayable",
          inputs: [
            { name: "wallet", type: "address" },
            { name: "issuerSignature", type: "bytes" },
            { name: "credentialHash", type: "bytes32" },
            { name: "expiry", type: "uint64" },
            { name: "nonce", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "verifyCVIWithExpiry",
      args: [wallet, signature, credentialHash, expiry, nonce],
      account,
      chain: null,
    });
  }

  private async isAuthorisedIssuer(issuer: `0x${string}`): Promise<boolean> {
    try {
      const client = this.compliance.publicClient as unknown as {
        readContract: (args: unknown) => Promise<unknown>;
      };
      const authorised = await client.readContract({
        address: this.config.complianceGate,
        abi: [
          {
            type: "function",
            name: "isIssuer",
            stateMutability: "view",
            inputs: [{ name: "issuer", type: "address" }],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as const,
        functionName: "isIssuer",
        args: [issuer],
      });
      return Boolean(authorised);
    } catch {
      // A broken RPC must not silently authorise; but the on-chain signature check would
      // reject an unauthorised issuer anyway, so surface the failure instead of hiding it.
      throw new Error("could not reach the compliance gate to check issuer authorisation");
    }
  }
}
