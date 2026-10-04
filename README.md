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
[![CVI Gate](https://img.shields.io/badge/Cleanverse_CVI-CVA_Gate-00D4FF?style=for-the-badge)](contracts/src/core/AvairaComplianceGate.sol)

[**Overview**](#-why-avaira) •
[**3-Layer Architecture**](#-three-layer-architecture) •
[**Smart Contracts**](#-on-chain-protocol-monad--erc-8004) •
[**Pre-Execution Gate**](#-the-pre-execution-gate) •
[**Avaira Score**](#-the-avaira-score) •
[**Cognitive OS v5.0**](#-cognitive-os-v50--hardened-execution-kernel) •
[**SDK Quickstart**](#-sdk-quickstart) •
[**Benchmarks & Coverage**](#-gas-benchmarks--coverage) •
[**Workstreams**](#-hackathon-workstreams) •
[**Agent Adapters**](#-agent-adapters-workstreams-2-4) •
[**For Judges**](#-for-judges-reproduce-everything) •
[**Control Center**](#-protocol-control-center--dashboard)

</div>

---

## ⚡ Quickstart

```bash
git clone https://github.com/ranaalyan1/avaira.xyz && cd avaira.xyz

# 1. Install dependencies across contracts, SDKs and every service
make install

# 2. Run the verification suites (Foundry unit/fuzz/invariant + SDK + Scorer + all 4 services)
make test
python3 -m avaira_os.demos

# 3. Deploy the whole stack (6 core contracts + CVI gate + CVA token) on Monad Testnet 10143
make deploy-monad

# 4. Reproduce the four hackathon workstreams end to end
make demo-cvi-cva     # Workstream 1 — Cleanverse CVI/CVA gate, 4 scenarios
make demo-dynamic     # Workstream 2 — Dynamic embedded wallet → EIP-712 agent binding
cd services/perpl-bot && npm run demo:blocked && npm run demo:drawdown   # Workstream 3
make demo-qwen        # Workstream 4 — Qwen 3.8 Max treasury agent, 3 scenarios
```

> **Local-first by design.** Every demo runs against a local Anvil node with the Monad
> deployment manifest, so a reviewer can reproduce all four workstreams without a faucet,
> an API key or an internet connection. Set the env vars in `.env.example` files to point the
> same code at live endpoints.

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

## 🔐 Hackathon Workstreams

Four workstreams were built on top of the existing protocol. Each ships code, tests and a
reproducible demo; every claim below is reproducible with the command next to it.

### Workstream 1 — Cleanverse CVI/CVA compliance gate

**Identity is structurally coupled to asset movement.** A wallet-bound Cleanverse credential
(CVI) is verified on-chain, and the asset itself refuses to move without one — this is not an
optional wrapper an integrator can forget.

| Component | Path | What it does |
| :--- | :--- | :--- |
| Gate contract | [`contracts/src/core/AvairaComplianceGate.sol`](contracts/src/core/AvairaComplianceGate.sol) | Stores `mapping(address => CVICredential)` (wallet, credentialHash, expiry, status, issuer), verifies issuer-signed EIP-712 claims (`verifyCVI`, `verifyCVIWithExpiry`), revokes them (`revokeCVI`), and gates every CVA movement through `gateCVATransfer` / `tryGateCVATransfer`. Reverts `CVI_MISSING` / `CVI_EXPIRED` / `CVI_REVOKED` when **either** side lacks a valid credential (Travel Rule: originator *and* beneficiary). |
| Gated token | [`contracts/src/tokens/AvairaCVA.sol`](contracts/src/tokens/AvairaCVA.sol) | ERC-20 whose `_update` hook calls the gate on **every** mint, transfer and burn — an unverified holder cannot even receive CVA. |
| Pre-execution hook | [`contracts/src/core/AvairaIntentVault.sol`](contracts/src/core/AvairaIntentVault.sol) | `checkGate` now returns `CVI_UNVERIFIED` for intents whose `allowedActions` include `cva.transfer` / `cva.settle` while an involved wallet is unverified, adds `checkGateWithCVI` / `cviBlocker` / `requiresCVI` / `cvaActionsOf`, and emits `CVIRequirementChecked`. The six original contracts keep their external interfaces — this is additive. |
| Off-chain service | [`services/cvi/`](services/cvi/) | Node/TS service (`POST /verify`, `POST /revoke`, `GET /credential/:wallet`, `GET /status`) that calls the Cleanverse CCP API (`CLEANVERSE_APP_ID` / `CLEANVERSE_API_KEY`, never hardcoded) and submits the credential on-chain. Without CCP credentials it auto-enables a deterministic mock mode and labels every decision `mode: "mock"`. |
| Demo | [`scripts/demo-cvi-cva.ts`](scripts/demo-cvi-cva.ts) | Four scenarios: A→B verified↔verified (succeeds), verified→no-CVI (`CVI_MISSING`), expired credential (`CVI_EXPIRED`), and the same transfer through `avaira.run()` with `cva.transfer` allowed → gate blocks with `CVI_UNVERIFIED` and **`execute_fn` is never invoked**, followed by the recovery path after the credential is registered. |
| Dashboard | [`frontend/src/pages/Compliance.js`](frontend/src/pages/Compliance.js) | Per-wallet credential status, gated CVA movements (allowed *and* refused, with tx links), and the `CVIRequirementChecked` trace for `cva.*` intents. |

```bash
npx tsx scripts/demo-cvi-cva.ts --local                       # 4/4 scenarios, in-process issuer signing
npx tsx scripts/demo-cvi-cva.ts --local --via-service         # same, credentials registered over HTTP
cd contracts && forge test --match-contract "AvairaComplianceGate|AvairaIntentVaultCVI"
```

Coverage on the new gate contract: **99.06% lines / 96.45% statements / 100% branches**
(`forge coverage --report summary --ir-minimum --match-contract "AvairaComplianceGateTest|AvairaIntentVaultCVITest"`),
29 Foundry tests including fuzz cases for unverified pairs and exact expiry boundaries.

### Workstream 2 — Dynamic embedded wallets

Operators and underwriters authenticate with Dynamic and sign with an **embedded wallet** — no
browser extension, no seed phrase, no MetaMask requirement.

| Component | Path | What it does |
| :--- | :--- | :--- |
| SDK bootstrap | [`frontend/src/components/DynamicProvider.js`](frontend/src/components/DynamicProvider.js) | Mounts `DynamicContextProvider` only when `REACT_APP_DYNAMIC_ENV_ID` is set; without it the app degrades to static fallbacks instead of crashing. |
| Wallet adapter | [`frontend/src/lib/dynamicWallet.js`](frontend/src/lib/dynamicWallet.js) | Resolves a viem **or** ethers signer from any Dynamic connector, then runs the two operator flows. |
| Agent binding | [`frontend/src/components/DynamicAgentBinding.js`](frontend/src/components/DynamicAgentBinding.js) | Signs the EIP-712 `AgentWalletSet(agentId, newWallet, nonce, deadline)` authorisation with the embedded wallet and submits `AvairaIdentityRegistry.setAgentWallet` — the registry verifies it with `SignatureChecker`, so passkey/ERC-1271 accounts work too. Ownership is checked before signing so the failure is actionable. |
| Underwriter collateral | [`frontend/src/components/DynamicCollateralCard.js`](frontend/src/components/DynamicCollateralCard.js) | `approve` + `AvairaCreditMarket.depositCollateral` from the embedded wallet, then reads back the collateral position and tier ratio. |
| On-chain proof | [`scripts/demo-dynamic-binding.ts`](scripts/demo-dynamic-binding.ts) | Proves the flow without the hosted UI: a generated key stands in for the embedded wallet, the digest from viem's `hashTypedData` is compared byte-for-byte with `hashAgentWalletSet`, the wallet self-submits the binding, and the underwriter deposit lands. |

```bash
make demo-dynamic      # digest parity + setAgentWallet + depositCollateral on the local chain
cd services/dynamic && npm run typecheck
```

### Workstream 3 — Perpl trading bot, Avaira-gated

A grid market maker for the deepest Perpl pair ([`services/perpl-bot/`](services/perpl-bot/))
where **every cycle passes through `avaira.run()`** before a single order reaches the exchange.

- **Risk envelope per cycle** — `maxSpendUsd` = the cycle's quote budget, `allowedActions` =
  `perpl.quote` / `perpl.place_order` / `perpl.cancel_order` / `perpl.settle`, `deadline` = cycle end.
- **Hard caps** — position cap, minimum Avaira score (60), gas-aware sizing, and a drawdown
  kill-switch that halts the bot and files a `slashReport` with the evidence a slash would rest on.
- **Blocked ⇒ halted** — when the gate refuses, no order is placed, the reason is persisted and
  the bot refuses to quote again until a human clears it.
- **Restart-safe** — state and a JSONL journal (`STATE_FILE` / `JOURNAL_FILE`) re-adopt open orders.
- **Telemetry** — `GET /status` (port 8404) renders positions, PnL, gate decisions and the trade
  history with explorer links; every placement/cancel is journaled with its tx hash and spend.
- **Transport seam** — `PerplExchange` has a simulated implementation (tests, CI, offline demos)
  and `HttpPerplExchange` for the live DEX (`PERPL_MOCK=0`, `PERPL_API_URL`, `PERPL_API_KEY`).

```bash
cd services/perpl-bot
npm test                 # 9 tests: strategy, risk kernel, gate seam, restart safety
npm run demo:blocked     # allowed cycle → LOW_SCORE → 0 orders placed
npm run demo:drawdown    # kill-switch trips, halt + slash-report written
npm start                # live loop + /status on :8404
```

### Workstream 4 — Qwen 3.8 Max treasury agent

[`services/qwen-agent/`](services/qwen-agent/) runs an agent loop where **Qwen is the only
planner** (DashScope's OpenAI-compatible endpoint, `QWEN_MODEL` defaults to `qwen3.8-max`) and
**every tool call is a gated Avaira intent**. The model's plan is data, never authority.

- **Envelope policy** — a plan that asks for more than the cycle budget, or for an action outside
  the role envelope, is refused *before* anything is committed; `execute_fn` is never entered.
- **On-chain gate** — the committed intent is checked by `AvairaIntentVault` (identity, stake,
  score, deadline, and the Cleanverse CVI requirement for `cva.*`); a refusal stops the cycle.
- **Deviation + slash** — the agent's audit trail is hash-chained and its Merkle root anchored;
  a leaf that spends beyond the committed envelope is provable by anyone via `challengeDeviation`,
  which slashes the stake and pays the challenger's bounty.
- **Transcripts** — plan, per-step gate decision, spend, intent hash, tx hashes and Merkle roots
  land in `services/qwen-agent/transcripts/*.json`.

```bash
make demo-qwen                                       # (a) happy path, (b) blocked, (c) deviation
cd services/qwen-agent && npm test                   # 12 tests, including trail/deviation proofs
QWEN_API_KEY=... npm run live                        # live Qwen + live chain
```

---

## 🔌 Agent Adapters (Workstreams 2–4)

| Adapter | Identity | Execution | Gate |
| :--- | :--- | :--- | :--- |
| **Dynamic embedded wallet** (operator/underwriter) | Dynamic auth + embedded wallet | `setAgentWallet` (EIP-712), `depositCollateral` | `AvairaIdentityRegistry`, `AvairaCreditMarket` |
| **Perpl bot** (market maker) | ERC-8004 agent id | `perpl.place_order` / `cancel_order` inside `execute_fn` | every cycle through `avaira.run()` |
| **Qwen treasury agent** (planner) | ERC-8004 agent id + CVI | `cva.transfer` / `cva.settle` inside `execute_fn` | every tool call through `avaira.run()` |

All three share the same contract: **nothing executes until the gate says so, and a refusal
leaves an explorer-visible trace.**

---

## 🧾 For Judges: reproduce everything

**No faucet, no API key and no funded account are required for the four workstream demos.**
They run against a local Anvil node using the deployment manifest in
[`deployments/10143.json`](deployments/10143.json).

```bash
# 1. chain + services (3 terminals)
anvil --host 127.0.0.1 --port 8546 --chain-id 10143 --block-time 1
cd contracts && DEPLOYER_PRIVATE_KEY=$ANVIL_KEY CLEANVERSE_ISSUER_PRIVATE_KEY=$ANVIL_KEY   DEPLOYMENT_DIR=../deployments forge script script/Deploy.s.sol:DeployAvaira \
  --rpc-url http://127.0.0.1:8546 --broadcast --private-key $ANVIL_KEY
cd services/cvi && CHAIN_ID=10143 AVAIRA_RPC_URL=http://127.0.0.1:8546 CLEANVERSE_MOCK=1   CLEANVERSE_ISSUER_PRIVATE_KEY=$ANVIL_KEY setsid npx tsx src/index.ts serve   # :8403

# 2. the four workstream demos
npx tsx scripts/demo-cvi-cva.ts --chain 10143 --via-service
npx tsx scripts/demo-dynamic-binding.ts --chain 10143
cd services/perpl-bot && npm run demo:blocked && npm run demo:drawdown
cd services/qwen-agent && npx tsx src/index.ts demo --chain
```

### Test credentials

These are the **public Anvil development keys** — they are printed by every Anvil boot and hold
no value on any network. They exist here so the demos are runnable in one command:

| Role | Address | Private key (Anvil #0–#4) |
| :--- | :--- | :--- |
| Deployer / admin / treasury | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Operator B (challenger) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| Operator C | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| Demo issuer (CVI signer) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |
| Expired-credential wallet | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` | `0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e` |

**Pre-funded agent setup:** `Deploy.s.sol` seeds the deployer with a CVI credential and CVA
balance, and each demo bootstraps what it needs — register → stake (`MIN_STAKE_USDC`) → score
(78) → CVI credential → CVA balance — before trading. `services/qwen-agent/src/setup.ts` and
`scripts/demo-cvi-cva.ts` show the exact sequence (`ensureAgentReady` / `registerCVIFor`).

### Live deployment (Monad testnet 10143)

`make deploy-monad` writes `deployments/10143.json`; the SDK, dashboard, CVI service and every
demo read that one file. Deployed addresses for the current manifest:

| Contract | Address |
| :--- | :--- |
| `AvairaIdentityRegistry` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| `AvairaReputationRegistry` | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| `AvairaValidationRegistry` | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| `AvairaStakeRegistry` | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| `AvairaIntentVault` | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| `AvairaCreditMarket` | `0x0165878A594ca255338adfa4d48449f69242Eb8F` |
| `AvairaComplianceGate` (new) | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` |
| `AvairaCVA` (new) | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| settlement token | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |

### Honest verification status

This build environment has **no outbound access** to Monad's public RPC, `api.perpl.xyz`,
DashScope or `app.dynamic.xyz`, and no funded key. What that means for each acceptance
criterion — stated rather than glossed over:

| Verified here (reproducible) | Requires live credentials |
| :--- | :--- |
| CVI/CVA gating, all four scenarios, on a real chain (local node, chain id 10143) — txs, receipts, events | Cleanverse CCP calls against `api.cleanverse.com` (the service's mock mode is labelled `mode: "mock"`; the live path is one env var away and unexercised here) |
| EIP-712 agent-wallet binding + digest parity with the contract, and underwriter collateral deposit | Dynamic's hosted auth UI (`REACT_APP_DYNAMIC_ENV_ID`); the on-chain half it produces is proven by the demo |
| Perpl bot: every cycle gated, blocked cycle halts, drawdown kill-switch, restart safety, `/status` | Live Perpl order placement (the `HttpPerplExchange` transport is written to the published `<48h` API surface but has not been run against it) |
| Qwen agent: happy path → Merkle root anchored on-chain, blocked spend with `execute_fn` never invoked, deviation challenge → slash + bounty (stake `100000000 → 50000000`) | Live Qwen 3.8 Max inference (`QWEN_API_KEY`); the offline planner exercises the identical gate/execution/transcript path and is labelled `planner: "offline"` in every transcript |
| `make test`: Foundry suite + SDK + scorer + all four services | — |

Transcripts written by the demos are checked in under
`services/{cvi,dynamic,perpl-bot,qwen-agent}/transcripts/`, and every one names the planner,
exchange and gate mode it ran with.

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

All metrics are measured from real Foundry test and benchmark runs stored in [`contracts/metrics/gas.json`](contracts/metrics/gas.json), [`contracts/metrics/coverage.txt`](contracts/metrics/coverage.txt) and — for the Workstream 1 contracts — [`contracts/metrics/coverage-workstreams.txt`](contracts/metrics/coverage-workstreams.txt). Reproduce at any time with `make benchmark` and `cd contracts && make coverage`.

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

### Smart Contract Test Coverage (`AvairaComplianceGate` measured with `--ir-minimum`)

| Contract | Line Coverage | Statement Coverage | Function Coverage |
| :--- | ---: | ---: | ---: |
| [`MerkleLib.sol`](contracts/src/lib/MerkleLib.sol) | **100.00%** `(29/29)` | **97.62%** `(41/42)` | **100.00%** `(5/5)` |
| [`AvairaIdentityRegistry.sol`](contracts/src/core/AvairaIdentityRegistry.sol) | **98.56%** `(137/139)` | **94.83%** `(165/174)` | **96.97%** `(32/33)` |
| [`AvairaValidationRegistry.sol`](contracts/src/core/AvairaValidationRegistry.sol) | **97.47%** `(77/79)` | **93.20%** `(96/103)` | **100.00%** `(13/13)` |
| [`AvairaReputationRegistry.sol`](contracts/src/core/AvairaReputationRegistry.sol) | **95.65%** `(154/161)` | **92.16%** `(188/204)` | **93.10%** `(27/29)` |
| [`AvairaIntentVault.sol`](contracts/src/core/AvairaIntentVault.sol) | **93.38%** `(127/136)` | **91.44%** `(171/187)` | **95.00%** `(19/20)` |
| [`AvairaCreditMarket.sol`](contracts/src/core/AvairaCreditMarket.sol) | **91.21%** `(83/91)` | **87.79%** `(115/131)` | **92.31%** `(12/13)` |
| [`AvairaStakeRegistry.sol`](contracts/src/core/AvairaStakeRegistry.sol) | **90.24%** `(148/164)` | **87.14%** `(183/210)` | **90.91%** `(20/22)` |
| [`AvairaComplianceGate.sol`](contracts/src/core/AvairaComplianceGate.sol) (Workstream 1) | **99.06%** `(105/106)` | **96.45%** `(136/141)` | **80.00%** `(24/30)` |
| [`AvairaIntentVault.sol`](contracts/src/core/AvairaIntentVault.sol) — CVI hook only | **62.12%** `(123/198)` | **58.33%** `(161/276)` | **25.86%** `(15/58)` |

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
- **Compliance (`Compliance.js`)** — **Workstream 1**: per-wallet Cleanverse CVI credential status, every gated CVA movement (allowed *and* refused with the revert reason), and the `CVIRequirementChecked` trace for `cva.*` intents.
- **Hardening Report (`HardeningReport.js`)** — Live security posture across OPA Rego rules, Nitro Enclave PCR0 attestation, and ZK Vault status.

---

## 🗂️ Repository Structure

```text
avaira.xyz/
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
│   ├── src/core/                     # 6 core contracts + AvairaComplianceGate (Workstream 1)
│   ├── src/tokens/                   # MockUSDC + AvairaCVA (CVI-gated asset)
│   ├── src/interfaces/               # IERC8004 & IAvaira interfaces
│   ├── src/lib/                      # AvairaTypes & canonical MerkleLib
│   ├── script/Deploy.s.sol           # One-shot deterministic deployment & cross-contract wiring
│   ├── test/                         # Unit, fuzz, invariant & cross-language Merkle parity tests (CVI gate: 29)
│   ├── metrics/                      # Measured gas benchmarks (gas.json) & LCOV coverage report
│   └── legacy-hardhat/               # V1 Avalanche Fuji contracts preserved for provenance
├── sdk/                              # Multi-language developer SDKs
│   ├── typescript/                   # @avaira/sdk v2 (Viem, on-chain gate, Merkle audit trail)
│   ├── python/                       # avaira Python SDK v2 (Web3.py, RiskEnvelope, AuditTrail)
│   ├── avaira_shield/                # LangChain & CrewAI 2-line execution shield integrations
│   └── avaira-rust-core/             # High-performance Rust cryptographic & scoring primitives
├── services/
│   ├── scorer/                       # Deterministic 6-component Avaira Score engine & canonical JSON
│   ├── cvi/                          # Workstream 1 — Cleanverse CCP client + CVI credential service (:8403)
│   ├── dynamic/                     # Workstream 2 — Dynamic embedded-wallet binding demo + config
│   ├── perpl-bot/                    # Workstream 3 — Avaira-gated Perpl grid bot + /status (:8404)
│   └── qwen-agent/                   # Workstream 4 — Qwen 3.8 Max treasury agent + gated tool loop
├── backend/                          # FastAPI Control Plane + Zero-Trust Execution Shield
│   ├── core/                         # OPA Rego rules, local SLM, TEE identity, ZK vault, SlashEngine
│   ├── grpc_server/                  # Rust tonic gRPC Trust Engine server
│   └── server.py                     # REST API endpoints, telemetry & simulation engine
├── frontend/                         # React 19 + Tailwind CSS + Shadcn/Radix UI Protocol Dashboard
├── scripts/                          # Workstream demos (CVI/CVA, Dynamic binding) + metrics collectors
├── deployments/                      # Canonical chain deployment manifests
├── docs/                             # Architecture Decision Records & Cognitive OS v5 specification
└── tests/                            # Python unit, integration & Cognitive OS test suites
```

---

## 📚 Documentation & References

- [**Cognitive OS v5.0 Specification (`docs/cognitive-os-v5.md`)**](docs/cognitive-os-v5.md) — Formal verification chain, fail-closed invariants, and five-pillar kernel design.
- [**Security Architecture (`SECURITY.md`)**](SECURITY.md) — Tamper-evident intent logging, OPA + SLM shield pipeline, TEE attestation, and vulnerability disclosure.
- [**Security & Architecture Review (`REVIEW.md`)**](REVIEW.md) — Audit of the Zero-Trust execution pipeline, W3C Verifiable Credentials, and slashing mechanics.
- [**Chainless Trust Model (`CHAINLESS.md`)**](CHAINLESS.md) — Sub-50ms cryptographic hash-chain enforcement for off-chain enterprise deployments.
- [**SDK Integration Guide (`sdk/README.md`)**](sdk/README.md) — Quickstart guide for Python, TypeScript, LangChain, and CrewAI integrations.
- [**Changelog (`CHANGELOG.md`)**](CHANGELOG.md) — Release history and architectural milestones.
