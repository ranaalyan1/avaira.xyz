<div align="center">

<img src="assets/logo.png" alt="Avaira Logo" width="128" style="border-radius: 26px;" />

# AVAIRA

### Real-Time Accountability, Cognitive OS & On-Chain Execution Control for Autonomous AI Agents

**x402 lets agents pay. ERC-8004 lets agents be identified.**  
**Avaira makes them accountable in real time** — a credit bureau, mathematical safety kernel, and pre-execution circuit breaker enforced *before* agents act rather than audited after the damage.

[![Solidity](https://img.shields.io/badge/Solidity-%5E0.8.24-634FFF?style=for-the-badge&logo=solidity&logoColor=white)](contracts/src/core/)
[![ERC-8004](https://img.shields.io/badge/Standard-ERC--8004-7C3AED?style=for-the-badge)](contracts/src/interfaces/IERC8004.sol)
[![Monad](https://img.shields.io/badge/Monad_Testnet-10143-836EF9?style=for-the-badge)](contracts/script/Deploy.s.sol)
[![Cognitive OS](https://img.shields.io/badge/Cognitive_OS-v5.0-00E5FF?style=for-the-badge)](avaira_os/)
[![Coverage](https://img.shields.io/badge/Core_Coverage-94.4%25-10B981?style=for-the-badge)](contracts/metrics/coverage.txt)
[![SDKs](https://img.shields.io/badge/SDK-TypeScript_%7C_Python_%7C_Rust-F59E0B?style=for-the-badge)](sdk/)

[**Overview**](#-why-avaira) •
[**3-Layer Architecture**](#-three-layer-architecture) •
[**Smart Contracts**](#-on-chain-protocol-monad--erc-8004) •
[**Pre-Execution Gate**](#-the-pre-execution-gate) •
[**Avaira Score**](#-the-avaira-score) •
[**Cognitive OS v5.0**](#-cognitive-os-v50--hardened-execution-kernel) •
[**SDK Quickstart**](#-sdk-quickstart) •
[**Benchmarks & Coverage**](#-gas-benchmarks--coverage) •
[**Control Center**](#-protocol-control-center--dashboard)

</div>

---

## ⚡ Quickstart

**One command. ~7 seconds. No API keys, no wallet, no database, no `sudo`.**

```bash
git clone https://github.com/ranaalyan1/avaira.xyz && cd avaira.xyz
./setup.sh
```

`setup.sh` creates a local `.venv`, installs the few small dependencies the core
needs, and then **proves the install works** — running the four deterministic
proof artifacts and all 21 Cognitive OS tests, and failing loudly if either
regresses:

```
✓ proof artifacts: 4/4 PASS (self-correction, ambiguity, math-safety clamp, slash)
✓ kernel tests: 21 passed
✓ Avaira is set up and verified in 7s
```

| Level | Command | Time (cold) | Adds |
| :--- | :--- | ---: | :--- |
| **Core** (default) | `./setup.sh` | **~7s** | `.venv`, proof artifacts, 21 kernel tests |
| **Developer** | `./setup.sh --dev` | ~11s | TypeScript SDK, Python SDK, scorer test suites |
| **Full** | `./setup.sh --full` | 1–4 min | `contracts/.env` scaffold, Foundry suite, frontend deps |
| **Console** | `./setup.sh --serve` | — | browser Quickstart Console on `:8402` |

Every flag, the doctor mode (`--check`), `--json` for CI/agents, and the
troubleshooting table live in [**SETUP.md**](SETUP.md). Deploying to Monad is a
separate, deliberate step that needs a funded key (`make deploy-monad`) — nothing
before it does.

### 🤖 Or let your AI agent run it

Paste this into Claude Code, Codex, Cursor, Copilot, or any agent with shell access:

```text
Set up the Avaira repo in this working directory for me.
1. Read AGENTS.md.
2. Run: ./setup.sh --yes --json
3. Confirm exit code 0 and "status":"ok", with 4/4 proof artifacts and 21/21 kernel tests passing.
4. Then run ./setup.sh --serve and give me the console URL.
Do not install anything else, do not ask me for API keys or a wallet, and do not deploy contracts.
```

[`AGENTS.md`](AGENTS.md) carries the permission manifest (what the agent may
install, and the explicit never-needed list: no keys, no wallet, no `sudo`, no
database), the exact expected outputs, and a failure playbook — so the agent does
not stop to ask you for credentials.

[![Open in GitHub Codespaces](https://img.shields.io/badge/Open%20in-Codespaces-181717?style=for-the-badge&logo=github&logoColor=white)](https://codespaces.new/ranaalyan1/avaira.xyz)
— the devcontainer runs `./setup.sh` automatically on create.

---

## 🌐 Why Avaira?

Autonomous AI agents can now hold wallets, call external APIs, and settle payments — yet most agent frameworks rely on **probabilistic prompts** and **post-hoc log inspection**. By the time a hallucinated trade, runaway loop, or prompt-injected tool call is detected in logs, the capital is already gone.

Avaira replaces *"trust the model"* with **cryptographic, economic, and mathematical guarantees**:

| Dimension | Legacy Agent Guardrails | **Avaira Protocol** |
| :--- | :--- | :--- |
| **Enforcement Timing** | Post-hoc log alerting after execution | **Pre-execution circuit breaker** (`checkGate` / `ExecutionGate`) — blocked agents never run `execute_fn` |
| **Identity & Sybil Resistance** | Ephemeral API keys or unbonded wallets | **ERC-8004 Bond-Backed Identity NFT** with pull-based escrow and on-chain status (`ACTIVE`, `SUSPENDED`, `BANNED`) |
| **Safety Verification** | LLM self-critique ("looks safe to me") | **Interval-Arithmetic Symbolic Prover + 200× Monte-Carlo Shadow Sandbox + OPA Rego Policies** |
| **Reputation & Credit** | Unverifiable self-reported metrics | **Deterministic 0–100 Avaira Score (Grades A+ to D)** grounded in settled payments & unlocking 110%–150% under-collateralized credit |
| **Auditability** | Mutable database logs | **Hash-chained local trail + on-chain Merkle root commitment** with a 24h permissionless `challengeDeviation` bounty window |
| **Consequences** | None (restart container) | **Automated Slashing Ladder** (`WARNING` → `SUSPENSION` → `BAN`), immediate credit freeze, and atomic collateral burn |

### The Three Institutional Pillars

```
┌─────────────────────────────────┐  ┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│         1. RATE (Moody's)       │  │         2. CLEAR (DTCC)         │  │        3. INSURE (Lloyd's)      │
│─────────────────────────────────│  │─────────────────────────────────│  │─────────────────────────────────│
│ • 0–100 Avaira Score (A+ to D)  │  │ • Proof-of-Intent commitment    │  │ • Bonded USDC stake & slashing  │
│ • 6 Sybil-grounded components   │  │ • Pre-execution Risk Envelope   │  │ • Score-gated Credit Market     │
│ • Laplace-smoothed small sample │  │ • Symbolic + OPA + TEE gate     │  │ • Underwriter yield & bounties  │
└─────────────────────────────────┘  └─────────────────────────────────┘  └─────────────────────────────────┘
```

---

## 🏗️ Three-Layer Architecture

Avaira combines **on-chain settlement and accountability on Monad**, an **offline deterministic Cognitive OS kernel**, and an **enterprise zero-trust control plane**:

```
                                   ┌────────────────────────────────────────────┐
                                   │           AUTONOMOUS AI AGENT              │
                                   │     (LangChain / CrewAI / Custom SDK)      │
                                   └─────────────────────┬──────────────────────┘
                                                         │
                         ┌───────────────────────────────▼───────────────────────────────┐
                         │         LAYER 1 — COGNITIVE OS v5.0 (avaira_os/)              │
                         │  System-2 ReasoningTrace ─▶ SymbolicProver (Interval Math)    │
                         │  ─▶ 200× Monte-Carlo ShadowSandbox ─▶ HMAC SafetyCertificate  │
                         └───────────────────────────────┬───────────────────────────────┘
                                                         │
                         ┌───────────────────────────────▼───────────────────────────────┐
                         │       LAYER 2 — EXECUTION SHIELD & SDK (sdk/, backend/)       │
                         │  Local SLM (<50ms) ─▶ OPA Rego Rules ─▶ Nitro Enclave PCR0    │
                         │  ─▶ Hash-Chained Audit Trail & Canonical Merkle Tree Builder  │
                         └───────────────────────────────┬───────────────────────────────┘
                                                         │
                         ┌───────────────────────────────▼───────────────────────────────┐
                         │      LAYER 3 — ON-CHAIN ACCOUNTABILITY (contracts/ Monad)     │
                         │  commitIntent ─▶ checkGate (eth_call) ─▶ attestOutcome        │
                         │  ─▶ 24h Challenge Window ─▶ Reputation & Credit Market        │
                         └───────────────────────────────────────────────────────────────┘
```

---

## ⛓️ On-Chain Protocol (Monad & ERC-8004)

Six modular Solidity smart contracts (`^0.8.24`, built with Foundry) form the on-chain core under [`contracts/src/core/`](contracts/src/core/). One-shot deployment via [`contracts/script/Deploy.s.sol`](contracts/script/Deploy.s.sol) deploys and wires all six contracts and writes the canonical manifest to `deployments/{chainId}.json`.

| # | Contract | Standard | Core Responsibility |
| :-: | :--- | :--- | :--- |
| **1** | [`AvairaIdentityRegistry.sol`](contracts/src/core/AvairaIdentityRegistry.sol) | **ERC-8004 Identity** | Bond-backed ERC-721 agent identity NFT, metadata URI, EIP-712 `agentWallet` binding, lifecycle state (`ACTIVE`, `SUSPENDED`, `BANNED`), and pull-based refund escrow. |
| **2** | [`AvairaReputationRegistry.sol`](contracts/src/core/AvairaReputationRegistry.sol) | **ERC-8004 Reputation** | Sybil-**grounded** feedback (requires verified on-chain payment receipts ≥ `minGroundedPayment`) and on-chain anchoring of the 0–100 Avaira Score & Grade (`A+`…`D`). |
| **3** | [`AvairaValidationRegistry.sol`](contracts/src/core/AvairaValidationRegistry.sol) | **ERC-8004 Validation** | Independent validator request/response lifecycle with tag-based categorization (including `appeal` resolution) and immutable finalization. |
| **4** | [`AvairaIntentVault.sol`](contracts/src/core/AvairaIntentVault.sol) | **Avaira Native** | **Proof-of-Intent**: commits `keccak256(plan)` + `RiskEnvelope`, enforces pre-execution `checkGate`, anchors post-execution outcome + Merkle root, and adjudicates `challengeDeviation` proofs. |
| **5** | [`AvairaStakeRegistry.sol`](contracts/src/core/AvairaStakeRegistry.sol) | **Avaira Native** | USDC collateral vault, gate eligibility verification, three-tier slashing ladder (`WARNING` 10% / `SUSPENSION` 35% + 7d cooldown / `BAN` 100%), and challenger bounty payouts. |
| **6** | [`AvairaCreditMarket.sol`](contracts/src/core/AvairaCreditMarket.sol) | **Avaira Native** | Score-gated agent credit pool: dynamic collateral ratios (**110%** for Grade A, **125%** for Grade B, **150%** for Grade C) and automatic health-factor liquidation upon score degradation. |

---

## 🛡️ The Pre-Execution Gate

Because Monad finalizes blocks in sub-second timeframes (400ms block times / 800ms finality), Avaira performs a **real-time on-chain pre-execution gate** before an agent's tool or transaction ever executes:

```
         commitIntent                      checkGate                    execute_fn
  Agent ───────────────▶ Monad ────────▶ free eth_call ◀──────────── Agent Runtime
    (plan + envelope)      │            (allow | block)
                           │                   │ allowed
                           │                   ▼
                           └──── attestOutcome(outcomeHash, merkleRoot) ──▶ 24h Challenge Window
                                               │
                         Anyone with leaf + Merkle proof ──▶ challengeDeviation ──▶ Slash + Bounty
```

1. **One Commitment = One Execution**: `intentHash` binds the agent's full plan and its `RiskEnvelope` (`maxSpendUsd`, `allowedActionsHash`, `deadline`).
2. **Enforceable Risk Envelopes**: `checkGate(agentId, intentHash, envelopeHash)` verifies agent identity, active status, minimum stake (`≥ 100 USDC`), minimum Avaira Score (`≥ 60`, Grade C), envelope match, and deadline expiration in a single `eth_call`.
3. **Blocked Agents Never Execute**: When `checkGate` returns a rejection reason (`BANNED`, `SUSPENDED`, `UNDER_STAKED`, `LOW_SCORE`, `ENVELOPE_MISMATCH`, `EXPIRED`), `avaira.run()` aborts immediately and `execute_fn` is **never invoked**.
4. **Cryptographically Provable Deviations**: During execution, the SDK records every action (`actionType`, `spendUsd`, `timestamp`) into a local hash-chained audit trail and anchors only the 32-byte Merkle root on-chain. If any leaf violates the committed `RiskEnvelope` (e.g., unauthorized action or spend exceeding `maxSpendUsd`), anyone can submit a compact Merkle proof to `challengeDeviation` within 24 hours to slash the agent and claim the challenger bounty.
5. **Cross-Language Merkle Parity**: [`contracts/test/MerkleParity.t.sol`](contracts/test/MerkleParity.t.sol) tests Solidity's [`MerkleLib.sol`](contracts/src/lib/MerkleLib.sol) directly against cryptographic test vectors generated by the TypeScript SDK ([`sdk/typescript/scripts/gen-parity-vectors.ts`](sdk/typescript/scripts/gen-parity-vectors.ts)).

---

## 📊 The Avaira Score

Implemented in [`services/scorer/src/formula.ts`](services/scorer/src/formula.ts) and anchored on-chain in [`AvairaReputationRegistry.sol`](contracts/src/core/AvairaReputationRegistry.sol), the Avaira Score is a deterministic `0–100` credit rating computed from six publicly verifiable on-chain signals:

| Component | Weight | Mathematical Formulation & Signal Source |
| :--- | :-: | :--- |
| **SuccessRate** | **30** | Laplace-smoothed ratio `(successes + α·prior) / (attempts + α)` of attested, undeviated intents vs. total committed intents. |
| **Consistency** | **20** | Stability of success rates across four contiguous time windows (`1 - spread`), penalizing erratic behavior bursts. |
| **SlashHistory** | **20** | Severity-weighted penalty (`WARNING = 3`, `SUSPENSION = 10`, `BAN = 20`) with a **45-day exponential half-life decay**. |
| **VolumeHandled** | **15** | Log-scaled grounded USDC settlement volume (`log10(1 + volumeUsd) / log10(1 + 1,000,000)`), resisting wash-trading via payment grounding. |
| **AgeOnNetwork** | **10** | Linear maturity curve from ERC-8004 identity registration up to saturation at 30 days. |
| **AppealWinRate** | **5** | Laplace-smoothed share of validation disputes tagged `appeal` won by the agent. |

### Hard Eligibility Caps & Credit Tiers

**Stake buys entry into the system, never points.** Instead of letting wealthy agents buy a high score with collateral, Avaira enforces strict protocol caps:

| Agent State / Condition | Score Cap | Gate Status (`minScore = 60`) | Credit Market Collateral Ratio |
| :--- | :-: | :-: | :-: |
| **Grade A+ / A / A-** (`Score 85–100`) | Uncapped | ✅ **Allowed** | **110%** Collateral |
| **Grade B+ / B / B-** (`Score 70–84`) | Uncapped | ✅ **Allowed** | **125%** Collateral |
| **Grade C+ / C** (`Score 60–69`) | Uncapped | ✅ **Allowed (Floor)** | **150%** Collateral |
| **Under-Staked or Deviation Upheld (<24h)** | **≤ 59 (C-)** | 🛑 **Blocked** | 🔒 Borrowing Frozen |
| **Suspended Agent** | **≤ 55 (C-)** | 🛑 **Blocked** | 🔒 Borrowing Frozen + Liquidatable |
| **Banned Agent** | **0 (D)** | 🛑 **Permanently Blocked** | ⚡ Immediate Liquidation |

---

## 🧠 Cognitive OS v5.0 — Hardened Execution Kernel

Located in [`avaira_os/`](avaira_os/) (detailed in [`docs/cognitive-os-v5.md`](docs/cognitive-os-v5.md)), **Avaira Cognitive OS v5.0** is an offline, zero-dependency (Python stdlib + Pydantic), mathematically deterministic agent kernel where safety is proven *before* any action is emitted.

```
                         ┌────────────────────────────────────────────┐
                         │            AgentOS (agent_os.py)           │
                         │        DCG Loop Orchestration Engine       │
                         └────────────────────────────────────────────┘
     PLAN ────────────▶ PROVE ────────────▶ SIMULATE ────────────▶ EXECUTE
       ▲                  │                    │                      │
       │   Critique       │ UNSAFE + witness   │ confidence < threshold│ ExecutionGate approves
       └──────────────────┴────────────────────┘                      ▼
           back-edges                                             COMPLETED
                                                       (or SLASHED / ABORTED /
                                                        AWAIT_INPUT / REFUSED)
```

### The Five Architectural Pillars

| Pillar | Module(s) | Deterministic Guarantee |
| :--- | :--- | :--- |
| **A — Cognitive Kernel** | [`kernel.py`](avaira_os/kernel.py), [`reasoning.py`](avaira_os/reasoning.py) | Slot-based Global Working Memory (`7±2` capacity, activation decay, eviction-proof Goal Chunk); priority production rules (`priority ≥ 9` raises `InterruptSignal`); System-2 planner requiring a complete `ReasoningTrace` (*Decomposition → Risk Analysis → Alternatives → Decision*). |
| **B — Three-Tier Memory** | [`memory_tiers.py`](avaira_os/memory_tiers.py) | **L1** Working Set, **L2** Episodic Store (pure-Python TF-IDF + cosine similarity), **L3** Semantic Belief Graph (`S-P-O` triples). `SelfEditingMemory` rejects any L3 write lacking a verification artifact; reversing an existing belief requires strictly higher confidence or **2 independent artifacts**. |
| **C — World Model & Prover** | [`world_model.py`](avaira_os/world_model.py) | `SymbolicProver` evaluates state transitions using **interval arithmetic** `[lo, hi]` against hard invariants, returning `SAFE`, `UNSAFE` (with a concrete witness counterexample), or `UNKNOWN` (fail-closed). `ShadowSandbox` runs **200× seeded Monte-Carlo rollouts** across parameter bounds. |
| **D — Hardened Execution Gate** | [`execution_gate.py`](avaira_os/execution_gate.py) | Strict boolean conjunction: valid Nitro Enclave hardware attestation (`PCR0`) **∧** HMAC-SHA256 `SafetyCertificate` bound to exact `plan_hash` **∧** strict Risk Envelope compliance. Tampering triggers atomic stake burn (`LocalLedgerSlashing`) and renders an EVM `freezeAndSlash(address,uint256,string)` payload. |
| **E — Cognitive Ledger** | [`agent_os.py`](avaira_os/agent_os.py), [`events.py`](avaira_os/events.py) | Directed Cyclic Graph (DCG) loop with automatic self-correction back-edges, `AWAIT_INPUT` suspension on missing parameters, and a tamper-evident SHA-256 hash chain (`CognitiveLedger.verify_chain()`). |

### Deterministic Proof Artifacts

Run all four deterministic verification scenarios locally (two consecutive runs produce byte-identical cryptographic transcripts):

```bash
python3 -m avaira_os.demos
```

1. **Artifact 1 — Self-Correction**: An under-budgeted deployment plan fails interval proving with a witness counterexample; the critique back-edge automatically clamps spend to the envelope limit, proves `SAFE`, passes 200× Monte-Carlo simulation (`confidence = 1.0`), and executes.
2. **Artifact 2 — Ambiguity Suspension**: A prompt to *"pay the vendor invoice"* with no dollar amount refuses to guess, suspends at `AWAIT_INPUT`, and resumes cleanly once `submit_answer("amount_usd", 20, 30)` is provided.
3. **Artifact 3 — Mathematical Safety Clamp**: A `$120` payment request against a `$100` cap is rejected by `SymbolicProver` with a witness; the planner clamps the transfer to `$95` (respecting the 5% safety margin) and proves `SAFE`.
4. **Artifact 4 — Pre-Execution Tamper Slash**: A plan bearing a forged certificate signature is intercepted by `ExecutionGate` (`invalid_certificate_signature`) *before* execution, atomically burning **25% ($25)** of the agent's stake and emitting the EVM `freezeAndSlash` settlement transaction.

---

## 💻 SDK Quickstart

Avaira ships first-class SDKs for **TypeScript**, **Python**, and **Rust**, plus drop-in wrappers for **LangChain** and **CrewAI**.

### TypeScript SDK (`@avaira/sdk` v2)

```typescript
import { Avaira, loadDeployment } from "@avaira/sdk";

const deployment = loadDeployment(10143); // Monad Testnet
const avaira = new Avaira({
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  contracts: deployment,
});

const result = await avaira.run(
  1n, // ERC-8004 agentId
  { task: "reconcile-invoice", invoiceId: "INV-4821" },
  async ({ audit }) => {
    audit.record({ actionType: "web.search", spendUsd: 250_000n }); // $0.25 (6 decimals)
    audit.record({ actionType: "payment.settle", spendUsd: 4_500_000n }); // $4.50
    return { settled: true, txRef: "0xabc..." };
  },
  {
    envelope: {
      maxSpendUsd: 5_000_000n, // $5.00 hard cap
      allowedActions: ["web.search", "payment.settle"],
    },
  }
);

if (result.status === "blocked") {
  console.error(`Gate blocked execution [${result.reasonText}] — execute_fn never ran.`);
} else {
  console.log(`Completed! Merkle root anchored: ${result.merkleRoot}`);
  console.log(`Gate latency: ${result.timings.checkGateMs}ms`);
}
```

### Python SDK (`avaira` v2 & `avaira_shield`)

```python
import os
from avaira import Avaira, RiskEnvelope

avaira = Avaira.from_deployment(
    chain_id=10143,
    private_key=os.environ["AGENT_PRIVATE_KEY"],
)

result = avaira.run(
    agent_id=1,
    task={"id": "treasury-rebalance", "pool": "usdc-mon"},
    execute_fn=lambda ctx: (
        ctx.audit.record("dex.quote", spend_usd=0),
        ctx.audit.record("dex.swap", spend_usd=15_000_000),  # $15.00
        {"swapped": True},
    )[-1],
    envelope=RiskEnvelope(
        max_spend_usd=20_000_000,  # $20.00 cap
        allowed_actions=["dex.quote", "dex.swap"],
        deadline=1893456000,
    ),
)

if result.status == "blocked":
    print(f"Pre-execution gate refused: {result.message}")
```

**2-Line LangChain & CrewAI Protection (`sdk/avaira_shield/`):**

```python
from avaira_shield import AvairaClient, protect_agent, protect_crew

client = AvairaClient(api_key="avk_live_...", agent_id="agent-alpha")
protected_executor = protect_agent(langchain_executor, client)  # Wraps all LangChain tools
protected_crew = protect_crew(crewai_instance, client)          # Wraps all CrewAI agents
```

---

## 📈 Gas Benchmarks & Coverage

All metrics are measured from real Foundry test and benchmark runs stored in [`contracts/metrics/gas.json`](contracts/metrics/gas.json) and [`contracts/metrics/coverage.txt`](contracts/metrics/coverage.txt). Reproduce at any time with `make benchmark` and `cd contracts && make coverage`.

### On-Chain Execution Gas per Primitive

| Operation | Contract | Execution Gas | Notes |
| :--- | :--- | ---: | :--- |
| `checkGate` | `AvairaIntentVault` | **0 (free `eth_call`)** | Pre-execution circuit breaker read against latest Monad state |
| `recordGateDecision` | `AvairaIntentVault` | **5,295** | Optional on-chain audit log of gate decision |
| `challengeDeviation` | `AvairaIntentVault` | **45,694** | Verifies Merkle proof of envelope violation & triggers slash |
| `attestOutcome` | `AvairaIntentVault` | **48,339** | Anchors outcome hash + 32-byte audit trail Merkle root |
| `setAgentWallet` | `AvairaIdentityRegistry` | **59,502** | EIP-712 signature-verified agent execution wallet binding |
| `borrow` | `AvairaCreditMarket` | **69,941** | Score-gated USDC credit draw against posted collateral |
| `depositCollateral` | `AvairaCreditMarket` | **76,421** | Collateral deposit into the agent credit market |
| `slashWarning` | `AvairaStakeRegistry` | **95,493** | Level-1 slash (10% stake burn + score decay record) |
| `registerAgent` | `AvairaIdentityRegistry` | **128,622** | Mints ERC-8004 Identity NFT & escrows registration bond |
| `validationRequest` | `AvairaValidationRegistry` | **140,782** | Opens an ERC-8004 validation or appeal request |
| `validationResponse` | `AvairaValidationRegistry` | **141,305** | Finalizes validator verdict on-chain |
| `stake` | `AvairaStakeRegistry` | **146,322** | Stakes USDC collateral & activates gate eligibility |
| `giveFeedback` | `AvairaReputationRegistry` | **195,097** | Records payment-grounded feedback & updates reputation |
| `commitIntent` | `AvairaIntentVault` | **206,769** | Commits `intentHash` + `RiskEnvelope` pre-execution |

### Smart Contract Test Coverage (`123 Foundry Tests Passing`)

| Contract | Line Coverage | Statement Coverage | Function Coverage |
| :--- | ---: | ---: | ---: |
| [`MerkleLib.sol`](contracts/src/lib/MerkleLib.sol) | **100.00%** `(29/29)` | **97.62%** `(41/42)` | **100.00%** `(5/5)` |
| [`AvairaIdentityRegistry.sol`](contracts/src/core/AvairaIdentityRegistry.sol) | **98.56%** `(137/139)` | **94.83%** `(165/174)` | **96.97%** `(32/33)` |
| [`AvairaValidationRegistry.sol`](contracts/src/core/AvairaValidationRegistry.sol) | **97.47%** `(77/79)` | **93.20%** `(96/103)` | **100.00%** `(13/13)` |
| [`AvairaReputationRegistry.sol`](contracts/src/core/AvairaReputationRegistry.sol) | **95.65%** `(154/161)` | **92.16%** `(188/204)` | **93.10%** `(27/29)` |
| [`AvairaIntentVault.sol`](contracts/src/core/AvairaIntentVault.sol) | **93.38%** `(127/136)` | **91.44%** `(171/187)` | **95.00%** `(19/20)` |
| [`AvairaCreditMarket.sol`](contracts/src/core/AvairaCreditMarket.sol) | **91.21%** `(83/91)` | **87.79%** `(115/131)` | **92.31%** `(12/13)` |
| [`AvairaStakeRegistry.sol`](contracts/src/core/AvairaStakeRegistry.sol) | **90.24%** `(148/164)` | **87.14%** `(183/210)` | **90.91%** `(20/22)` |

---

## 🖥️ Protocol Control Center & Dashboard

The React 19 + Tailwind CSS + Radix UI control center ([`frontend/`](frontend/)) provides real-time visibility into agent telemetry, risk envelopes, execution lifecycles, underwriter pools, slashing events, and reputation heatmaps:

<div align="center">
<table>
  <tr>
    <td width="50%" align="center">
      <img src="verification/dashboard_v2.png" alt="Avaira Protocol Telemetry Dashboard" />
      <br />
      <sub><b>Protocol Overview & Real-Time Execution Telemetry</b></sub>
    </td>
    <td width="50%" align="center">
      <img src="verification/registry_v2.png" alt="Avaira Agent Registry & Score Badges" />
      <br />
      <sub><b>Agent Registry, Risk Envelopes & Avaira Score Grades</b></sub>
    </td>
  </tr>
</table>
</div>

### Control Center Modules (`frontend/src/pages/`)

- **Dashboard (`Dashboard.js`)** — Real-time agent fleet telemetry, active/frozen distribution, trust pool split, and one-click lifecycle simulation.
- **Agent Registry (`AgentRegistry.js`)** — Agent registration, collateral staking, Risk Envelope configuration, and live Avaira Score badges.
- **Execution Flow (`ExecutionFlow.js`)** — Step-by-step lifecycle trace from intent declaration and EIP-712 permit verification to settlement.
- **Underwriters (`Underwriters.js`)** — Human & institutional underwriter capital pools, mission backing, and `85 / 10 / 5` yield distribution.
- **Freeze & Slash (`FreezeSlash.js`)** — Automated circuit breaker console, deviation evidence inspection, and 50%/100% collateral slash execution.
- **Treasury (`Treasury.js`)** — Four-stream protocol revenue analytics (Registration SaaS, Underwriting Spread, Slashing Revenue, Data API).
- **Reputation (`Reputation.js`)** — Multi-factor Avaira Score breakdown, historical rank movement, and interactive `TrustHeatmap`.
- **Hardening Report (`HardeningReport.js`)** — Live security posture across OPA Rego rules, Nitro Enclave PCR0 attestation, and ZK Vault status.

---

## 🗂️ Repository Structure

```text
avaira.xyz/
├── setup.sh                          # One-command setup + self-verification (the fast path)
├── AGENTS.md                         # Setup instructions, permission manifest & playbook for AI agents
├── SETUP.md                          # Human setup guide: levels, flags, troubleshooting, optional stacks
├── tools/quickstart/server.py        # Zero-dependency browser Quickstart Console (used by --serve)
├── .devcontainer/                    # Codespaces/devcontainer — runs ./setup.sh on create
├── assets/
│   └── logo.png                      # Official Avaira brand mark
├── avaira_os/                        # Cognitive OS v5.0 — offline mathematical safety kernel
│   ├── kernel.py                     # Pillar A: Global Working Memory (7±2) & production rules
│   ├── reasoning.py                  # Pillar A: Mandatory System-2 ReasoningTrace planner
│   ├── memory_tiers.py               # Pillar B: L1/L2/L3 memory + artifact-gated belief graph
│   ├── world_model.py                # Pillar C: Interval SymbolicProver + 200× Monte-Carlo sandbox
│   ├── execution_gate.py             # Pillar D: Hardware attestation gate, atomic slash & EVM adapter
│   ├── agent_os.py                   # Pillar E: PLAN → PROVE → SIMULATE → EXECUTE DCG orchestrator
│   ├── events.py                     # Pillar E: Tamper-evident SHA-256 CognitiveLedger
│   └── demos.py                      # 4 deterministic proof artifacts (byte-identical transcripts)
├── contracts/                        # Foundry project — Monad & ERC-8004 smart contract suite
│   ├── src/core/                     # 6 core contracts (Identity, Reputation, Validation, Vault, Stake, Credit)
│   ├── src/interfaces/               # IERC8004 & IAvaira interfaces
│   ├── src/lib/                      # AvairaTypes & canonical MerkleLib
│   ├── script/Deploy.s.sol           # One-shot deterministic deployment & cross-contract wiring
│   ├── test/                         # 123 unit, fuzz, invariant & cross-language Merkle parity tests
│   ├── metrics/                      # Measured gas benchmarks (gas.json) & LCOV coverage report
│   └── legacy-hardhat/               # V1 Avalanche Fuji contracts preserved for provenance
├── sdk/                              # Multi-language developer SDKs
│   ├── typescript/                   # @avaira/sdk v2 (Viem, on-chain gate, Merkle audit trail)
│   ├── python/                       # avaira Python SDK v2 (Web3.py, RiskEnvelope, AuditTrail)
│   ├── avaira_shield/                # LangChain & CrewAI 2-line execution shield integrations
│   └── avaira-rust-core/             # High-performance Rust cryptographic & scoring primitives
├── services/
│   └── scorer/                       # Deterministic 6-component Avaira Score engine & canonical JSON
├── backend/                          # FastAPI Control Plane + Zero-Trust Execution Shield
│   ├── core/                         # OPA Rego rules, local SLM, TEE identity, ZK vault, SlashEngine
│   ├── grpc_server/                  # Rust tonic gRPC Trust Engine server
│   └── server.py                     # REST API endpoints, telemetry & simulation engine
├── frontend/                         # React 19 + Tailwind CSS + Shadcn/Radix UI Protocol Dashboard
├── deployments/                      # Canonical chain deployment manifests
├── docs/                             # Architecture Decision Records & Cognitive OS v5 specification
└── tests/                            # Python unit, integration & Cognitive OS test suites
```

---

## 📚 Documentation & References

- [**Setup Guide (`SETUP.md`)**](SETUP.md) — One-command setup, the four levels, doctor mode, what gets created, troubleshooting, and the optional control plane.
- [**Agent Setup Contract (`AGENTS.md`)**](AGENTS.md) — Machine-readable instructions so an AI agent can set the repo up unattended, including the permission manifest and expected outputs.
- [**Cognitive OS v5.0 Specification (`docs/cognitive-os-v5.md`)**](docs/cognitive-os-v5.md) — Formal verification chain, fail-closed invariants, and five-pillar kernel design.
- [**Security Architecture (`SECURITY.md`)**](SECURITY.md) — Tamper-evident intent logging, OPA + SLM shield pipeline, TEE attestation, and vulnerability disclosure.
- [**Security & Architecture Review (`REVIEW.md`)**](REVIEW.md) — Audit of the Zero-Trust execution pipeline, W3C Verifiable Credentials, and slashing mechanics.
- [**Chainless Trust Model (`CHAINLESS.md`)**](CHAINLESS.md) — Sub-50ms cryptographic hash-chain enforcement for off-chain enterprise deployments.
- [**SDK Integration Guide (`sdk/README.md`)**](sdk/README.md) — Quickstart guide for Python, TypeScript, LangChain, and CrewAI integrations.
- [**Changelog (`CHANGELOG.md`)**](CHANGELOG.md) — Release history and architectural milestones.
