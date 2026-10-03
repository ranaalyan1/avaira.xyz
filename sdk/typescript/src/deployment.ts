/**
 * Deployment manifests.
 *
 * `contracts/script/Deploy.s.sol` writes `deployments/{chainId}.json` after a broadcast.
 * The SDK, scorer, gateway and dashboard all read that one file, so an address is never
 * copied into a second place where it can silently go stale.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeploymentManifest {
  chainId: number;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry: `0x${string}`;
  stakeRegistry: `0x${string}`;
  intentVault: `0x${string}`;
  creditMarket: `0x${string}`;
  settlementToken: `0x${string}`;
  admin: `0x${string}`;
  treasury: `0x${string}`;
  /** ERC-8004 registry identifier: `eip155:{chainId}:{identityRegistry}`. */
  agentRegistry: string;
  registrationBond: string | number;
  minStake: string | number;
  minScore: string | number;
  challengeWindow: string | number;
  challengerBond: string | number;
  minGroundedPayment?: string | number;
  /** Lower bound for event scans — logs cannot exist before the deployment. */
  deploymentBlock?: string | number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate locations, in resolution order. */
function candidates(chainId: number, explicit?: string): string[] {
  const out: string[] = [];
  if (explicit) out.push(explicit);
  if (process.env.AVAIRA_DEPLOYMENT) out.push(process.env.AVAIRA_DEPLOYMENT);
  out.push(resolve(process.cwd(), `deployments/${chainId}.json`));
  out.push(resolve(process.cwd(), `../../deployments/${chainId}.json`));
  out.push(resolve(HERE, `../../../deployments/${chainId}.json`));
  out.push(resolve(HERE, `../../../../deployments/${chainId}.json`));
  return out;
}

export function loadDeployment(chainId = 10143, explicitPath?: string): DeploymentManifest {
  for (const path of candidates(chainId, explicitPath)) {
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as DeploymentManifest;
      if (manifest.chainId !== chainId) {
        throw new Error(`deployment manifest ${path} is for chain ${manifest.chainId}, not ${chainId}`);
      }
      return manifest;
    }
  }
  throw new Error(
    `no deployment manifest for chain ${chainId}. Run \`make deploy-monad\` first, or point $AVAIRA_DEPLOYMENT at deployments/${chainId}.json`,
  );
}

/** Default public RPC per chain, with `$AVAIRA_RPC_URL` taking precedence. */
export function defaultRpcUrl(chainId: number): string {
  if (process.env.AVAIRA_RPC_URL) return process.env.AVAIRA_RPC_URL;
  switch (chainId) {
    case 10143:
      return process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
    case 143:
      return process.env.MONAD_MAINNET_RPC ?? "https://rpc.monad.xyz";
    default:
      return "http://127.0.0.1:8545";
  }
}
