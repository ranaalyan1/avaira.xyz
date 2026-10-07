# STATE — what is verified in this tree, and what is not

> **This file is a claim ledger, not a changelog.** Every "verified" row below names the artifact that
> proves it and the command that regenerates it. Snapshot date **2026-10-07**, branch
> `arena/45b80b29-avaira-xyz`, build digest `0x82c39979892b7894…` (`sha256` of
> `build/avaira/artifacts.json`; `make doctor` prints the live one and fails if a report disagrees).
>
> If you are an auditor: start at [`audit/README.md`](audit/README.md), then
> [`FINDINGS.md`](FINDINGS.md). If you are reviewing the PR: [`SCOPE_PROPOSALS.md`](SCOPE_PROPOSALS.md)
> explains why each file is here.

## Verified — with the artifact and the command

| Claim | Evidence | Reproduce |
| --- | --- | --- |
| The six core contracts and two libraries compile with the profile `foundry.toml` declares | `build/avaira/build-manifest.json` — solc-js 0.8.37, `viaIR: true`, Cancun, 200 runs, `matchesFoundryProfile: true`, 22 artifacts, 94-entry error catalog | `make compile` |
| On-chain, off-chain Python and off-chain TypeScript agree **byte-for-byte** on canonical JSON, envelope hash and intent hash | [`verification/reports/parity.json`](verification/reports/parity.json) — 42 vectors × 3 artifacts, all identical; `rust: skipped` (no cargo in this environment) | `make parity` |
| Those parity vectors actually discriminate: a swapped leaf or a tampered root fails | `negativeControls` in the same report (`correctProofVerifies: true`, `swappedLeafFails: true`, `tamperedRootFails: true`) | `make parity` |
| The unbounded `challengeWindow` footgun is closed | `MAX_CHALLENGE_WINDOW = 3650 days` enforced in the constructor **and** `setChallengeWindow` (`ChallengeWindowTooLarge`), a deploy-time `require` in `Deploy.s.sol`, and a red-team scenario that tries the >68-year config at deploy time | `make redteam`, [`FINDINGS.md`](FINDINGS.md) AV-001 |
| Grade bands off-chain == grade bands on-chain (A+ ≥90 / A ≥80 / B ≥70 / C ≥60 / D) | `gradeOfScore` in `AvairaReputationRegistry.sol` is the source of truth; `services/scorer/src/formula.ts` matches it; `services/scorer/test/grade-parity.test.ts` pins it; red-team scenario `AV-009` checks the on-chain table | `make test-scorer redteam` |
| `intentHash` now contains the full canonicalised task (the legacy 7-field ABI form was forgeable) | 7 of 10 parity corpus intents hash differently under the legacy rule — documented in [`PARITY.md`](PARITY.md), pinned by red-team `AV-013` | `make redteam` |
| No invariant of the 12 machine-checked invariants is violated by a random walk through the state machine | [`verification/reports/campaign.json`](verification/reports/campaign.json): 4 shards × 500 sequences × 12 ops = **2,000 sequences**, **32,036 calls** (12,880 reverted — every revert decoded, 100% named), **40,547 invariant evaluations**, **0 violations**; `invariantsNeverEvaluated: []` | `make fuzz` (~15 min on 2 cores) |
| Those numbers come from real bytecode on a Cancun EVM, not a mock | each shard report embeds `build.sourceDigest`, `viaIR: true`, and `invariantEvaluationsById` (so a "checked" invariant with 0 evaluations is visible) | `make fuzz && python3 tools/doctor.py` |
| The 12 named attacks behave exactly as `FINDINGS.md` says — including the two we did **not** fix | [`verification/reports/redteam.json`](verification/reports/redteam.json): 12/12 expectations matched; `AV-002` (stale oracle price) and `AV-005` (validator refund grief) are **exploit-confirmed by design** and recorded as accepted risk | `make redteam` |
| The whole lifecycle works end-to-end on a local chain and the trace is exactly what we published | `python3 tools/demo.py --check` diffs against [`verification/reports/demo-expect.txt`](verification/reports/demo-expect.txt) — committed, byte-compared, no timestamps inside | `make demo-check` |
| The SDK surface the README documents exists | `make test-sdk` — `sdk/typescript` 31/31 + `tsc --noEmit` clean; `sdk/python` exercised through the same 42 parity vectors and the demo | `make test-sdk` |
| The docs do not lie about the contracts | `make doctor` — 11 checks: every cited path exists, every Makefile target referenced exists, every `INV-*` id in the audit docs is evaluated somewhere (12 of 18 by the campaign), every `AV-*` finding has a scenario or a test, reports match the build, and no absolute security claim sits outside an allowlist | `make doctor` |
| `make install` works on a PEP 668 system and without the gateway | retry with `--break-system-packages`, then a venv hint; `services/gateway` warns and skips instead of failing the install | `make install` |

**126 Solidity test functions** exist under `contracts/test/` (124 in unit/module tests + 2 invariant
tests). They need `forge`, which is **not installed in this sandbox** — CI runs them on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)); this file claims nothing about them beyond
"they exist and CI runs them", because I will not write "passing" for a suite I did not execute here.

## Not verified — read this column before you trust the other one

| What | Status | Where it is tracked |
| --- | --- | --- |
| The gate's *economic* parameters (0.55 `minScore`, `minStakeUsd`, `scoreDecayDays`, `maxBlockAge`) | **Zero adversarial testing.** `checkGate` is never invoked in the entire repo outside its own definition — not in tests, not in the campaign, not in the SDK. The mechanism is verified; the numbers are judgement. | [SP-01](SCOPE_PROPOSALS.md) (my recommendation: *do* this next), `AV-012` |
| The gateway service | **Does not exist in this tree** (`services/` contains `scorer` only). Every README sentence about `/execute`, HMAC replay guards and circuit breakers describes code that is not here. | [SP-02](SCOPE_PROPOSALS.md) |
| Oracle liveness / staleness | `latestRoundData()` is read with no `updatedAt` or `answeredInRound` check. Accepted risk with a documented blast radius, not a fix. | `AV-002`, [RISK_REGISTER.md](audit/RISK_REGISTER.md) |
| Token flow vs ledger | The harness deploys `MockUSDC`, mints and approves for real, but **no invariant ties a payment to the ledger entry it produced** — `usdc_balance()` exists in `harness.py` and is simply not used by the campaign. The credit-market rounding property *is* checked (`INV-CREDIT-02` / `AV-006`); the accounting hole next to it is not. | [INVARIANTS.md](audit/INVARIANTS.md) (declared gap) |
| Rust parity | Reported as `skipped`, never as passing. There is **no v2 Rust crate**: `sdk/avaira-rust-core` predates v2 and cannot express an v2 commitment, so `compare.py` only runs `cargo test` there if cargo *and* `sdk/avaira-rust-core/tests/parity.rs` exist. Neither is true here. | `AV-014`, [SP-03](SCOPE_PROPOSALS.md) |
| Gas, latency, throughput | The py-evm harness measures correctness only; it is ~100× slower than a node and its timings are meaningless. Gas numbers live in `contracts/test/benchmark/GasBenchmark.t.sol` and require a real toolchain. | [tools/README.md](tools/README.md) |
| Symbolic / formal verification | None. No Certora, no Halmos, no `prover`. Every claim here is execution-based; a `PASS` is a statement about 32,036 sampled transitions, not a proof over all of them. | — |
| Any deployment | Nothing is deployed. `audit/DEPLOYMENT.md` records how to deploy and what to check first; it contains no addresses because we have none. | [DEPLOYMENT.md](audit/DEPLOYMENT.md) |
| An independent audit | This package is self-adversarial (two teams in one repo). It is **not** a third-party audit and does not claim to be. | — |

## Where the bodies are

```
audit/                     README · THREAT_MODEL · INVARIANTS · RISK_REGISTER · DEPLOYMENT
  specs/                   12 generated contract/module specs — `python3 tools/gen_contract_specs.py --check`
FINDINGS.md                AV-001 … AV-015, each: severity, status, PoC, replay command, fix or refusal
PARITY.md                  the canonical-byte rule, in one table, with the three artifacts that agree on it
verification/
  README.md                how to reproduce every report, and which report came from which build
  reports/                 campaign.json · campaign-shard-*.json · redteam.json · parity.json · demo-expect.txt
  reports are committed on purpose — they are the evidence, and `make doctor` fails if they go stale
tools/avaira_evm/          harness (py-evm @ Cancun) · campaign (invariant fuzzer) · attacks (12 PoCs) · reverts
tools/                     compile.mjs · doctor.py · demo.py · aggregate_campaigns.py · gen_contract_specs.py · parity/
```

Two conventions worth knowing before you file something as a bug:

1. **A finding we chose not to fix stays in `FINDINGS.md`** with `Status: accepted risk` and the reason.
   `AV-004` (a zero Merkle root passes `MerkleLib.verify`) is the deliberate one: a `require(root != 0)`
   would block nothing that matters and buy theatre. The single empty leaf is a property of the hash
   chain, and the scenario asserting it stays green so we cannot forget it.
2. **Nothing here prints "clean".** `make fuzz` prints evaluations, not assurances; `make doctor`
   counts warnings; the campaign fails if an invariant it declares is never evaluated — a decorative
   invariant is worse than none, because it launders an assumption into a checklist.
