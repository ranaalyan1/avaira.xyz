# Avaira v2 — audit package

Prepared for: independent protocol audit, pre-TGE / pre-mainnet deploy.
Repository: `ranaalyan1/avaira.xyz` · commit under audit: see `STATE.md`.

## What was audited

| Layer | Artifacts | Where |
| --- | --- | --- |
| EVM (Solidity 0.8.37, Foundry) | `contracts/src/core/*.sol` + `contracts/src/lib/*.sol` + `mocks/MockUSDC.sol` | [`specs/`](specs/) — one file per contract, generated from the build manifest + NatSpec |
| Scorer service (TypeScript) | `services/scorer/src/{formula,canonical,types}.ts` | [`specs/scorer-service.md`](specs/scorer-service.md) |
| SDKs | `sdk/typescript/src`, `sdk/python/avaira`, `sdk/avaira-rust-core` | [`specs/sdk-surface.md`](specs/sdk-surface.md) |
| Deployment | `contracts/script/Deploy.s.sol`, `contracts/test/*` | [`DEPLOYMENT.md`](DEPLOYMENT.md) |

**In scope:** all six protocol contracts plus the libraries; the cross-layer surface (contract ↔
contract, contract ↔ SDK, contract ↔ service) because Avaira's claims are cross-layer properties —
an audit that stops at the Solidity boundary cannot check them.

**Out of scope (declared, not hidden):** the USDC the market trades in is `MockUSDC` in every test
we ran; the `Move` artifact named in the project brief **does not exist in this repository**
(Monad is EVM-compatible; the contracts are Solidity — see `SCOPE_PROPOSALS.md#SP-04`);
`sdk/avaira-rust-core` is pre-v2 and is reported as `skipped` by the parity harness rather than
as passing ([AV-014](../FINDINGS.md#av-014)).

## How to reproduce every number in this package

```bash
make install-verification   # python deps for the EVM harness (web3, eth-tester, py-evm)
make check     # SDK + scorer suites, solc-js compile, redteam, parity, demo trace, doctor
make redteam   # 12 attack scenarios against the compiled bytecode -> verification/reports/redteam.json
make fuzz      # campaign matrix, 4 seeds x 500 sequences x 12 ops (~11 min on 2 cores)
make parity    # 42 vectors x 3 artifacts, byte-identical -> verification/reports/parity.json
make demo      # end-to-end lifecycle on a local chain; --check diffs the committed golden trace
make specs     # regenerate audit/specs/* from the build (ABI, selectors, errors, sizes)
make doctor    # repo self-consistency: claims vs checks (CI gate)
make verify    # everything above except `make fuzz`, and it fails if audit/specs is stale

# Foundry's own suite needs forge (not installed in every sandbox, so `make check` does not call it):
cd contracts && forge test -vvv
```

`make redteam`, `make parity`, `python3 tools/demo.py --check`,
`python3 tools/gen_contract_specs.py --check` and `make doctor` are
exit-code gates: **if the code and the docs disagree, CI fails.** That is the design of this
package — the claims below are not prose we hope stays true. See
[`../verification/README.md`](../verification/README.md) for which report was produced from which
build digest.

## What we did (method)

1. **Threat model first** ([`THREAT_MODEL.md`](THREAT_MODEL.md)): six attacker classes, their
   capabilities and their cheapest wins, written *before* the fuzzing, so the campaigns had
   targets rather than only random walks.
2. **Invariants, numbered and named** ([`INVARIANTS.md`](INVARIANTS.md)): each invariant states
   the assertion **and** what passing it is worth. Every invariant is machine-checked on every
   fuzzed state; nothing in that file is aspirational.
3. **Deterministic campaign matrix** — `tools/avaira_evm/campaign.py` (py-evm + web3.py,
   4 seeds × 500 sequences × 12 ops in `make fuzz`, more in the nightly workflow;
   fixed seeds, so no wall-clock dependence and no flakiness).
4. **Hand-written attacks** — `tools/avaira_evm/attacks.py`, one scenario per finding, each with a
   declared expectation (fixed-guard stays red / documented-risk stays explorable).
5. **Cross-language parity** — `tools/parity/`: one pinned corpus, every artifact re-derives it.
6. **Docs and interfaces** — every finding below links to its proof.

## Findings summary

See [`../FINDINGS.md`](../FINDINGS.md). One-line version:

* **Fixed (5):** AV-003 spend cap could be switched off by the cap; AV-007 one admin call DoS'd all
  attestations; AV-009 grade bands differed between chain and our own scorer for 30 of 101 scores;
  AV-013 **two SDKs computed different `intentHash` values for the same intent**; AV-015 the scorer service's canonical
  encoder reordered integer-like keys.
* **Mitigated (1):** AV-010 a terminal BAN could fail to propagate silently.
* **Accepted risks, documented (3):** AV-002 unstake-before-challenge escapes slashing;
  AV-004 attestation over a fabricated root; AV-005 bounty race.
* **Attempted and refuted (5):** AV-001, AV-006, AV-008, AV-011, AV-012 — kept as scenarios so the
  guards that make them safe cannot be quietly removed.
* **Open (1):** AV-014, the Rust core — a scope decision, not a defect in the shipped path.

## Residual risk register

[`RISK_REGISTER.md`](RISK_REGISTER.md) — R-01…R-09 with owner, treatment and review trigger.
Nothing in this package claims the protocol is safe; it claims these specific properties hold,
under these assumptions, and here is how to re-check that in under ten minutes.
