#!/usr/bin/env tsx
/**
 * Avaira — Cleanverse CVI/CVA end-to-end demo (Workstream 1).
 *
 * Four scenarios, all against a real chain (local anvil by default, Monad Testnet 10143 with
 * `--chain 10143`):
 *
 *   1. VERIFIED → VERIFIED   Agent A (valid CVI) transfers CVA to Agent B (valid CVI)  → succeeds
 *   2. VERIFIED → NO CVI      Agent A transfers CVA to Agent C (no credential)          → CVI_MISSING
 *   3. EXPIRED CVI            A wallet whose credential lapsed attempts a transfer      → CVI_EXPIRED
 *   4. avaira.run()           `cva.transfer` inside the risk envelope, operator unverified
 *                             → gate blocks with CVI_UNVERIFIED, execute_fn never runs
 *
 * Scenario 4 also shows the recovery path: as soon as the CVI service registers the
 * operator's credential, the same run completes and anchors its Merkle root on-chain.
 *
 * Usage
 *   npm run demo:cvi-cva                  # local anvil (deployments/31337.json)
 *   npm run demo:cvi-cva -- --chain 10143 # Monad Testnet
 *   npm run demo:cvi-cva -- --via-service # register credentials through the HTTP service
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  Avaira,
  ComplianceClient,
  CVIStatus,
  COMPLIANCE_GATE_ABI,
  CVA_TOKEN_ABI,
  GateReason,
  GATE_REASON_TEXT,
  decodeCVIRejection,
  loadDeployment,
  signCVIClaim,
  type DeploymentManifest,
} from "@avaira/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/* ────────────────────────────────── configuration ────────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const CHAIN_ID = Number(flag("chain", has("local") ? "31337" : "10143"));
const VIA_SERVICE = has("via-service");
const JSON_OUT = has("json");
const SERVICE_URL = process.env.CVI_SERVICE_URL ?? "http://127.0.0.1:8403";

/** Anvil dev keys — only ever used when CHAIN_ID is a local chain. */
const ANVIL = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operatorB: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  operatorC: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  issuer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const env = (name: string): string | undefined => process.env[name] || undefined;

const DEPLOYER_KEY = (env("DEMO_DEPLOYER_PRIVATE_KEY") ??
  env("DEPLOYER_PRIVATE_KEY") ??
  (CHAIN_ID === 31337 ? ANVIL.deployer : undefined)) as Hex | undefined;
const OPERATOR_B_KEY = (env("DEMO_OPERATOR_B_PRIVATE_KEY") ??
  (CHAIN_ID === 31337 ? ANVIL.operatorB : undefined)) as Hex | undefined;
const OPERATOR_C_KEY = (env("DEMO_OPERATOR_C_PRIVATE_KEY") ??
  (CHAIN_ID === 31337 ? ANVIL.operatorC : undefined)) as Hex | undefined;
const ISSUER_KEY = (env("CLEANVERSE_ISSUER_PRIVATE_KEY") ??
  (CHAIN_ID === 31337 ? ANVIL.issuer : undefined)) as Hex | undefined;

/* ───────────────────────────────────── ABIs ──────────────────────────────────────── */

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256 agentId)",
  "function registrationBond() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const STAKE_ABI = parseAbi([
  "function stake(uint256 agentId, uint256 amount)",
  "function stakeOf(uint256 agentId) view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function isEligible(uint256 agentId) view returns (bool)",
  "function statusOf(uint256 agentId) view returns (uint8)",
]);

const REPUTATION_ABI = parseAbi([
  "function postAvairaScore(uint256 agentId, uint8 score)",
  "function scoreOf(uint256 agentId) view returns (uint8)",
  "function gradeOf(uint256 agentId) view returns (string)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (address)",
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
]);

/* ─────────────────────────────────── plumbing ────────────────────────────────────── */

interface ScenarioResult {
  id: number;
  name: string;
  expected: string;
  observed: string;
  passed: boolean;
  txHashes: string[];
  detail?: Record<string, unknown>;
}

const results: ScenarioResult[] = [];
const log = (...parts: unknown[]): void => {
  if (!JSON_OUT) console.log(...parts);
};

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name} — see the header of scripts/demo-cvi-cva.ts`);
  return value;
}

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 10143 ? "Monad Testnet" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [env("AVAIRA_RPC_URL") ?? env("MONAD_TESTNET_RPC") ?? (CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : "https://testnet-rpc.monad.xyz")],
    },
  },
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
  testnet: true,
});

function explorerUrl(hash: string): string {
  return CHAIN_ID === 31337 ? hash : `https://testnet.monadscan.com/tx/${hash}`;
}

function clientFor(key: Hex): WalletClient {
  return createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key) });
}

/** Typed helpers: viem's WalletClient.account is typed loosely through this generic chain. */
function addressOf(client: WalletClient): `0x${string}` {
  return (client.account as { address: `0x${string}` }).address;
}

async function main(): Promise<void> {
  requireEnv(DEPLOYER_KEY, "DEPLOYER_PRIVATE_KEY (or run with --local)");
  const manifest: DeploymentManifest = loadDeployment(CHAIN_ID, env("AVAIRA_DEPLOYMENT"));

  const complianceGate = requireEnv(manifest.complianceGate, "complianceGate in the deployment manifest") as `0x${string}`;
  const cvaToken = requireEnv(manifest.cvaToken, "cvaToken in the deployment manifest") as `0x${string}`;

  const deployer = privateKeyToAccount(DEPLOYER_KEY!);
  /** Fresh wallet per run: guaranteed to have no CVI credential (scenario 2). */
  const unverifiedRecipient = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
  const admin = clientFor(DEPLOYER_KEY!);
  const operatorA = clientFor(DEPLOYER_KEY!);
  const operatorB = clientFor(requireEnv(OPERATOR_B_KEY, "DEMO_OPERATOR_B_PRIVATE_KEY") as Hex);
  const operatorC = clientFor(requireEnv(OPERATOR_C_KEY, "DEMO_OPERATOR_C_PRIVATE_KEY") as Hex);

  const compliance = new ComplianceClient({
    rpcUrl: chain.rpcUrls.default.http[0],
    chainId: CHAIN_ID,
    complianceGate,
    cvaToken,
    privateKey: DEPLOYER_KEY,
  });

  log(`\n═══ Avaira × Cleanverse — CVI/CVA compliance demo ═══`);
  log(`  chain            : ${CHAIN_ID}`);
  log(`  rpc              : ${chain.rpcUrls.default.http[0]}`);
  log(`  compliance gate  : ${complianceGate}`);
  log(`  CVA token        : ${cvaToken}`);
  log(`  identity verified: ${VIA_SERVICE ? `via CVI service @ ${SERVICE_URL}` : "in-process issuer signing"}\n`);

  await topUpForLocalGas([deployer.address, addressOf(operatorB), addressOf(operatorC)]);

  // ── 0. fixtures: fund the wallets, mint CVA, register an ACTIVE agent for scenario 4 ──
  const settlement = manifest.settlementToken as `0x${string}`;
  await fundForStaking(settlement, admin, 5_000e6);
  await fundForStaking(settlement, operatorC, 5_000e6);
  await mintCVA(cvaToken, admin, deployer.address, 10_000_000000000000000000n); // 10,000 CVA (18 dec)
  // Scenario 4 needs an operator that is staked, scored … and *not* CVI-verified. Re-running
  // the demo would otherwise leave a healthy credential behind, so revoke it up front.
  await ensureOperatorUnverified(addressOf(operatorC));

  const agentA = await ensureAgent({ id: "A", owner: DEPLOYER_KEY!, stake: manifest.minStake, score: 78 });
  const agentC = await ensureAgent({ id: "C", owner: requireEnv(OPERATOR_C_KEY, "DEMO_OPERATOR_C_PRIVATE_KEY") as Hex, stake: manifest.minStake, score: 78 });

  /* ── Scenario 1: verified → verified ─────────────────────────────────────────────── */
  await registerCredential(deployer.address, { legalName: "Originating Agent A", country: "SG" });
  await registerCredential(addressOf(operatorB), { legalName: "Beneficiary Agent B", country: "DE" });

  const beforeB = await readBalance(cvaToken, addressOf(operatorB));
  /** Deadline/envelope times must be measured on the chain's clock, not the wall clock. */
  async function chainDeadline(secondsAhead: number): Promise<bigint> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp + BigInt(secondsAhead);
  }

  const s1 = await operatorA.writeContract({
    address: cvaToken,
    abi: CVA_TOKEN_ABI,
    functionName: "transfer",
    args: [addressOf(operatorB), 250_000000000000000000n],
    account: deployer,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: s1 });
  const afterB = await readBalance(cvaToken, addressOf(operatorB));
  record({
    id: 1,
    name: "VERIFIED → VERIFIED transfer",
    expected: "CVA transfer succeeds",
    observed: `success, B received ${formatCVA(afterB - beforeB)} CVA`,
    passed: afterB - beforeB === 250_000000000000000000n,
    txHashes: [s1],
  });

  /* ── Scenario 2: verified → no CVI ───────────────────────────────────────────────── */
  const unverified = unverifiedRecipient.address;
  const statusC = await compliance.statusOf(unverified);
  let s2Hash: string | undefined;
  let s2Observed: string;
  let s2Passed = false;
  try {
    await operatorA.writeContract({
      address: cvaToken,
      abi: CVA_TOKEN_ABI,
      functionName: "transfer",
      args: [unverified, 100_000000000000000000n],
      account: deployer,
      chain: null,
    });
    s2Observed = "transfer unexpectedly succeeded";
  } catch (error) {
    const decoded = decodeCVIRejection(extractRevertData(error));
    s2Observed = decoded?.reason ?? (error instanceof Error ? error.message : String(error));
    s2Passed = decoded?.reason === "CVI_MISSING" && decoded.wallet?.toLowerCase() === unverified.toLowerCase();
  }
  // Leave the denial on-chain: the revert itself cannot emit an event.
  s2Hash = await compliance.recordBlockedTransfer(deployer.address, unverified, 100_000000000000000000n, false);
  record({
    id: 2,
    name: "VERIFIED → NO CVI transfer",
    expected: "revert CVI_MISSING(unverified wallet)",
    observed: s2Observed,
    passed: s2Passed && statusC === CVIStatus.NONE,
    txHashes: s2Hash ? [s2Hash] : [],
    detail: { recipientStatus: CVIStatus[statusC] },
  });

  /* ── Scenario 3: expired credential ──────────────────────────────────────────────── */
  const expiringKey = (CHAIN_ID === 31337 ? ANVIL.operatorB : requireEnv(OPERATOR_B_KEY, "OPERATOR_B")) as Hex;
  // A distinct wallet so the demo does not have to expire a healthy credential.
  const expiringWallet = privateKeyToAccount(
    (CHAIN_ID === 31337
      ? "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
      : requireEnv(env("DEMO_EXPIRED_PRIVATE_KEY"), "DEMO_EXPIRED_PRIVATE_KEY")) as Hex,
  ).address;

  await topUpForLocalGas([expiringWallet]);
  // Long enough to fund the wallet, short enough to expire on cue. Override with
  // DEMO_EXPIRY_TTL_SECONDS when running against a public testnet where the wait is real.
  const shortValidity = Number(env("DEMO_EXPIRY_TTL_SECONDS") ?? 900);
  await registerCredential(expiringWallet, { legalName: "Lapsed Agent", country: "FR" }, {
    expirySeconds: shortValidity,
  });
  await mintCVA(cvaToken, admin, expiringWallet, 1_000_000000000000000000n);

  await advancePastExpiry(shortValidity + 30);
  const expiredStatus = await compliance.statusOf(expiringWallet);

  let s3Observed: string;
  let s3Passed = false;
  try {
    const wallet = clientFor(
      (CHAIN_ID === 31337
        ? "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
        : requireEnv(env("DEMO_EXPIRED_PRIVATE_KEY"), "DEMO_EXPIRED_PRIVATE_KEY")) as Hex,
    );
    await wallet.writeContract({
      address: cvaToken,
      abi: CVA_TOKEN_ABI,
      functionName: "transfer",
      args: [addressOf(operatorB), 5_000000000000000000n],
      account: wallet.account!,
      chain: null,
    });
    s3Observed = "transfer unexpectedly succeeded";
  } catch (error) {
    const decoded = decodeCVIRejection(extractRevertData(error));
    s3Observed = decoded?.reason ?? (error instanceof Error ? error.message : String(error));
    s3Passed = decoded?.reason === "CVI_EXPIRED";
  }
  const s3Hash = await compliance.recordBlockedTransfer(expiringWallet, addressOf(operatorB), 5_000000000000000000n, false);
  record({
    id: 3,
    name: "EXPIRED CVI transfer",
    expected: "revert CVI_EXPIRED",
    observed: s3Observed,
    passed: s3Passed && expiredStatus === CVIStatus.EXPIRED,
    txHashes: s3Hash ? [s3Hash] : [],
    detail: { credentialStatus: CVIStatus[expiredStatus] },
  });

  /* ── Scenario 4: avaira.run() with a cva.* intent ────────────────────────────────── */
  // Operator C is an ACTIVE agent (staked + scored) but has no CVI credential: the gate must
  // stop the run before execute_fn is reached.
  const avaira = new Avaira({
    rpcUrl: chain.rpcUrls.default.http[0],
    chainId: CHAIN_ID,
    contracts: manifest as never,
    privateKey: requireEnv(OPERATOR_C_KEY, "DEMO_OPERATOR_C_PRIVATE_KEY") as Hex,
  });

  let executeFnCalls = 0;
  const blockedRun = await avaira.run(
    agentC,
    { id: `cvi-demo-${Date.now()}`, description: "settle CVA to a counterparty" },
    async () => {
      executeFnCalls += 1;
      return "should never happen";
    },
    {
      envelope: {
        maxSpendUsd: 100_000_000n,
        allowedActions: ["cva.transfer", "cva.settle"],
        deadline: await chainDeadline(3600),
      },
      recordDecisions: true,
    },
  );

  const s4Passed =
    blockedRun.status === "blocked" &&
    blockedRun.reason === GateReason.CVI_UNVERIFIED &&
    executeFnCalls === 0 &&
    blockedRun.cviBlocker?.toLowerCase() === addressOf(operatorC).toLowerCase();

  const traceTx = await operatorC.writeContract({
    address: manifest.intentVault as `0x${string}`,
    abi: parseAbi([
      "function recordCVIRequirement(uint256 agentId, bytes32 intentHash)",
    ]),
    functionName: "recordCVIRequirement",
    args: [agentC, blockedRun.intentHash],
    account: operatorC.account!,
    chain: null,
  });

  const blockedInfo = blockedRun.status === "blocked" ? blockedRun : undefined;
  record({
    id: 4,
    name: "avaira.run() with cva.transfer, operator unverified",
    expected: "blocked with CVI_UNVERIFIED; execute_fn never invoked",
    observed: blockedInfo
      ? `${GATE_REASON_TEXT[blockedInfo.reason]} (execute_fn calls: ${executeFnCalls})`
      : `unexpectedly ${blockedRun.status}`,
    passed: s4Passed,
    txHashes: [blockedInfo?.commitTxHash, blockedInfo?.decisionTxHash, traceTx].filter(Boolean) as string[],
    detail: {
      intentHash: blockedRun.intentHash,
      cviBlocker: blockedInfo?.cviBlocker,
      gateLatencyMs: blockedRun.timings.gateLatencyMs,
    },
  });

  /* ── Recovery: verify the operator, then the same intent executes ────────────────── */
  await registerCredential(addressOf(operatorC), { legalName: "Agent C (onboarded)", country: "US" });
  await mintCVA(cvaToken, admin, addressOf(operatorC), 1_000_000000000000000000n);
  const recoveredRun = await avaira
    .run(
    agentC,
    { id: `cvi-demo-recovered-${Date.now()}`, description: "settle CVA after onboarding" },
    async ({ audit }) => {
      const hash = await operatorC.writeContract({
        address: cvaToken,
        abi: CVA_TOKEN_ABI,
        functionName: "transfer",
        args: [addressOf(operatorB), 1_000000000000000000n],
        account: operatorC.account!,
        chain: null,
      });
      audit.append("cva.transfer", 1_000_000n);
      return { txHash: hash };
    },
      {
        envelope: {
          maxSpendUsd: 100_000_000n,
          allowedActions: ["cva.transfer", "cva.settle"],
          deadline: await chainDeadline(3600),
        },
      },
    )
    .catch((error: unknown) => {
      log(`  ↳ recovery run threw: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return { status: "error" as const, merkleRoot: undefined, attestTxHash: undefined };
    });

  if (recoveredRun.status === "completed") {
    log(`\n  ↳ recovery: credential registered → run completed, Merkle root ${recoveredRun.merkleRoot}`);
  } else {
    const message = "message" in recoveredRun ? recoveredRun.message : `status=${recoveredRun.status}`;
    log(`\n  ↳ recovery failed: ${message}`);
  }

  /* ── Summary ─────────────────────────────────────────────────────────────────────── */
  const transcriptPath = resolve("services/cvi/transcripts", `cvi-cva-demo-${CHAIN_ID}.json`);
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const jsonSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
  writeFileSync(
    transcriptPath,
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        complianceGate,
        cvaToken,
        intentVault: manifest.intentVault,
        agentA,
        agentC,
        scenarios: results,
        recovery: {
          status: recoveredRun.status,
          merkleRoot: recoveredRun.status === "completed" ? recoveredRun.merkleRoot : undefined,
          attestTxHash: recoveredRun.status === "completed" ? recoveredRun.attestTxHash : undefined,
        },
        generatedAt: new Date().toISOString(),
      },
      jsonSafe,
      2,
    ),
  );

  if (JSON_OUT) {
    console.log(JSON.stringify({ scenarios: results, transcript: transcriptPath }, jsonSafe, 2));
  } else {
    log(`\n═══ Results ═══`);
    for (const result of results) {
      log(`  ${result.passed ? "✓" : "✗"} #${result.id} ${result.name}`);
      log(`      expected: ${result.expected}`);
      log(`      observed: ${result.observed}`);
      for (const hash of result.txHashes.slice(0, 2)) log(`      tx: ${explorerUrl(hash)}`);
    }
    log(`\n  transcript: ${transcriptPath}`);
    log(`  ${results.every((r) => r.passed) ? "✓ all CVI/CVA scenarios passed" : "✗ some scenarios failed"}\n`);
  }

  if (!results.every((r) => r.passed)) process.exitCode = 1;

  /* ───────────────────────────── scenario helpers ──────────────────────────────── */

  function record(result: ScenarioResult): void {
    results.push(result);
  }

  function extractRevertData(error: unknown): Hex | undefined {
    const candidate = error as { cause?: { data?: Hex; raw?: string }; data?: Hex };
    return candidate?.cause?.data ?? candidate?.data ?? (candidate?.cause?.raw as Hex | undefined);
  }

  async function topUpForLocalGas(addresses: string[]): Promise<void> {
    if (CHAIN_ID !== 31337) return;
    try {
      const test = createTestClient({ chain, mode: "anvil", transport: http() });
      for (const address of addresses) {
        await test.setBalance({ address: address as `0x${string}`, value: 100n * 10n ** 18n });
      }
    } catch {
      /* a non-anvil local node simply keeps its existing balances */
    }
  }

  async function advancePastExpiry(seconds: number): Promise<void> {
    // Any local anvil/hardhat node can be time-warped, whatever the chain id — including the
    // chain-10143 anvil mirror of Monad testnet used when the public RPC is unreachable.
    try {
      const test = createTestClient({ chain, mode: "anvil", transport: http() });
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
      log(`  … advanced ${seconds}s on the local node`);
      return;
    } catch {
      /* not a local node: a public testnet cannot be time-warped */
    }
    log(`  … waiting ${seconds}s for the credential to lapse on ${CHAIN_ID}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
  }

  /** Funds `client` with the settlement token (mock USDC is permissionless) and approves staking. */
  async function fundForStaking(token: `0x${string}`, client: WalletClient, amountUsdc: number): Promise<void> {
    const holder = addressOf(client);
    try {
      const mintHash = await admin.writeContract({
        address: token,
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        functionName: "mint",
        args: [holder, BigInt(amountUsdc)],
        account: deployer,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
    } catch {
      /* token without an open mint (e.g. real USDC): assume the operator is already funded */
    }
    const approveHash = await client.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [manifest.stakeRegistry as `0x${string}`, 2n ** 255n],
      account: client.account!,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  /**
   * Resets the scripted state for scenario 4: the operator must be unverified. Revocation is
   * the cleanest reset (and demonstrates the issuer's revoke path at the same time).
   */
  async function ensureOperatorUnverified(wallet: `0x${string}`): Promise<void> {
    const status = await compliance.statusOf(wallet);
    if (status === CVIStatus.VALID) {
      await serviceRevoke(wallet);
      if (!JSON_OUT) log(`  CVI ${wallet} revoked for the scripted block (was ${CVIStatus[status]})`);
    }
  }

  /** Revokes through the CVI service when available, otherwise with the issuer key directly. */
  async function serviceRevoke(wallet: `0x${string}`): Promise<void> {
    if (VIA_SERVICE) {
      const response = await fetch(`${SERVICE_URL}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      if (response.ok) return;
    }
    const hash = await admin.writeContract({
      address: complianceGate,
      abi: COMPLIANCE_GATE_ABI,
      functionName: "revokeCVI",
      args: [wallet],
      account: deployer,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function mintCVA(token: `0x${string}`, minter: WalletClient, to: `0x${string}`, amount: bigint): Promise<void> {
    const hash = await minter.writeContract({
      address: token,
      abi: CVA_TOKEN_ABI,
      functionName: "mint",
      args: [to, amount],
      account: minter.account!,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function readBalance(token: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return publicClient.readContract({
      address: token,
      abi: CVA_TOKEN_ABI,
      functionName: "balanceOf",
      args: [account],
    });
  }

  /** Registers + stakes + scores an agent if needed, returning its id. */
  async function ensureAgent(params: {
    id: string;
    owner: Hex;
    stake: string | number;
    score: number;
  }): Promise<bigint> {
    const owner = privateKeyToAccount(params.owner);
    const existing = await publicClient.readContract({
      address: manifest.identityRegistry as `0x${string}`,
      abi: IDENTITY_ABI,
      functionName: "registrationBond",
    });

    const wallet = clientFor(params.owner);
    const agentURI = `ipfs://avaira/demo/cvi-agent-${params.id}-${Date.now()}`;
    const { result, request } = await publicClient.simulateContract({
      address: manifest.identityRegistry as `0x${string}`,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [agentURI],
      value: existing,
      account: owner,
    });
    const agentId = result as bigint;
    const registerHash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: registerHash });

    const stakeHash = await wallet.writeContract({
      address: manifest.stakeRegistry as `0x${string}`,
      abi: STAKE_ABI,
      functionName: "stake",
      args: [agentId, BigInt(params.stake)],
      account: owner,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: stakeHash });

    const scoreHash = await admin.writeContract({
      address: manifest.reputationRegistry as `0x${string}`,
      abi: REPUTATION_ABI,
      functionName: "postAvairaScore",
      args: [agentId, params.score],
      account: deployer,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: scoreHash });

    if (!JSON_OUT) {
      const eligible = await publicClient.readContract({
        address: manifest.stakeRegistry as `0x${string}`,
        abi: STAKE_ABI,
        functionName: "isEligible",
        args: [agentId],
      });
      log(`  agent ${params.id} #${agentId} registered · staked · score ${params.score} · eligible=${eligible}`);
    }
    return agentId;
  }

  /** CVI registration: in-process issuer signing, or through the HTTP CVI service. */
  async function registerCredential(
    wallet: `0x${string}`,
    identityPayload: Record<string, unknown>,
    options: { expirySeconds?: number } = {},
  ): Promise<void> {
    if (VIA_SERVICE) {
      const response = await fetch(`${SERVICE_URL}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, identityPayload, expirySeconds: options.expirySeconds }),
      });
      const body = (await response.json()) as { credentialStatus?: number; error?: string };
      if (!response.ok || body.error) throw new Error(`CVI service error: ${body.error ?? response.status}`);
      if (body.credentialStatus !== CVIStatus.VALID) throw new Error(`credential not valid after service call: ${JSON.stringify(body)}`);
      if (!JSON_OUT) log(`  CVI ${wallet} registered via service (status ${CVIStatus[body.credentialStatus as CVIStatus]})`);
      return;
    }

    const issuerKey = requireEnv(ISSUER_KEY, "CLEANVERSE_ISSUER_PRIVATE_KEY") as Hex;
    const credentialHash: Hex = keccak256(
      stringToHex(JSON.stringify({ wallet, identityPayload, salt: "avaira:cvi:demo" })),
    );
    const nonce = await compliance.credentialNonce(wallet);

    if (options.expirySeconds) {
      const expiry = await chainDeadline(options.expirySeconds);
      const signature = await signCVIClaimWithExpiryLocal(issuerKey, wallet, credentialHash, expiry, nonce);
      const hash = await admin.writeContract({
        address: complianceGate,
        abi: COMPLIANCE_GATE_ABI,
        functionName: "verifyCVIWithExpiry",
        args: [wallet, signature, credentialHash, expiry, nonce],
        account: deployer,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      if (!JSON_OUT) log(`  CVI ${wallet} registered with expiry ${expiry} (${options.expirySeconds}s TTL)`);
      return;
    }

    const signature = await signCVIClaim({
      chainId: CHAIN_ID,
      gate: complianceGate,
      wallet,
      credentialHash,
      nonce,
      issuerPrivateKey: issuerKey,
    });
    const hash = await compliance.submitCredential(wallet, credentialHash, signature);
    await publicClient.waitForTransactionReceipt({ hash });
    if (!JSON_OUT) {
      const status = await compliance.statusOf(wallet);
      log(`  CVI ${wallet} registered in-process (status ${CVIStatus[status]})`);
    }
  }

  async function signCVIClaimWithExpiryLocal(
    issuerKey: Hex,
    wallet: `0x${string}`,
    credentialHash: Hex,
    expiry: bigint,
    nonce: bigint,
  ): Promise<Hex> {
    const { signCVIClaimWithExpiry } = await import("@avaira/sdk");
    return signCVIClaimWithExpiry({
      chainId: CHAIN_ID,
      gate: complianceGate,
      wallet,
      credentialHash,
      expiry,
      nonce,
      issuerPrivateKey: issuerKey,
    });
  }
}

function formatCVA(value: bigint): string {
  const whole = value / 10n ** 18n;
  return whole.toString();
}

main().catch((error) => {
  console.error(`\n✗ CVI/CVA demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
