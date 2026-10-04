/**
 * Service configuration — everything sensitive comes from the environment.
 *
 * Required:
 *   GATE_ADDRESS           AvairaComplianceGate address (or AVAIRA_DEPLOYMENT manifest)
 *   ISSUER_PRIVATE_KEY     Cleanverse issuer key that signs CVI credentials
 *   CLEANVERSE_APP_ID      Cleanverse CCP api-id header value
 *   CLEANVERSE_API_KEY     Cleanverse CCP AES key (base64), never transmitted
 *
 * Optional:
 *   RPC_URL                Monad RPC (default https://testnet-rpc.monad.xyz)
 *   CHAIN_ID               default 10143
 *   CHAIN_NAME             Cleanverse chain identifier sent to CCP (default monad)
 *   CLEANVERSE_BASE_URL    CCP base URL (default https://uatapi.cleanverse.com/api/cooperate)
 *   CLEANVERSE_MOCK        "1" → offline mock CCP (local demos, CI)
 *   CREDENTIAL_TTL_SECONDS CVI credential lifetime (default 30 days)
 *   PORT                   HTTP port (default 8301)
 */
import { readFileSync, existsSync } from "node:fs";

export interface CviConfig {
  port: number;
  rpcUrl: string;
  chainId: number;
  chainName: string;
  gateAddress: `0x${string}`;
  issuerPrivateKey: `0x${string}`;
  credentialTtlSeconds: number;
  cleanverseAppId: string;
  cleanverseApiKey: string;
  cleanverseBaseUrl: string;
  cleanverseMock: boolean;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`[cvi-service] missing required env var ${name} (see services/cvi/.env.example)`);
  }
  return value;
}

/** Resolves the gate address: explicit env var first, then the deployment manifest. */
function resolveGateAddress(explicit?: string): `0x${string}` {
  if (explicit) return explicit as `0x${string}`;
  const manifestPath =
    process.env.AVAIRA_DEPLOYMENT ?? `${process.cwd()}/../../deployments/${process.env.CHAIN_ID ?? 10143}.json`;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { complianceGate?: string };
    if (manifest.complianceGate) return manifest.complianceGate as `0x${string}`;
  }
  throw new Error(`[cvi-service] set GATE_ADDRESS or point AVAIRA_DEPLOYMENT at a manifest with complianceGate`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CviConfig {
  return {
    port: Number(env.PORT ?? 8301),
    rpcUrl: env.RPC_URL ?? env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
    chainId: Number(env.CHAIN_ID ?? 10143),
    chainName: env.CHAIN_NAME ?? "monad",
    gateAddress: resolveGateAddress(env.GATE_ADDRESS),
    issuerPrivateKey: required("ISSUER_PRIVATE_KEY", env.ISSUER_PRIVATE_KEY ?? env.CVI_ISSUER_PRIVATE_KEY) as `0x${string}`,
    credentialTtlSeconds: Number(env.CREDENTIAL_TTL_SECONDS ?? 30 * 24 * 3600),
    cleanverseAppId: required("CLEANVERSE_APP_ID", env.CLEANVERSE_APP_ID),
    cleanverseApiKey: required("CLEANVERSE_API_KEY", env.CLEANVERSE_API_KEY),
    cleanverseBaseUrl: env.CLEANVERSE_BASE_URL ?? "https://uatapi.cleanverse.com/api/cooperate",
    cleanverseMock: env.CLEANVERSE_MOCK === "1" || env.CLEANVERSE_MOCK === "true",
  };
}
