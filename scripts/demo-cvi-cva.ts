/**
 * CVI/CVA compliance demo — Travel-Rule gating end to end on Monad (chain id 10143).
 *
 * Scenarios (in order):
 *   1. Agent A (valid CVI) transfers CVA to Agent B (valid CVI) → gateCVATransfer succeeds.
 *   2. Agent A transfers CVA to Agent C (no CVI)              → reverts CVI_MISSING.
 *   3. Agent with an expired CVI attempts a transfer          → reverts CVI_EXPIRED.
 *   4. Agent A runs avaira.run() with cva.transfer allowed while its CVI is revoked
 *      → checkGate blocks with CVI_UNVERIFIED; execute_fn never runs.
 *
 * Env (all optional — sane defaults for a local anvil deploy):
 *   AVAIRA_RPC_URL        RPC endpoint (default https://testnet-rpc.monad.xyz)
 *   AVAIRA_DEPLOYMENT     manifest path (default deployments/10143.json)
 *   OPERATOR_PRIVATE_KEY  protocol admin/issuer key (funds demo actors on local chains)
 *   CVI_ISSUER_PRIVATE_KEY issuer key (defaults to OPERATOR_PRIVATE_KEY)
 *   AGENT_A_PRIVATE_KEY / AGENT_B_PRIVATE_KEY / AGENT_C_PRIVATE_KEY
 *   AGENT_ID              existing agent id for scenario 4 (else one is registered)
 *   EXPIRY_TTL_SECONDS    short credential TTL for the expiry scenario (default 8)
 *   SKIP_SETUP=1          skip actor funding/agent provisioning (testnet re-runs)
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  parseAbi,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { Avaira, GateReason, loadDeployment, defaultRpcUrl } from "../sdk/typescript/src/index.js";

/* ────────────────────────────── configuration ─────────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE_FILE = resolve(HERE, ".demo-state.json");

const RPC_URL = process.env.AVAIRA_RPC_URL ?? defaultRpcUrl(10143);
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const EXPIRY_TTL = Number(process.env.EXPIRY_TTL_SECONDS ?? 8);

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 143 ? "Monad" : "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

function walletFor(key: Hex) {
  const account = privateKeyToAccount(key);
  return {
    account,
    wallet: createWalletClient({ chain, transport: http(RPC_URL), account }),
  };
}

const log = (...args: unknown[]) => console.log(...args);
const banner = (title: string) => log(`\n── ${title} ${"─".repeat(Math.max(0, 64 - title.length))}`);

interface DemoState {
  agentAPrivateKey?: Hex;
  agentBPrivateKey?: Hex;
  agentCPrivateKey?: Hex;
  agentId?: number;
}

function loadState(): DemoState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState;
    } catch {
      /* corrupted state — start fresh */
    }
  }
  return {};
}

function saveState(state: DemoState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ─────────────────────── minimal ABIs used by the demo ─────────────────────── */

const COMPLIANCE_ABI = parseAbi([
  "function verifyCVI(address wallet, bytes32 credentialHash, uint64 expiry, bytes issuerSignature)",
  "function revokeCVI(address wallet)",
  "function gateCVATransfer(address from, address to, uint256 amount)",
  "function statusOf(address wallet) view returns (uint8)",
  "function issuer() view returns (address)",
  "event CVIVerified(address indexed wallet, bytes32 credentialHash, uint256 expiry)",
  "event CVATransferGated(address indexed from, address indexed to, uint256 amount, bool allowed)",
  "error CVI_MISSING(address wallet)",
  "error CVI_EXPIRED(address wallet, uint64 expiredAt)",
  "error CVI_REVOKED(address wallet)",
]);

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) payable returns (uint256)",
  "function registrationBond() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const STAKE_ABI = parseAbi([
  "function stake(uint256 agentId, uint256 amount)",
  "function stakeOf(uint256 agentId) view returns (uint256)",
  "function minStake() view returns (uint256)",
]);

const REPUTATION_ABI = parseAbi([
  "function postAvairaScore(uint256 agentId, uint8 score)",
  "function scoreOf(uint256 agentId) view returns (uint8)",
]);

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

/* ─────────────────────────── CVI credential helpers ────────────────────────── */

const CVI_TYPEHASH = keccak256(toHex("CVICredential(address wallet,bytes32 credentialHash,uint64 expiry)"));

function buildCredentialHash(wallet: Hex, issuedAt: number): Hex {
  const recordHash = keccak256(toHex(JSON.stringify({ ccp: { source: "demo", tier: 2 }, verifiedAt: issuedAt })));
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address wallet, bytes32 recordHash, uint256 issuedAt"), [
      wallet,
      recordHash,
      BigInt(issuedAt),
    ]),
  );
}

function cviPayload(wallet: Hex, credentialHash: Hex, expiry: bigint): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32 typehash, address wallet, bytes32 credentialHash, uint64 expiry"), [
      CVI_TYPEHASH,
      wallet,
      credentialHash,
      expiry,
    ]),
  );
}

async function verifyCviOnchain(
  issuerAccount: ReturnType<typeof privateKeyToAccount>,
  sender: ReturnType<typeof walletFor>["wallet"],
  gate: Hex,
  wallet: Hex,
  ttlSeconds: number,
): Promise<Hex> {
  // Base the credential on the chain's clock, not ours: repeated demo runs warp a
  // local node's time forward, and verifyCVI compares against block.timestamp.
  const now = Number((await publicClient.getBlock()).timestamp);
  const credentialHash = buildCredentialHash(wallet, now);
  const expiry = BigInt(now + ttlSeconds);
  const signature = await issuerAccount.signMessage({ message: { raw: cviPayload(wallet, credentialHash, expiry) } });
  return sender.writeContract({
    address: gate,
    abi: COMPLIANCE_ABI,
    functionName: "verifyCVI",
    args: [wallet, credentialHash, expiry, signature],
    account: sender.account,
    chain: null,
  });
}

async function simulateGate(gate: Hex, from: Hex, to: Hex, amount: bigint): Promise<{ ok: boolean; error?: string }> {
  try {
    await publicClient.simulateContract({
      address: gate,
      abi: COMPLIANCE_ABI,
      functionName: "gateCVATransfer",
      args: [from, to, amount],
      account: from,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: extractRevertReason(err) };
  }
}

function extractRevertReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  for (const name of ["CVI_MISSING", "CVI_EXPIRED", "CVI_REVOKED"]) {
    if (text.includes(name)) return name;
  }
  return text.split("\n")[0] ?? text;
}

async function confirmTx(txHash: Hex): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
}

/* ────────────────────────────────── demo ───────────────────────────────────── */

async function main(): Promise<void> {
  banner("Avaira CVI/CVA compliance demo");
  const chainId = await publicClient.getChainId();
  log(`rpc            : ${RPC_URL}`);
  log(`chain id       : ${chainId}`);

  const manifest = loadDeployment(CHAIN_ID, process.env.AVAIRA_DEPLOYMENT);
  const gate = manifest.complianceGate;
  if (!gate) throw new Error("deployment manifest has no complianceGate — redeploy with the latest Deploy.s.sol");
  log(`compliance gate: ${gate}`);
  log(`intent vault   : ${manifest.intentVault}`);

  const operatorKey = (process.env.OPERATOR_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
  if (!operatorKey) throw new Error("set OPERATOR_PRIVATE_KEY (protocol admin / issuer)");
  const operator = walletFor(operatorKey);
  const issuerKey = (process.env.CVI_ISSUER_PRIVATE_KEY ?? operatorKey) as Hex;
  const issuer = walletFor(issuerKey);

  const onchainIssuer = await publicClient.readContract({ address: gate, abi: COMPLIANCE_ABI, functionName: "issuer" });
  if (onchainIssuer.toLowerCase() !== issuer.account.address.toLowerCase()) {
    throw new Error(`issuer key ${issuer.account.address} does not match onchain issuer ${onchainIssuer}`);
  }

  // ── actors ──────────────────────────────────────────────────────────────────
  const state = loadState();
  const keyA = (process.env.AGENT_A_PRIVATE_KEY ?? state.agentAPrivateKey ?? generatePrivateKey()) as Hex;
  const keyB = (process.env.AGENT_B_PRIVATE_KEY ?? state.agentBPrivateKey ?? generatePrivateKey()) as Hex;
  const keyC = (process.env.AGENT_C_PRIVATE_KEY ?? state.agentCPrivateKey ?? generatePrivateKey()) as Hex;
  const A = walletFor(keyA);
  const B = walletFor(keyB);
  const C = walletFor(keyC);
  state.agentAPrivateKey = keyA;
  state.agentBPrivateKey = keyB;
  state.agentCPrivateKey = keyC;

  log(`agent A        : ${A.account.address}`);
  log(`agent B        : ${B.account.address}`);
  log(`agent C        : ${C.account.address}`);

  const results: Array<{ scenario: string; pass: boolean; detail: string }> = [];
  const assert = (scenario: string, pass: boolean, detail: string) => {
    results.push({ scenario, pass, detail });
    log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${scenario}${detail ? ` — ${detail}` : ""}`);
    if (!pass) process.exitCode = 1;
  };

  // ── provisioning (skippable for repeat runs against a seeded testnet) ──────
  if (process.env.SKIP_SETUP !== "1") {
    banner("Provisioning demo actors");

    // Fund B and C with native MON (A is funded below with the registration bond).
    for (const actor of [A, B, C]) {
      const balance = await publicClient.getBalance({ address: actor.account.address });
      if (balance < parseEther("0.2")) {
        const tx = await operator.wallet.sendTransaction({
          to: actor.account.address,
          value: parseEther("1"),
          account: operator.account,
          chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
        log(`funded ${actor.account.address} with 1 MON`);
      }
    }

    // Agent A needs an ACTIVE Avaira identity for scenario 4: register + stake + score.
    let agentId = state.agentId ?? (process.env.AGENT_ID ? Number(process.env.AGENT_ID) : undefined);
    if (!agentId) {
      const bond = await publicClient.readContract({
        address: manifest.identityRegistry,
        abi: IDENTITY_ABI,
        functionName: "registrationBond",
      });
      const regTx = await A.wallet.writeContract({
        address: manifest.identityRegistry,
        abi: IDENTITY_ABI,
        functionName: "register",
        args: ["ipfs://agent/cvi-demo-A"],
        value: bond,
        account: A.account,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: regTx, timeout: 120_000 });
      // Take the latest Registered event for owner A.
      const events = await publicClient.getLogs({
        address: manifest.identityRegistry,
        event: {
          type: "event",
          name: "Registered",
          inputs: [
            { name: "agentId", type: "uint256", indexed: true },
            { name: "agentURI", type: "string", indexed: false },
            { name: "owner", type: "address", indexed: true },
          ],
        },
        args: { owner: A.account.address },
        fromBlock: BigInt(Math.max(0, Number(manifest.deploymentBlock ?? 0))),
        toBlock: "latest",
      });
      if (events.length === 0) throw new Error("agent registration emitted no Registered event");
      agentId = Number(events[events.length - 1]!.args.agentId);
      log(`registered agent identity #${agentId} for A (tx ${regTx})`);
    }
    state.agentId = agentId;

    const minStake = await publicClient.readContract({
      address: manifest.stakeRegistry,
      abi: STAKE_ABI,
      functionName: "minStake",
    });
    const currentStake = await publicClient.readContract({
      address: manifest.stakeRegistry,
      abi: STAKE_ABI,
      functionName: "stakeOf",
      args: [BigInt(agentId)],
    });
    if (currentStake < minStake) {
      const needed = minStake - currentStake + 50_000_000n; // headroom above the floor
      const mintTx = await A.wallet.writeContract({
        address: manifest.settlementToken,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [A.account.address, needed],
        account: A.account,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 });
      const approveTx = await A.wallet.writeContract({
        address: manifest.settlementToken,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [manifest.stakeRegistry, needed],
        account: A.account,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
      const stakeTx = await A.wallet.writeContract({
        address: manifest.stakeRegistry,
        abi: STAKE_ABI,
        functionName: "stake",
        args: [BigInt(agentId), needed],
        account: A.account,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: stakeTx, timeout: 120_000 });
      log(`staked ${Number(needed) / 1e6} USDC for agent #${agentId}`);
    }

    const score = await publicClient.readContract({
      address: manifest.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: "scoreOf",
      args: [BigInt(agentId)],
    });
    if (Number(score) < Number(manifest.minScore)) {
      const scoreTx = await operator.wallet.writeContract({
        address: manifest.reputationRegistry,
        abi: REPUTATION_ABI,
        functionName: "postAvairaScore",
        args: [BigInt(agentId), 78],
        account: operator.account,
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash: scoreTx, timeout: 120_000 });
      log(`published Avaira Score 78 for agent #${agentId}`);
    }

    saveState(state);
  }

  const agentId = BigInt(state.agentId ?? Number(process.env.AGENT_ID));

  // ── Scenario 1: both parties CVI-verified → transfer allowed ────────────────
  banner("Scenario 1 — A (valid CVI) → B (valid CVI): allowed");
  let tx = await verifyCviOnchain(issuer.account, operator.wallet, gate, A.account.address, 30 * 24 * 3600);
  await confirmTx(tx);
  log(`CVI verified for A (tx ${tx})`);
  tx = await verifyCviOnchain(issuer.account, operator.wallet, gate, B.account.address, 30 * 24 * 3600);
  await confirmTx(tx);
  log(`CVI verified for B (tx ${tx})`);

  const transferAmount = 250_000_000n; // 250 CVA units (6 decimals)
  tx = await operator.wallet.writeContract({
    address: gate,
    abi: COMPLIANCE_ABI,
    functionName: "gateCVATransfer",
    args: [A.account.address, B.account.address, transferAmount],
    account: operator.account,
    chain: null,
  });
  await confirmTx(tx);
  assert("A→B gated transfer", true, `tx ${tx}`);

  // ── Scenario 2: beneficiary has no CVI → CVI_MISSING ───────────────────────
  banner("Scenario 2 — A → C (no CVI): reverts CVI_MISSING");
  const missing = await simulateGate(gate, A.account.address, C.account.address, transferAmount);
  assert("A→C without C's CVI blocked", !missing.ok && (missing.error ?? "").includes("CVI_MISSING"), missing.error ?? "no revert");

  // ── Scenario 3: expired CVI → CVI_EXPIRED ───────────────────────────────────
  banner("Scenario 3 — A → C with an expired CVI: reverts CVI_EXPIRED");
  tx = await verifyCviOnchain(issuer.account, operator.wallet, gate, C.account.address, EXPIRY_TTL);
  await confirmTx(tx);
  log(`CVI verified for C with a ${EXPIRY_TTL}s TTL (tx ${tx})`);

  const canWarp = await (async () => {
    try {
      await publicClient.request({ method: "evm_increaseTime" as never, params: [EXPIRY_TTL + 2] as never });
      await publicClient.request({ method: "evm_mine" as never, params: [] as never });
      return true;
    } catch {
      return false;
    }
  })();
  if (!canWarp) {
    log(`no local time travel — sleeping ${EXPIRY_TTL + 2}s for the credential to lapse…`);
    await new Promise((r) => setTimeout(r, (EXPIRY_TTL + 2) * 1000));
  } else {
    log(`advanced chain time by ${EXPIRY_TTL + 2}s (local node)`);
  }

  const expired = await simulateGate(gate, A.account.address, C.account.address, transferAmount);
  assert("A→C with expired CVI blocked", !expired.ok && (expired.error ?? "").includes("CVI_EXPIRED"), expired.error ?? "no revert");

  // ── Scenario 4: avaira.run() with cva.transfer blocked pre-execution ────────
  banner("Scenario 4 — avaira.run(cva.transfer) blocked with CVI_UNVERIFIED");
  // Revoke A's CVI: the agent's wallets are no longer identity-verified.
  tx = await operator.wallet.writeContract({
    address: gate,
    abi: COMPLIANCE_ABI,
    functionName: "revokeCVI",
    args: [A.account.address],
    account: operator.account,
    chain: null,
  });
  await confirmTx(tx);
  log(`CVI revoked for A (tx ${tx})`);

  const avaira = new Avaira({
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    contracts: {
      identityRegistry: manifest.identityRegistry,
      reputationRegistry: manifest.reputationRegistry,
      stakeRegistry: manifest.stakeRegistry,
      intentVault: manifest.intentVault,
      complianceGate: gate,
      settlementToken: manifest.settlementToken,
    },
    privateKey: keyA,
  });

  let executeFnCalled = false;
  const blockedRun = await avaira.run(
    agentId,
    { id: "cva-transfer-demo", description: "move 250 CVA from A to B" },
    async () => {
      executeFnCalled = true;
      return "should never run";
    },
    {
      envelope: {
        maxSpendUsd: transferAmount,
        allowedActions: ["cva.transfer", "cva.settle"],
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
  );

  assert(
    "avaira.run blocked pre-execution",
    blockedRun.status === "blocked" &&
      blockedRun.reason === GateReason.CVI_UNVERIFIED &&
      executeFnCalled === false,
    blockedRun.status === "blocked" ? `reason=${GateReason[blockedRun.reason]}, executeFn invoked=${executeFnCalled}` : "run was not blocked",
  );

  // Re-verify A: the identical intent now clears the gate and executes.
  tx = await verifyCviOnchain(issuer.account, operator.wallet, gate, A.account.address, 30 * 24 * 3600);
  await confirmTx(tx);
  log(`CVI re-verified for A (tx ${tx})`);

  let allowedExecuted = false;
  const completedRun = await avaira.run(
    agentId,
    { id: "cva-transfer-demo-retry", description: "move 250 CVA from A to B (retry)" },
    async ({ audit }) => {
      allowedExecuted = true;
      audit.append("cva.transfer", transferAmount);
      return "transferred";
    },
    {
      envelope: {
        maxSpendUsd: transferAmount,
        allowedActions: ["cva.transfer", "cva.settle"],
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
  );
  assert(
    "avaira.run completes once CVI restored",
    completedRun.status === "completed" && allowedExecuted,
    completedRun.status === "completed"
      ? `merkleRoot ${completedRun.merkleRoot}, attest tx ${completedRun.attestTxHash ?? "audit disabled"}`
      : `blocked: ${completedRun.message}`,
  );

  // ── summary ─────────────────────────────────────────────────────────────────
  banner("Summary");
  for (const r of results) log(`${r.pass ? "✓" : "✗"} ${r.scenario}`);
  const failed = results.filter((r) => !r.pass).length;
  log(`\n${results.length - failed}/${results.length} scenarios passed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
