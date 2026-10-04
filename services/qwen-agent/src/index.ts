#!/usr/bin/env tsx
/**
 * Qwen-powered Avaira agent — CLI.
 *
 *   npm run demo:qwen            three scenarios end to end (offline unless a Qwen key is set)
 *   npm run demo:qwen -- --chain run the happy path against the configured Avaira deployment
 *   npm run live                 one live session against Qwen + the chain
 *
 * Scenarios
 *   (a) happy path  — Qwen plans a swap inside the envelope → gate allows → CVA moves → Merkle
 *                     root anchored on-chain.
 *   (b) blocked     — the plan asks for more than the cycle budget → refused before anything is
 *                     committed (execute_fn never runs); a second variant shows the on-chain
 *                     gate itself refusing a lapsed intent.
 *   (c) deviation   — an agent anchors an outcome that spends beyond its envelope; a challenger
 *                     proves it against the anchored Merkle root and `challengeDeviation` slashes
 *                     the stake and pays the bounty.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { AuditTrail, Avaira, ComplianceClient, GateReason, GATE_REASON_TEXT, loadDeployment, signCVIClaim } from "@avaira/sdk";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, stringToHex, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { QwenAgent, type RunTranscript } from "./agent.js";
import { AvairaGate, SimulatedGate, type Gate } from "./gate.js";
import { OfflinePlanner, QwenPlanner, formatUsd, makePlanner, type Planner } from "./qwen.js";
import { ensureAgentReady, registerCVIFor } from "./setup.js";
import { forgeOverspend, treasuryTools } from "./tools.js";

/* ──────────────────────────────── configuration ──────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const CHAIN_ID = Number(flag("chain-id", process.env.CHAIN_ID ?? "10143"));
let AGENT_ID = BigInt(process.env.AGENT_ID ?? "1");
const TASK =
  process.env.TREASURY_TASK ??
  "Rebalance 4000 USDC of the settlement reserve into the yield sleeve without exceeding the cycle budget";
const BUDGET_USD = BigInt(process.env.TREASURY_BUDGET_USD ?? "5000") * 1_000_000n;
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR ?? resolve(process.cwd(), "transcripts");
const MOCK_LLM = has("offline") || /^(1|true|yes)$/i.test(process.env.QWEN_MOCK ?? "");

const command = process.argv[2]?.startsWith("--") ? "demo" : (process.argv[2] ?? "demo");

/* ─────────────────────────────────── helpers ────────────────────────────────── */

const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 10143 ? "Monad Testnet" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.AVAIRA_RPC_URL ?? "https://testnet-rpc.monad.xyz"] } },
  testnet: true,
});

function planner(): Planner {
  return makePlanner({
    apiKey: process.env.QWEN_API_KEY,
    baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL ?? "qwen3.8-max",
    mock: MOCK_LLM,
    maxSteps: Number(process.env.MAX_STEPS ?? "6"),
  });
}

function writeTranscript(name: string, payload: unknown): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const path = resolve(TRANSCRIPT_DIR, name);
  writeFileSync(
    path,
    `${JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
  );
  return path;
}

function finish(name: string, passed: boolean): void {
  console.log(`\n  ${passed ? "✓" : "✗"} ${name} ${passed ? "passed" : "FAILED"}\n`);
  if (!passed) process.exitCode = 1;
}

/* ──────────────────────────────── chain wiring ──────────────────────────────── */

interface ChainContext {
  gate: Gate;
  admin: WalletClient;
  publicClient: PublicClient;
  adminKey: Hex;
  tools: ReturnType<typeof treasuryTools>;
  avaira: Avaira;
  deployment: ReturnType<typeof loadDeployment>;
  agentAddress: Hex;
  counterparty: Hex;
}

async function chainContext(): Promise<ChainContext | null> {
  const key = (process.env.AVAIRA_AGENT_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
  if (!key) return null;
  try {
    const deployment = loadDeployment(CHAIN_ID, process.env.AVAIRA_DEPLOYMENT);
    const publicClient = createPublicClient({ chain, transport: http() });
    const walletClient = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key) });

    const gate = new AvairaGate({
      chainId: CHAIN_ID,
      rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
      deploymentPath: process.env.AVAIRA_DEPLOYMENT,
      agentId: AGENT_ID,
      privateKey: key,
    });

    const avaira = new Avaira({
      chainId: CHAIN_ID,
      rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
      privateKey: key,
      contracts: {
        intentVault: deployment.intentVault,
        identityRegistry: deployment.identityRegistry,
        stakeRegistry: deployment.stakeRegistry,
        reputationRegistry: deployment.reputationRegistry,
        complianceGate: deployment.complianceGate,
      },
    });

    // The counterparty leg of the treasury swap: derived, so it is stable across runs.
    const counterparty = privateKeyToAccount(keccak256(stringToHex(`avaira-treasury-sleeve-${CHAIN_ID}`))).address;

    // Make sure the agent is registered, staked, scored and CVI-verified before it trades.
    const issuerKey = process.env.CLEANVERSE_ISSUER_PRIVATE_KEY as Hex | undefined;
    if (issuerKey) {
      const ready = await ensureAgentReady({
        manifest: deployment,
        publicClient,
        admin: walletClient,
        issuerKey,
        rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
      });
      console.log(`  agent #${ready.agentId} ready (score ${ready.score}) · treasury wallet ${ready.wallet}`);

      // Travel Rule: the beneficiary leg needs its own Cleanverse credential, otherwise the
      // token itself refuses the transfer (CVI_MISSING).
      const cviTx = await registerCVIFor({
        wallet: counterparty,
        manifest: deployment,
        publicClient,
        account: walletClient.account!,
        issuerKey,
        rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
        label: "qwen-beneficiary",
      });
      console.log(`  counterparty ${counterparty} CVI-verified (${cviTx.slice(0, 10)}…)`);
      AGENT_ID = ready.agentId;
      process.env.AGENT_ID = ready.agentId.toString();
    } else {
      console.log("  (CLEANVERSE_ISSUER_PRIVATE_KEY unset — using the agent id from env without bootstrapping)");
    }

    return {
      gate,
      admin: walletClient,
      publicClient,
      adminKey: key,
      tools: treasuryTools(
        {
          publicClient,
          walletClient,
          settlementToken: deployment.settlementToken,
          cvaToken: deployment.cvaToken,
          complianceGate: deployment.complianceGate,
        },
        counterparty,
      ),
      avaira,
      deployment,
      agentAddress: privateKeyToAccount(key).address,
      counterparty,
    };
  } catch (error) {
    console.log(`  (chain mode unavailable: ${(error as Error).message})`);
    return null;
  }
}

/* ───────────────────────────────── scenarios ────────────────────────────────── */

async function scenarioA(): Promise<RunTranscript> {
  console.log("\n═══ Scenario (a) — happy path: plan inside the envelope ═══");
  const chainCtx = has("chain") ? await chainContext() : null;
  const gate: Gate = chainCtx?.gate ?? new SimulatedGate({ score: 78, status: "active", cviValid: true }, AGENT_ID);
  const plan = planner();

  const agent = new QwenAgent({
    planner: plan,
    gate,
    tools: chainCtx?.tools ?? treasuryTools({}, "0x0000000000000000000000000000000000000000"),
    task: TASK,
    budgetUsd: BUDGET_USD,
  });

  const transcript = await agent.run();
  const anchored = transcript.steps.some((step) => Boolean(step.gate.merkleRoot));
  const passed = transcript.status === "completed" && transcript.steps.every((step) => step.gate.allowed) && transcript.steps.every((step) => step.executed);
  console.log(`  status ${transcript.status} · spent ${transcript.spendUsd} / ${transcript.budgetUsd} USD · steps ${transcript.steps.length} · merkle anchored: ${anchored}`);
  writeTranscript("qwen-scenario-a-happy-path.json", transcript);
  finish("scenario (a) happy path", passed);
  return transcript;
}

async function scenarioB(): Promise<void> {
  console.log("\n═══ Scenario (b1) — blocked: the plan asks for more than the cycle budget ═══");
  const gate = new SimulatedGate({ score: 78, status: "active", cviValid: true }, AGENT_ID);
  const agent = new QwenAgent({
    planner: new OfflinePlanner({ overshoot: true }),
    gate,
    tools: treasuryTools({}, "0x0000000000000000000000000000000000000000"),
    task: TASK,
    budgetUsd: 1000n * 1_000_000n,
    log: () => {},
  });
  const overshoot = await agent.run();
  const refused = overshoot.status === "blocked" && overshoot.steps.every((step) => !step.executed || step.step === 1);
  const blockedStep = overshoot.steps.find((step) => !step.gate.allowed);
  console.log(`  ${blockedStep ? `step ${blockedStep.step} refused (${blockedStep.gate.reason}) — ${blockedStep.detail}` : "no refusal recorded"}`);
  console.log(`  execute_fn ran for the refused step: ${blockedStep?.executed ?? "n/a"}`);

  console.log("\n═══ Scenario (b2) — blocked by the on-chain gate: revoked CVI credential ═══");
  let onchain: RunTranscript | null = null;
  let commitRejected: RunTranscript | null = null;
  const chainCtx = has("chain") ? await chainContext() : null;
  if (chainCtx) {
    const compliance = new ComplianceClient({
      rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
      chainId: CHAIN_ID,
      complianceGate: chainCtx.deployment.complianceGate!,
      cvaToken: chainCtx.deployment.cvaToken!,
      account: chainCtx.admin.account!,
    });

    // 1. Revoke the treasury wallet's Cleanverse credential. The vault only checks CVI *after*
    //    the intent is committed, so this is a genuine pre-execution gate refusal.
    const revokeTx = await compliance.revokeCredential(chainCtx.agentAddress);
    await chainCtx.publicClient.waitForTransactionReceipt({ hash: revokeTx });
    console.log(`  CVI revoked for ${chainCtx.agentAddress} (${revokeTx.slice(0, 10)}…)`);

    onchain = await new QwenAgent({
      planner: new OfflinePlanner(),
      gate: chainCtx.gate,
      tools: chainCtx.tools,
      task: TASK,
      budgetUsd: BUDGET_USD,
    }).run();

    const blocked = onchain.steps.find((step) => !step.gate.allowed);
    console.log(`  ${blocked ? `step ${blocked.step} BLOCKED (${blocked.gate.reason}) — execute_fn ran: ${blocked.executed}` : "no block recorded"}`);

    // Leave the chain as we found it: re-verify the credential for the same wallet.
    const restored = await registerCVIFor({
      wallet: chainCtx.agentAddress,
      manifest: chainCtx.deployment,
      publicClient: chainCtx.publicClient,
      account: chainCtx.admin.account!,
      issuerKey: process.env.CLEANVERSE_ISSUER_PRIVATE_KEY as Hex,
      rpcUrl: process.env.AVAIRA_RPC_URL ?? "http://127.0.0.1:8545",
      label: "qwen-treasury-restored",
    });
    console.log(`  credential re-registered for ${chainCtx.agentAddress} (${restored.slice(0, 10)}…) — chain left clean`);

    // 2. A lapsed envelope is refused even earlier: the vault rejects the commitment itself.
    commitRejected = await new QwenAgent({
      planner: new OfflinePlanner(),
      gate: chainCtx.gate,
      tools: chainCtx.tools,
      task: TASK,
      budgetUsd: BUDGET_USD,
      log: () => {},
      envelopeFor: (call, step, base) =>
        step === 1 ? { ...base, deadline: BigInt(Math.floor(Date.now() / 1000) - 60) } : base,
    }).run();
    const rejected = commitRejected.steps.find((step) => !step.gate.allowed);
    console.log(`  ${rejected ? `step ${rejected.step} refused at commit (${rejected.gate.reason}) — execute_fn ran: ${rejected.executed}` : "no commit refusal recorded"}`);
  } else {
    console.log("  (skipped: no signer/deployment — run with --chain on a deployed network)");
  }

  const transcript = { overshoot, onchainRevokedCVI: onchain, commitRejected };
  const path = writeTranscript("qwen-scenario-b-blocked.json", transcript);
  console.log(`  transcript: ${path}`);
  const onchainBlocked = onchain?.steps.find((step) => !step.gate.allowed);
  const commitRefused = commitRejected?.steps.find((step) => !step.gate.allowed);
  const passed =
    Boolean(blockedStep && !blockedStep.executed) &&
    (!onchain || (onchainBlocked !== undefined && !onchainBlocked.executed)) &&
    (!commitRejected || (commitRefused !== undefined && !commitRefused.executed));
  finish("scenario (b) blocked cycle", passed);
}

async function scenarioC(): Promise<void> {
  console.log("\n═══ Scenario (c) — deviation: forged certificate → slash + bounty ═══");
  const chainCtx = has("chain") ? await chainContext() : null;
  if (!chainCtx) {
    console.log("  (skipped: scenario (c) needs a chain — pass --chain with a signer and deployment)");
    finish("scenario (c) deviation slash", false);
    return;
  }

  const { avaira, deployment, agentAddress, counterparty } = chainCtx;
  const overspend = 10_000n * 1_000_000n; // 10x the envelope the agent committed to
  const budget = 100n * 1_000_000n;

  // 1. The agent commits a modest envelope but executes a swap beyond it.
  const agentKey = (process.env.AVAIRA_AGENT_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as Hex;
  const tools = [...treasuryTools({}, counterparty), forgeOverspend({}, overspend)];
  void tools;
  let trail: AuditTrail | undefined;

  const outcome = await avaira.run(
    AGENT_ID,
    { id: "treasury-deviation", description: "forged overspend for the challenge demo" },
    async ({ audit, envelope, intentHash }) => {
      trail = audit;
      const entry = audit.append("cva.transfer", overspend, { forged: true }, overspend);
      console.log(`  committed envelope ${formatUsd(envelope.maxSpendUsd)} USD · executed entry ${entry.seq} spent ${formatUsd(overspend)} USD`);
      return { intentHash, leaf: entry };
    },
    { envelope: { maxSpendUsd: budget, allowedActions: ["cva.transfer"], deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) } },
  );

  if (outcome.status !== "completed") {
    console.log(`  the run itself was blocked (${outcome.reason}: ${outcome.message}) — nothing to challenge`);
    finish("scenario (c) deviation slash", false);
    return;
  }

  // 2. A challenger proves the deviation against the anchored root and calls challengeDeviation.
  const deviations = trail!.deviations({ maxSpendUsd: budget, allowedActions: ["cva.transfer"] });
  if (deviations.length === 0) throw new Error("no envelope deviation was recorded — nothing to challenge");
  const entry = deviations[0];
  const proof = trail!.proofFor(entry.seq);
  const leaf = {
    agentId: AGENT_ID,
    intentHash: outcome.intentHash,
    action: entry.action,
    spendUsd: entry.spendUsd,
    nonce: entry.nonce,
  };

  // The challenger posts a bond to make the challenge costly if unproven: approve the vault.
  const challengerKey = (process.env.DEMO_CHALLENGER_PRIVATE_KEY ?? agentKey) as Hex;
  const challenger = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(challengerKey) });
  const challengerAddress = privateKeyToAccount(challengerKey).address;
  const bond = (await avaira.publicClient.readContract({
    address: deployment.intentVault,
    abi: parseAbi(["function challengerBond() view returns (uint256)"]),
    functionName: "challengerBond",
  })) as bigint;

  if (bond > 0n) {
    // Fund the bond from the test token (permissionless mint), then approve the vault.
    const balance = (await avaira.publicClient.readContract({
      address: deployment.settlementToken,
      abi: parseAbi(["function balanceOf(address account) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [challengerAddress],
    })) as bigint;
    if (balance < bond) {
      const mintTx = await challenger.writeContract({
        address: deployment.settlementToken,
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        functionName: "mint",
        args: [challengerAddress, bond * 2n],
        chain: null,
        account: challenger.account!,
      });
      await avaira.publicClient.waitForTransactionReceipt({ hash: mintTx });
    }

    const allowance = (await avaira.publicClient.readContract({
      address: deployment.settlementToken,
      abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
      functionName: "allowance",
      args: [challengerAddress, deployment.intentVault],
    })) as bigint;
    if (allowance < bond) {
      const approveTx = await challenger.writeContract({
        address: deployment.settlementToken,
        abi: parseAbi(["function approve(address spender, uint256 amount)"]),
        functionName: "approve",
        args: [deployment.intentVault, bond],
        chain: null,
        account: challenger.account!,
      });
      await avaira.publicClient.waitForTransactionReceipt({ hash: approveTx });
      console.log(`  challenger ${challengerAddress} bonded ${bond} (${approveTx.slice(0, 10)}…)`);
    }
  }

  const stakeBefore = await avaira.stakeOf(AGENT_ID);
  const txHash = await challenger.writeContract({
    address: deployment.intentVault,
    abi: parseAbi([
      "function challengeDeviation(uint256 agentId, bytes32 intentHash, (uint256 agentId, bytes32 intentHash, string action, uint256 spendUsd, uint256 nonce) leaf, bytes32[] merkleProof)",
    ]),
    functionName: "challengeDeviation",
    args: [AGENT_ID, outcome.intentHash, leaf, proof],
    chain: null,
    account: challenger.account!,
  });
  await avaira.publicClient.waitForTransactionReceipt({ hash: txHash });
  const stakeAfter = await avaira.stakeOf(AGENT_ID);
  const challenged = await avaira.intentOf(AGENT_ID, outcome.intentHash).catch(() => null);

  const slashed = stakeBefore > stakeAfter;
  console.log(`  challenge tx ${txHash}`);
  console.log(`  stake ${stakeBefore} → ${stakeAfter} ${slashed ? "(slashed)" : "(unchanged)"}`);

  const transcript = {
    scenario: "deviation",
    agentId: AGENT_ID.toString(),
    agentAddress,
    counterparty,
    challenger: challengerAddress,
    envelope: { maxSpendUsd: budget.toString(), allowedActions: ["cva.transfer"] },
    forgedEntry: { seq: entry.seq, action: entry.action, spendUsd: entry.spendUsd.toString(), nonce: entry.nonce.toString() },
    leaf,
    proof,
    intentHash: outcome.intentHash,
    merkleRoot: outcome.merkleRoot,
    attestTxHash: outcome.attestTxHash,
    challengeTxHash: txHash,
    stakeBefore: stakeBefore.toString(),
    stakeAfter: stakeAfter.toString(),
    slashed,
    intent: challenged,
    deployment,
    tools: tools.map((tool) => tool.name),
    gateReasonText: GATE_REASON_TEXT[GateReason.ENVELOPE_MISMATCH],
  };
  const path = writeTranscript("qwen-scenario-c-deviation.json", transcript);
  console.log(`  transcript: ${path}`);
  finish("scenario (c) deviation slash", slashed);
}

/* ──────────────────────────────────── main ──────────────────────────────────── */

async function main(): Promise<void> {
  console.log("\n═══ Avaira × Qwen — gated treasury agent ═══");
  const plan = planner();
  console.log(`  planner         : ${plan.kind === "qwen" ? `Qwen ${plan.model} @ ${process.env.QWEN_BASE_URL ?? "dashscope-intl"}` : "offline (no QWEN_API_KEY / QWEN_MOCK=1)"}`);
  console.log(`  chain           : ${CHAIN_ID}${has("chain") ? " (chain mode)" : " (offline)"}`);
  console.log(`  task            : ${TASK}`);
  console.log(`  cycle budget    : ${formatUsd(BUDGET_USD)} USD`);

  if (command === "live") {
    const chainCtx = await chainContext();
    if (!chainCtx) throw new Error("live mode needs AVAIRA_AGENT_PRIVATE_KEY and a deployment manifest");
    const agent = new QwenAgent({
      planner: new QwenPlanner({
        apiKey: process.env.QWEN_API_KEY,
        baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        model: process.env.QWEN_MODEL ?? "qwen3.8-max",
        mock: false,
        maxSteps: Number(process.env.MAX_STEPS ?? "6"),
      }),
      gate: chainCtx.gate,
      tools: chainCtx.tools,
      task: TASK,
      budgetUsd: BUDGET_USD,
    });
    const transcript = await agent.run();
    console.log(writeTranscript(`qwen-live-${Date.now()}.json`, transcript));
    return;
  }

  await scenarioA();
  await scenarioB();
  await scenarioC();
}

main().catch((error: unknown) => {
  console.error(`\n✗ qwen-agent failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
