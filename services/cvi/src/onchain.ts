/**
 * On-chain half of the CVI pipeline: builds the credential commitment from the CCP
 * result, signs it with the Cleanverse issuer key exactly the way
 * AvairaComplianceGate.verifyCVI expects, and submits the transaction.
 *
 * Credential binding (all three fields are covered by the issuer signature):
 *   payload = keccak256(abi.encode(
 *     keccak256("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)"),
 *     wallet, credentialHash, expiry
 *   ))
 *   digest  = keccak256("\x19Ethereum Signed Message:\n32" ‖ payload)  // EIP-191
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  toHex,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { CcpIdentityResult } from "./cleanverse.js";
import type { CviConfig } from "./config.js";

export const COMPLIANCE_GATE_ABI = [
  "function verifyCVI(address wallet, bytes32 credentialHash, uint64 expiry, bytes issuerSignature)",
  "function revokeCVI(address wallet)",
  "function credentialOf(address wallet) view returns ((address wallet, bytes32 credentialHash, uint64 expiry, uint8 status, address issuer, uint64 verifiedAt))",
  "function statusOf(address wallet) view returns (uint8)",
  "function isWalletVerified(address wallet) view returns (bool)",
  "function checkCVATransfer(address from, address to) view returns (bool allowed, address failing, uint8 reason)",
  "function issuer() view returns (address)",
] as const;

const CVI_TYPEHASH = keccak256(toHex("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)"));

export interface OnchainSubmitter {
  issuerAddress: `0x${string}`;
  /** EIP-191 personal signature over the CVI payload (see cviSignaturePayload). */
  signPayload(payload: Hex): Promise<`0x${string}`>;
  submitVerifyCvi(args: {
    wallet: `0x${string}`;
    credentialHash: `0x${string}`;
    expiry: bigint;
    signature: `0x${string}`;
  }): Promise<{ txHash: `0x${string}` }>;
}

/** keccak256 commitment to the offchain CCP verification result — PII never lands onchain. */
export function buildCredentialHash(wallet: `0x${string}`, ccp: CcpIdentityResult, issuedAtSeconds: number): Hex {
  const recordHash = keccak256(toHex(JSON.stringify({ ccp: ccp.raw, customerId: ccp.customerId ?? null })));
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address wallet, bytes32 recordHash, uint256 issuedAt"), [
      wallet,
      recordHash,
      BigInt(issuedAtSeconds),
    ]),
  );
}

/** EIP-191 payload the issuer signs (matches AvairaComplianceGate.verifyCVI). */
export function cviSignaturePayload(wallet: `0x${string}`, credentialHash: `0x${string}`, expiry: bigint): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32 typehash, address wallet, bytes32 credentialHash, uint64 expiry"), [
      CVI_TYPEHASH,
      wallet,
      credentialHash,
      expiry,
    ]),
  );
}

export class ViemSubmitter implements OnchainSubmitter {
  readonly issuerAddress: `0x${string}`;
  private readonly wallet: WalletClient;
  readonly publicClient: PublicClient;
  private readonly account;

  constructor(private readonly config: CviConfig) {
    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === 143 ? "Monad" : "Monad Testnet",
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.account = privateKeyToAccount(config.issuerPrivateKey);
    this.issuerAddress = this.account.address;
    this.wallet = createWalletClient({ chain, transport: http(config.rpcUrl), account: this.account });
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  }

  async submitVerifyCvi(args: {
    wallet: `0x${string}`;
    credentialHash: `0x${string}`;
    expiry: bigint;
    signature: `0x${string}`;
  }): Promise<{ txHash: `0x${string}` }> {
    // The issuer submits its own attestation; gas is paid by the service's issuer wallet.
    const txHash = await this.wallet.writeContract({
      address: this.config.gateAddress,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "verifyCVI",
      args: [args.wallet, args.credentialHash, args.expiry, args.signature],
      account: this.account,
      chain: null,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return { txHash };
  }

  async signPayload(payload: Hex): Promise<`0x${string}`> {
    return this.account.signMessage({ message: { raw: payload } });
  }
}

export interface CviCredentialRecord {
  wallet: `0x${string}`;
  credentialHash: `0x${string}`;
  expiry: bigint;
  status: number;
  issuer: `0x${string}`;
  verifiedAt: bigint;
}

/** Reads CVI state back from the gate (used by the dashboard endpoints). */
export class GateReader {
  private readonly publicClient: PublicClient;
  private readonly gate: `0x${string}`;

  constructor(config: CviConfig, publicClient?: PublicClient) {
    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === 143 ? "Monad" : "Monad Testnet",
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.publicClient = publicClient ?? createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.gate = config.gateAddress;
  }

  async statusOf(wallet: `0x${string}`): Promise<{ status: number; credential: CviCredentialRecord }> {
    const [status, credential] = await Promise.all([
      this.publicClient.readContract({ address: this.gate, abi: COMPLIANCE_GATE_ABI, functionName: "statusOf", args: [wallet] }),
      this.publicClient.readContract({
        address: this.gate,
        abi: COMPLIANCE_GATE_ABI,
        functionName: "credentialOf",
        args: [wallet],
      }),
    ]);
    return { status: Number(status), credential: credential as unknown as CviCredentialRecord };
  }

  async checkTransfer(
    from: `0x${string}`,
    to: `0x${string}`,
  ): Promise<{ allowed: boolean; failing: `0x${string}`; reason: number }> {
    const result = (await this.publicClient.readContract({
      address: this.gate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "checkCVATransfer",
      args: [from, to],
    })) as unknown as [boolean, `0x${string}`, number];
    return { allowed: result[0], failing: result[1], reason: Number(result[2]) };
  }
}
