/**
 * CVI verification pipeline: CCP identity check -> issuer-signed credential ->
 * on-chain AvairaComplianceGate.verifyCVI. Split out from the HTTP layer so the
 * core logic is unit-testable without a server or a live chain.
 */
import type { CleanverseClient, CcpIdentityResult } from "./cleanverse.js";
import type { CviConfig } from "./config.js";
import { buildCredentialHash, cviSignaturePayload, type OnchainSubmitter } from "./onchain.js";
import type { Hex } from "viem";

export interface VerifyOutcome {
  wallet: `0x${string}`;
  verified: boolean;
  /** Present when the CCP confirmed the identity. */
  credentialHash?: Hex;
  expiry?: number;
  issuerSignature?: Hex;
  txHash?: Hex;
  /** Present when the CCP rejected the identity. */
  rejection?: { status?: string; customerId?: string };
  ccpStatus?: string;
}

export class CviPipeline {
  constructor(
    private readonly ccp: CleanverseClient,
    private readonly submitter: OnchainSubmitter,
    private readonly config: Pick<CviConfig, "chainName" | "credentialTtlSeconds">,
  ) {}

  /**
   * Verifies `wallet`'s identity against the Cleanverse CCP and, when verified,
   * submits the issuer-signed credential on-chain. Idempotent: re-running refreshes
   * the stored credential (same as the on-chain `verifyCVI` refresh semantics).
   */
  async verify(wallet: `0x${string}`): Promise<VerifyOutcome> {
    const ccpResult: CcpIdentityResult = await this.ccp.queryAPass(this.config.chainName, wallet);
    if (!ccpResult.verified) {
      return {
        wallet,
        verified: false,
        rejection: { status: ccpResult.status, customerId: ccpResult.customerId },
        ccpStatus: ccpResult.status,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const credentialHash = buildCredentialHash(wallet, ccpResult, now);
    const expiry = BigInt(now + this.config.credentialTtlSeconds);
    const payload = cviSignaturePayload(wallet, credentialHash, expiry);
    const issuerSignature = await this.submitter.signPayload(payload);
    const { txHash } = await this.submitter.submitVerifyCvi({
      wallet,
      credentialHash,
      expiry,
      signature: issuerSignature,
    });

    return {
      wallet,
      verified: true,
      credentialHash,
      expiry: Number(expiry),
      issuerSignature,
      txHash,
      ccpStatus: ccpResult.status,
    };
  }
}
