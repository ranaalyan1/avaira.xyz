/**
 * Avaira CVI service configuration.
 *
 * Everything is environment-driven; nothing is committed. Two modes:
 *
 *   live — `CLEANVERSE_APP_ID` + `CLEANVERSE_API_KEY` are present: the service calls the
 *          Cleanverse CCP API for a real identity decision.
 *   mock — `CLEANVERSE_MOCK=1` (or no credentials): deterministic local decisions so the
 *          demo, the Foundry E2E flow and CI keep working without third-party access.
 *          Mock decisions are labelled as such in every response (`mode: "mock"`), so a
 *          reviewer can never mistake them for a real CCP verdict.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadDeployment, type DeploymentManifest } from "@avaira/sdk";

export type CVIMode = "live" | "mock";

export interface CVIConfig {
  mode: CVIMode;
  port: number;
  chainId: number;
  rpcUrl: string;
  /** Deployed `AvairaComplianceGate`. */
  complianceGate: `0x${string}`;
  /** CVI-gated CVA token (optional; used by the status endpoint). */
  cvaToken?: `0x${string}`;
  /** Cleanverse CCP credentials — never logged, never committed. */
  cleanverseAppId?: string;
  cleanverseApiKey?: string;
  cleanverseBaseUrl: string;
  cleanverseVerifyPath: string;
  /** Issuer key that signs `CVIClaim` EIP-712 messages. */
  issuerPrivateKey?: `0x${string}`;
  /** Operator key used to submit the credential (defaults to the issuer key). */
  submitterPrivateKey?: `0x${string}`;
  /** Credential TTL requested from the CCP when the issuer supplies an expiry. */
  credentialValiditySeconds: number;
  deployment: DeploymentManifest;
}

function loadEnvFile(): void {
  // `contracts/.env` is the single source of truth for deployment + keys in this repo.
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../contracts/.env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
    return;
  }
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`missing required env var ${name} (see services/cvi/.env.example)`);
  return value;
}

export function loadConfig(): CVIConfig {
  loadEnvFile();

  const chainId = Number(process.env.CHAIN_ID ?? process.env.AVAIRA_CHAIN_ID ?? 10143);
  const deployment = loadDeployment(chainId, process.env.AVAIRA_DEPLOYMENT);

  const complianceGate = (process.env.CLEANVERSE_COMPLIANCE_GATE ?? deployment.complianceGate) as
    | `0x${string}`
    | undefined;
  if (!complianceGate) {
    throw new Error(
      `deployment manifest for chain ${chainId} has no complianceGate. Deploy with contracts/script/Deploy.s.sol (it writes one) or set CLEANVERSE_COMPLIANCE_GATE.`,
    );
  }

  const cleanverseAppId = process.env.CLEANVERSE_APP_ID;
  const cleanverseApiKey = process.env.CLEANVERSE_API_KEY;
  const explicitMock = process.env.CLEANVERSE_MOCK === "1" || process.env.CLEANVERSE_MOCK === "true";
  const mode: CVIMode = explicitMock || !cleanverseAppId || !cleanverseApiKey ? "mock" : "live";

  return {
    mode,
    port: Number(process.env.CVI_PORT ?? process.env.PORT ?? 8403),
    chainId,
    rpcUrl: process.env.AVAIRA_RPC_URL ?? process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
    complianceGate,
    cvaToken: (process.env.CLEANVERSE_CVA_TOKEN ?? deployment.cvaToken) as `0x${string}` | undefined,
    cleanverseAppId,
    cleanverseApiKey,
    cleanverseBaseUrl: process.env.CLEANVERSE_BASE_URL ?? "https://api.cleanverse.com",
    cleanverseVerifyPath: process.env.CLEANVERSE_VERIFY_PATH ?? "/v1/identity/verify",
    issuerPrivateKey: process.env.CLEANVERSE_ISSUER_PRIVATE_KEY as `0x${string}` | undefined,
    submitterPrivateKey: (process.env.CVI_SUBMITTER_PRIVATE_KEY ?? process.env.CLEANVERSE_ISSUER_PRIVATE_KEY) as
      | `0x${string}`
      | undefined,
    credentialValiditySeconds: Number(process.env.CVI_VALIDITY_SECONDS ?? 365 * 24 * 3600),
    deployment,
  };
}

export function requireIssuerKey(config: CVIConfig): `0x${string}` {
  if (!config.issuerPrivateKey) {
    throw new Error(
      "CLEANVERSE_ISSUER_PRIVATE_KEY is not set: the service cannot sign CVI credentials. Add it to contracts/.env (see .env.example).",
    );
  }
  return config.issuerPrivateKey;
}

export { required };
