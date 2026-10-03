# Avaira — Monad-native accountability layer for the agent economy

x402 lets agents **pay**. ERC-8004 lets agents **be identified**. Avaira makes them
**accountable in real time** — a credit bureau and a circuit breaker for autonomous agents,
enforced before they act rather than audited after the damage.

> **Gate latency, measured on Monad testnet: see [`metrics/`](metrics/).**
> The pre-execution gate is a free `eth_call`; it is only *possible* because Monad
> finalises fast enough for a gate to land before execution instead of 12 seconds after it.

```bash
git clone https://github.com/ranaalyan1/avaira.xyz && cd avaira.xyz
make install          # deps for contracts, SDK and services
make test             # 127 Foundry tests + SDK/scorer suites, all green
make deploy-monad     # deploy + verify the whole stack (needs a funded Monad key)
make gateway          # score API, latency API and dashboard on :8402
make demo-heist       # 3-minute "The Agent Heist" scenario, end to end
```

---

## What is onchain

Six contracts, deployed to Monad testnet, verified on MonadScan/Sourcify. Addresses live in
[`deployments/10143.json`](deployments/) and are written by the deploy script — the SDK,
scorer, gateway and dashboard all read that one file.

| # | Contract | What it does | ERC-8004 |
|---|----------|--------------|----------|
| 1 | `AvairaIdentityRegistry` | Agent identity as a bond-backed NFT; URI, metadata, `agentWallet`, ban/exit, pull-based refund escrow | ERC-8004 Identity |
| 2 | `AvairaReputationRegistry` | Sybil-**grounded** feedback and the anchored 0–100 Avaira Score with grades A+…D | ERC-8004 Reputation |
| 3 | `AvairaValidationRegistry` | Request/response validation with registered validators, tags and finalisation | ERC-8004 Validation |
| 4 | `AvairaIntentVault` | **Proof-of-Intent**: commit `keccak256(plan)` + a risk envelope, gate it pre-execution, anchor the outcome Merkle root, and let anyone prove a deviation | Avaira |
| 5 | `AvairaStakeRegistry` | USDC stake, eligibility, slashing ladder (WARNING / SUSPENSION / BAN), suspension cooldown, reactivation | Avaira |
| 6 | `AvairaCreditMarket` | Score-gated credit: collateral ratios of 110% / 125% / 150% by grade, liquidation, so a slash immediately shrinks borrowing capacity | Avaira |

### The gate

```
        commitIntent                     checkGate                  execute_fn
 agent ───────────────▶ Monad ────────▶ free eth_call ◀────────── agent
   (fire & forget)        │              (allow | block)
                          │                    │ allowed
                          │                    ▼
                          └──── attestOutcome(outcomeHash, merkleRoot) ──▶ 24h challenge window
                                            │
                        anyone with a leaf + proof ──▶ challengeDeviation ──▶ slash + bounty
```

* **One commitment = one execution.** `intentHash` covers the full plan and the envelope.
* **The envelope is enforceable**: `maxSpendUsd`, `allowedActions`, `deadline` are committed
  onchain, and `checkGate(agentId, intentHash, envelopeHash)` rejects a mismatch.
* **Blocked agents never execute.** `run()` returns `"blocked"` with the onchain reason and
  `execute_fn` is not called — not "called and then rolled back".
* **Deviations are provable, not alleged.** The audit trail stays local (throughput, privacy);
  its Merkle root goes onchain. A leaf built by the SDK verifies against the rooted tree in
  Solidity — asserted in `contracts/test/MerkleParity.t.sol`, which reads vectors generated
  by the TypeScript SDK. If either implementation drifts, the build fails.

### The score

Six weighted components, all recomputable by a stranger from public chain data:

| Component | Weight | Source |
|---|---|---|
| SuccessRate | 30 | attested vs. unfulfilled/intents with upheld deviations |
| Consistency | 20 | spread of success rate across four time windows |
| SlashHistory | 20 | severity-weighted, 45-day half-life decay |
| VolumeHandled | 15 | log-scaled grounded settlement volume |
| AgeOnNetwork | 10 | seconds since ERC-8004 registration |
| AppealWinRate | 5 | appeals won via validation responses tagged `appeal` |

Caps, not weights, enforce eligibility: banned ⇒ 0, suspended ⇒ ≤55, stake below the
minimum or a deviation upheld in the last 24h ⇒ ≤59 (below the gate floor). **Stake buys
entry into the system, never points** — nothing in the score can be bought.

Grades are preserved from the offchain Avaira OS scorer: **A+ ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60,
D below**. `C` is exactly the gate's floor, so "grade C or better" and "the gate lets you
act" are the same sentence.

---

## Components

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: 6 contracts, 127 tests (unit + fuzz + invariants), gas benchmark |
| `sdk/typescript/` | `@avaira/sdk` v2 — `avaira.run(task, execute_fn)`, onchain gate, verifiable audit trail, latency telemetry |
| `sdk/python/` | Python SDK v2 — the same gate for Python agents (LangChain/CrewAI adapters included) |
| `services/scorer/` | Avaira Score computation + two-pass adversarial Kimi audit + onchain anchoring |
| `services/gateway/` | REST API (scores, slash feed, Merkle verification, latency metrics) and the dashboard |
| `dashboard/` | Single-page dashboard: leaderboard, slash feed, Merkle verifier, live gate latency |
| `demo/` | "The Agent Heist" — the 3-minute scenario, runnable locally |
| `docs/` | Architecture, threat model, write-up |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit, and why the trail stays offchain
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — what an adversarial agent can and cannot do
- [`docs/WRITEUP.md`](docs/WRITEUP.md) — the submission write-up
- [`docs/METRICS.md`](docs/METRICS.md) — every number, how it was measured, and how to reproduce it
- [`contracts/README.md`](contracts/README.md) — deploy, verify and gas instructions

## Provenance

Avaira v1 was an offchain "Cognitive OS" for agents (risk envelopes, the 0–100 score, hash-chained
audit trails, a two-pass LLM auditor, the `avaira.run()` API). v2 keeps those primitives and moves
the trust to Monad: the score, the stake, the gate and the credit are onchain, and the audit trail
became a Merkle commitment that `challengeDeviation` can act on. The v1 contracts deployed to
Avalanche Fuji are preserved under [`contracts/legacy-hardhat/`](contracts/legacy-hardhat/) for
reference.


