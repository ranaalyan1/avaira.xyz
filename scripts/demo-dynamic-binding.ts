#!/usr/bin/env tsx
/**
 * Avaira — Dynamic embedded-wallet binding + underwriter collateral demo (Workstream 2).
 *
 * The hosted Dynamic flow (email/passkey → embedded wallet) needs a Dynamic environment id
 * and network access to app.dynamic.xyz. Everything it produces on-chain is exercised here
 * with a local key standing in for the embedded wallet, so the EIP-712 digest, the owner
 * gate and the collateral path are verified against a real chain:
 *
 *   1. BINDING   an embedded-wallet stand-in signs the EIP-712 `AgentWalletSet` authorisation;
 *                the agent owner approves it as an operator and submits `setAgentWallet`;
 *                the registry must report the embedded wallet as the agent's wallet.
 *   2. DIGEST    viem's `hashTypedData` must equal `AvairaIdentityRegistry.hashAgentWalletSet`,
 *                i.e. the domain/type the frontend builds is byte-identical to the contract's.
 *   3. WALLET    the same signer must be usable through the Dynamic *viem adapter* seam
 *                (`signTypedData` + `writeContract`), which is what `resolveSigner` returns.
 *   4. COLLATERAL the underwriter approves settlement tokens and calls `depositCollateral`,
 *                exactly as `depositCollateralWithDynamic` does, then reads its position.
 *
 * Usage
 *   AVAIRA_RPC_URL=http://127.0.0.1:8546 npx tsx scripts/demo-dynamic-binding.ts --chain 10143
 *   DYNAMIC_ENV_ID=... npx tsx scripts/demo-dynamic-binding.ts --chain 10143   # records the env id it would use
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  parseAbi,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/* ──────────────────────────────── configuration ──────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = Number(flag("chain", has("local") ? "31337" : "10143"));
const ANVIL_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/** The real Dynamic environment id, when one is configured — recorded, never required. */
const DYNAMIC_ENV_ID = process.env.DYNAMIC_ENV_ID ?? process.env.REACT_APP_DYNAMIC_ENV_ID ?? "";

/** Same EIP-712 shape the frontend builds in `frontend/src/lib/dynamicConfig.js`. */
const IDENTITY_DOMAIN_NAME = "AvairaIdentityRegistry";
const IDENTITY_DOMAIN_VERSION = "1";
const AGENT_WALLET_SET_TYPE = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/* ─────────────────────────────────── plumbing ────────────────────────────────── */

const log = (...parts: unknown[]): void => console.log(...parts);
const jsonSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

interface Check {
  id: number;
  name: string;
  expected: string;
  observed: string;
  passed: boolean;
  txHashes: string[];
}

const checks: Check[] = [];

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 10143 ? "Monad Testnet" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.AVAIRA_RPC_URL ??
          process.env.MONAD_TESTNET_RPC ??
          (CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : "https://testnet-rpc.monad.xyz"),
      ],
    },
  },
  testnet: true,
});

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function agentWalletNonce(uint256 agentId) view returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function hashAgentWalletSet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function mint(address to, uint256 amount)",
]);

const MARKET_ABI = parseAbi([
  "function depositCollateral(uint256 agentId, uint256 amount)",
  "function collateral(uint256 agentId) view returns (uint256)",
  "function collateralRatioBps(uint256 agentId) view returns (uint256)",
]);

interface Manifest {
  chainId: number;
  identityRegistry: Hex;
  creditMarket: Hex;
  settlementToken: Hex;
  registrationBond: string | number;
  admin?: Hex;
}

function loadManifest(): Manifest {
  const explicit = process.env.AVAIRA_DEPLOYMENT ? resolve(process.env.AVAIRA_DEPLOYMENT) : undefined;
  const candidates = [
    explicit,
    resolve(process.cwd(), `deployments/${CHAIN_ID}.json`),
    resolve(process.cwd(), `deployments/${CHAIN_ID}.json`),
    resolve(HERE, `../deployments/${CHAIN_ID}.json`),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      if (manifest.chainId === CHAIN_ID) return manifest;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`no deployments/${CHAIN_ID}.json — run \`make deploy-monad\` first`);
}

/**
 * Minimal stand-in for `frontend/src/lib/dynamicWallet.js` `resolveSigner()`.
 * The production version reads these capabilities off a Dynamic wallet connector; the demo
 * takes the same shape from a local key so the on-chain result is identical.
 */
function signerFor(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ chain, transport: http(), account });
  return {
    address: account.address,
    kind: "viem-standin" as const,
    signTypedData: (typedData: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(typedData),
    writeContract: (request: {
      address: Hex;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
      value?: bigint;
    }) =>
      wallet.writeContract({
        address: request.address,
        abi: request.abi as never,
        functionName: request.functionName,
        args: (request.args ?? []) as never,
        value: request.value,
        chain,
        account,
      }),
  };
}

/* ──────────────────────────────────── main ───────────────────────────────────── */

async function main(): Promise<void> {
  const manifest = loadManifest();
  const publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;

  const deployerKey = (process.env.DEMO_DEPLOYER_PRIVATE_KEY ??
    (CHAIN_ID === 31337 ? ANVIL_DEPLOYER : undefined)) as Hex | undefined;
  if (!deployerKey) throw new Error("missing DEMO_DEPLOYER_PRIVATE_KEY (agent owner + CVA funder)");
  const owner = signerFor(deployerKey);

  // The embedded wallet: generated per run, exactly like Dynamic provisions one, then funded
  // with gas so it can submit its own transaction.
  const embeddedKey = generatePrivateKey();
  const embedded = signerFor(embeddedKey);

  log(`\n═══ Avaira × Dynamic — embedded wallet binding demo ═══`);
  log(`  chain              : ${CHAIN_ID}`);
  log(`  rpc                : ${chain.rpcUrls.default.http[0]}`);
  log(`  identity registry  : ${manifest.identityRegistry}`);
  log(`  dynamic env id     : ${DYNAMIC_ENV_ID ? `${DYNAMIC_ENV_ID.slice(0, 8)}…` : "(unset — local stand-in signer)"}`);
  log(`  embedded wallet    : ${embedded.address}  [${embedded.kind}]\n`);

  /* ── 0. register the agent that the binding will point at ───────────────────── */
  const bond = BigInt(manifest.registrationBond ?? 0);
  const registerHash = await owner.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: ["ipfs://avaira/dynamic-demo"],
    value: bond,
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: registerHash as Hex });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: registerHash as Hex });
  const agentId = await readAgentIdFromLogs(publicClient, receipt.logs, manifest.identityRegistry);
  log(`  agent #${agentId} registered · owner ${owner.address}`);

  await fundEmbedded(publicClient, embedded.address);

  /* ── 1. digest parity: frontend EIP-712 domain/types == contract ───────────── */
  const nonce = (await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "agentWalletNonce",
    args: [agentId],
  })) as bigint;
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const deadline = latest.timestamp + 3600n;

  const typedData = {
    domain: {
      name: IDENTITY_DOMAIN_NAME,
      version: IDENTITY_DOMAIN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: manifest.identityRegistry,
    },
    types: AGENT_WALLET_SET_TYPE,
    primaryType: "AgentWalletSet" as const,
    message: { agentId, newWallet: embedded.address, nonce, deadline },
  };

  const localDigest = hashTypedData(typedData);
  const chainDigest = (await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "hashAgentWalletSet",
    args: [agentId, embedded.address, nonce, deadline],
  })) as Hex;

  checks.push({
    id: 1,
    name: "EIP-712 digest parity",
    expected: "viem hashTypedData == hashAgentWalletSet",
    observed: `${localDigest} ${localDigest === chainDigest ? "==" : "!="} ${chainDigest}`,
    passed: localDigest === chainDigest,
    txHashes: [],
  });

  /* ── 2. owner approves the embedded wallet as operator (ERC-721 approval) ──── */
  const approveHash = await owner.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "setApprovalForAll",
    args: [embedded.address, true],
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: approveHash as Hex });
  log(`  owner approved ${embedded.address} as operator (setApprovalForAll)`);

  /* ── 3. the embedded wallet signs the binding and submits it itself ────────── */
  const signature = await embedded.signTypedData(typedData);
  const bindHash = await embedded.writeContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "setAgentWallet",
    args: [agentId, embedded.address, deadline, signature],
  } as never);
  const bindReceipt = await publicClient.waitForTransactionReceipt({ hash: bindHash as Hex });

  const bound = (await publicClient.readContract({
    address: manifest.identityRegistry,
    abi: IDENTITY_ABI,
    functionName: "getAgentWallet",
    args: [agentId],
  })) as Hex;

  checks.push({
    id: 2,
    name: "embedded wallet bound via EIP-712 signature",
    expected: `getAgentWallet(${agentId}) == embedded wallet`,
    observed: `${bound} ${bound.toLowerCase() === embedded.address.toLowerCase() ? "==" : "!="} ${embedded.address} · status ${
      bindReceipt.status
    }`,
    passed: bound.toLowerCase() === embedded.address.toLowerCase() && bindReceipt.status === "success",
    txHashes: [bindHash as string],
  });

  /* ── 4. underwriter collateral deposit from the same signer ────────────────── */
  const amount = parseUnits(flag("collateral", "250")!, 6);
  const tokenHash = await owner.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [embedded.address, amount],
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: tokenHash as Hex });

  const approveTokenHash = await embedded.writeContract({
    address: manifest.settlementToken,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [manifest.creditMarket, amount],
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: approveTokenHash as Hex });

  const depositHash = await embedded.writeContract({
    address: manifest.creditMarket,
    abi: MARKET_ABI,
    functionName: "depositCollateral",
    args: [agentId, amount],
  } as never);
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash as Hex });

  const posted = (await publicClient.readContract({
    address: manifest.creditMarket,
    abi: MARKET_ABI,
    functionName: "collateral",
    args: [agentId],
  })) as bigint;
  const ratio = (await publicClient.readContract({
    address: manifest.creditMarket,
    abi: MARKET_ABI,
    functionName: "collateralRatioBps",
    args: [agentId],
  })) as bigint;

  checks.push({
    id: 3,
    name: "underwriter collateral deposit",
    expected: `collateral(${agentId}) == ${amount}`,
    observed: `${posted} (${posted === amount ? "==" : "!="} ${amount}) · ratio ${ratio} bps · status ${depositReceipt.status}`,
    passed: posted === amount && depositReceipt.status === "success",
    txHashes: [depositHash as string],
  });

  /* ── results ──────────────────────────────────────────────────────────────── */
  log(`\n═══ Results ═══`);
  for (const check of checks) {
    log(`  ${check.passed ? "✓" : "✗"} #${check.id} ${check.name}`);
    log(`      expected: ${check.expected}`);
    log(`      observed: ${check.observed}`);
    for (const hash of check.txHashes) log(`      tx: ${explorer(manifest, hash)}`);
  }

  const transcriptDir = resolve(HERE, "..", "services", "dynamic", "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = resolve(transcriptDir, `dynamic-binding-demo-${CHAIN_ID}.json`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify(
      {
        chainId: CHAIN_ID,
        rpcUrl: chain.rpcUrls.default.http[0],
        dynamicEnvIdConfigured: Boolean(DYNAMIC_ENV_ID),
        mode: "local-standin-signer",
        agentId: agentId.toString(),
        owner: owner.address,
        embeddedWallet: embedded.address,
        eip712: typedData,
        digest: localDigest,
        checks,
        explorerBase: "https://testnet.monadscan.com",
      },
      jsonSafe,
      2,
    )}\n`,
  );
  log(`\n  transcript: ${transcriptPath}`);

  if (checks.every((check) => check.passed)) {
    log(`  ✓ all Dynamic binding checks passed\n`);
    return;
  }
  log(`  ✗ ${checks.filter((check) => !check.passed).length} check(s) failed\n`);
  process.exitCode = 1;
}

/* ─────────────────────────────────── helpers ─────────────────────────────────── */

function explorer(manifest: Manifest, hash: string): string {
  const base = CHAIN_ID === 10143 ? "https://testnet.monadscan.com" : `http://127.0.0.1:8546`;
  return `${base}/tx/${hash}`;
}

async function readAgentIdFromLogs(
  client: PublicClient,
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  registry: Hex,
): Promise<bigint> {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  for (const entry of logs) {
    if (entry.address.toLowerCase() === registry.toLowerCase() && entry.topics[0] === TRANSFER) {
      return BigInt(entry.topics[3] ?? "0x0");
    }
  }
  // Fall back to the registry's sequential ids (`nextAgentId` starts at 1 and is bumped on mint).
  const next = (await client.readContract({
    address: registry,
    abi: parseAbi(["function nextAgentId() view returns (uint256)"]),
    functionName: "nextAgentId",
  })) as bigint;
  return next - 1n;
}

async function fundEmbedded(client: PublicClient, address: Hex): Promise<void> {
  try {
    const rpc = chain.rpcUrls.default.http[0];
    await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, "0x21e19e0c9bab2400000"] }),
    });
  } catch {
    /* a non-anvil node keeps the balance it was funded with */
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ demo-dynamic-binding failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
