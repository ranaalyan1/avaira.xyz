# Risk register

The register is the other half of the audit package: `FINDINGS.md` says what the code does today,
this says what we are **still exposed to** and who owns it. A risk is only closed when either the
code changes or the document that accepts it is reviewed by the named owner.

Likelihood/impact are qualitative (L/M/H). "Treatment" is one of **mitigate / accept / transfer / avoid**,
and every row names the artifact that carries it, so nobody has to guess whether a risk is real.

| id | risk | likelihood | impact | treatment | owner | carried by | review trigger |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-01 | **Stake can exit before the challenge window closes**, so a caught agent pays nothing (AV-002) | H | H | **accept, pending product decision** — an exit delay or slash-escrow changes the capital model | protocol lead | `FINDINGS.md#av-002`, `THREAT_MODEL.md#t1`, SP-01 | any change to `challengeWindow` policy; any mainnet TVL target > $0 |
| R-02 | **Attestation is self-selected**: an agent anchors whatever tree it likes, and a challenger against an omitted leaf forfeits its bond (AV-004) | H | M | **accept** — inherent to a hash-commitment model; `outcomeHash` binding proposed (SP-02) | protocol lead | `FINDINGS.md#av-004`, `THREAT_MODEL.md#t2`, `INV-INTENT-01` | if a Merkle-Accumulator / history-boundary design lands |
| R-03 | **Bounty sniping**: copying a whistleblower's calldata wins the bounty (AV-005) | M | M | **accept** — first-upheld-wins is the anti-fabrication property; queue proposed (SP-03) | protocol lead | `FINDINGS.md#av-005`, `THREAT_MODEL.md#t2` | bounty value > gas cost by a wide margin |
| R-04 | **Admin keys are unilateral**: no timelock, no multisig requirement, roles can set treasury/min-stake/window (T3) | L | H | **mitigate partially** — window bound + deploy-time asserts; SP-05 (timelock + roles in a manager) is open | ops | `THREAT_MODEL.md#t3`, `DEPLOYMENT.md` pre-flight, G-03 | before any mainnet deploy |
| R-05 | **Reputation Sybil via coordinated grounded feedback** — a ring of staked reviewers can move a score | M | M | **accept, monitored** — grounding costs real USDC per reviewer; volume weighting proposed (SP-07) | scorer lead | `THREAT_MODEL.md#t5`, `INV-REP-01/02` | any dashboard that displays `feedbackCount` without unique-reviewer context |
| R-06 | **BAN propagation depends on wiring**: if `identityRegistry.setEnforcer(stake)` is skipped, banned agents stay `isActive` (AV-010) | L | H | **mitigated** — deploy assert + harness precondition + `BanPropagationFailed` event | ops | `DEPLOYMENT.md` pre-flight, `FINDINGS.md#av-010` | any new registry added to the stack |
| R-07 | **Real-token behaviour untested** — everything runs on `MockUSDC` (G-01) | M | H | **mitigate before mainnet** — fork test against real USDC on Monad mainnet | protocol lead | `THREAT_MODEL.md#t7`, `DEPLOYMENT.md` pre-flight | any token other than 6-decimal USDC becoming the settlement asset |
| R-08 | **`breakdownHash` has no on-chain verifier** — the anchor is only as good as anyone's ability to re-derive it (G-02) | M | M | **mitigate partially** — canonical encoder pinned by tests in both languages (AV-015); no contract-side check | scorer lead | `audit/specs/scorer-service.md`, `INV-CANON-01` | if a second scorer implementation ships |
| R-09 | **No report-rate instrumentation** — the whole model is inert if nobody challenges (G-04) | M | H | **avoid-by-design?** — needs a dashboard before incentives can be tuned at all | data | `THREAT_MODEL.md#t6`, SP-08 | first 30 days post-launch |
| R-10 | **Rust SDK is pre-v2 and cannot produce a valid v2 commitment** (AV-014, G-05) | H | M | **accept, documented** — parity reports it `skipped`; rewrite is SP-04-adjacent scope | devex | `FINDINGS.md#av-014`, `audit/specs/README.md` | anyone shipping the Rust crate to a user |
| R-11 | **Canonical-JSON rule drift** — three encoders (2 SDKs + scorer) with two deliberately different domains | M | H | **mitigated** — every rule pinned by a test; the divergence itself is asserted so a "unify it" change fails loudly | protocol lead | `INV-CANON-01`, `FINDINGS.md#av-013`, `services/scorer/test/canonical.test.ts` | any change to either encoder |
| R-12 | **Block-time / finality assumptions on Monad** — the gate's latency claim *is* the product | M | H | **transfer to measurement** — `make measure-monad` publishes real numbers instead of a promise | devex | `THREAT_MODEL.md#t7`, `metrics/` | any RPC or chain-config change |
| R-13 | **`viaIR` compile is slow (≈40 s) and easy to skip** — a tool that reads stale bytecode reports false safety | M | L | **mitigated** — every report carries `build.sourceDigest`; `doctor.py` fails when a report predates the current build | tooling | `tools/README.md`, `tools/doctor.py` | if the digest check is ever loosened |
| R-14 | **Docs cite paths that do not exist** — the classic way an audit package becomes fiction | M | L | **mitigated** — `doctor.py` "cited test/tool paths exist" check | tooling | `tools/doctor.py`, `INV-DOC-01` | any new doc reference |
| R-15 | **Invariant declared but never evaluated** — a decorative invariant launders risk into "we checked it" | L | H | **mitigated** — campaign counts evaluations per id and fails on a zero count; the matrix refuses to merge shards built from different bytecode | protocol lead | `audit/INVARIANTS.md`, `tools/aggregate_campaigns.py` | any new invariant id |

## What is *not* on this register, and why

* **`int256` overflow in `getSummary` (AV-001), EIP-3009 replay (AV-008), nonce burn (AV-011),
  cooldown bypass (AV-012), credit rounding (AV-006)** — these were attack attempts that **failed**.
  They are not risks; they are guards with named invariants, and the scenarios stay executable so the
  guards cannot be removed quietly.
* **Slashing percentage tuning** — a parameter question, not a vulnerability; tracked with R-01
  because the two interact (a slash of a stake that can leave is a slash of nothing).

## Closure rules

1. A risk moves to *closed* only by (a) code change + a scenario that proves the new behaviour, or
   (b) an explicit acceptance signature from the named owner in the PR that edits this file.
2. No risk is closed by editing this table alone.
3. Every `accepted` row must appear in `audit/README.md`'s summary and in `STATE.md`.
