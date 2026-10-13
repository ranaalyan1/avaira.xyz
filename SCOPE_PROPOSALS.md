# Scope proposals

The audit's rules were *verify, don't trust* and *no scope creep*: findings that are bugs got fixed
in place; changes that alter the model are written here for a decision, not slipped into a commit.
Each proposal lists the evidence, the smallest change that would address it, and what it costs —
including the cost of **not** doing it.

| id | proposal | driven by | size | decision needed from |
| --- | --- | --- | --- | --- |
| SP-01 | Unbonding delay on `unstake`/`voluntaryExit` inside the challenge window | AV-002 / R-01 | M | protocol lead + capital-model owner |
| SP-02 | Bind `outcomeHash` to `AuditTrail.head` so "empty trail" is a detectable predicate | AV-004 / R-02 | S | protocol lead |
| SP-03 | Bounty payout queue (or commit-reveal) to defuse sniping | AV-005 / R-03 | M | protocol lead |
| SP-04 | Retire or rewrite `sdk/avaira-rust-core`; drop the Move assumption | AV-014 / G-05, G-06 | M | product + devex |
| SP-05 | Timelock + multisig manager for admin roles; bound `minStake`/`minScore` moves | T3 / R-04 / G-03 | M | ops + governance |
| SP-06 | Ship the scorer service entry point (or delete the targets that assume one) | `STATE.md` open items | S | scorer lead |
| SP-07 | Sybil resistance for grounded feedback: reviewer-count decay, linkage heuristics | T5 / R-05 | M | scorer lead |
| SP-08 | Report-rate instrumentation before mainnet (challenges per upheld deviation, bond economics) | T6 / R-09 / G-04 | S | data + protocol lead |
| SP-09 | Fork-test against real USDC on a Monad mainnet fork | R-07 / G-01 | S | protocol lead |
| SP-10 | Unify the two canonical encoders behind an explicit version tag | R-11 / AV-015 | M | protocol lead |

---

## SP-01 · exit delay inside the challenge window

**Evidence.** `attacks.py --id AV-002` is `EXPLOIT-CONFIRMED`: unstake right after attestation and
the upheld slash computes 50% of zero. The stake is the *only* penalty for deviation, so today the
penalty is avoidable by a legal call.

**Smallest change.** Record `pendingExitAt[agentId] = block.timestamp + challengeWindow` on
`unstake` when the agent has any intent with an open challenge window, and make the withdrawal
settle then; or hold the slashed share in escrow until each intent's window closes.

**Cost.** UX and capital efficiency: agents expect instant exit. **Cost of not doing it:** the
headline claim "deviations cost real money" is false for any agent that watches its own challenge
window — which is every agent.

## SP-02 · make an empty audit trail detectable

**Evidence.** AV-004: `attestOutcome` accepts any root, including one over a tree that omits the
deviation. We rejected `require(merkleRoot != 0)` as theatre (it blocks only the trivial case and
three vault unit tests attest with zero roots on purpose).

**Smallest change.** Require `outcomeHash == AuditTrail.head(agentId, intentHash)` where `head` is
the agent's chain tip at attestation time. Deviations *omitted from the tree* remain unprovable —
that is inherent — but "attested a root that does not match your own trail tip" becomes a single
revertible predicate instead of a silent judgement call, and counterparties can refuse to settle on
a mismatch.

**Cost.** A field + one hash comparison in the vault, plus SDK changes. **Cost of not doing it:**
T2 stays "the reporter is punished for being right" in the corner case auditors will ask about first.

## SP-03 · bounty queue

**Evidence.** AV-005: an identical calldata submitted first takes the bounty; the reporter gets
nothing and loses gas. Accepted today because first-upheld-wins is what makes fabrication
unprofitable.

**Smallest change.** On an upheld challenge, credit the bounty to a per-intent queue keyed by the
first *submission* whose proof verified; pay out when the window closes, splitting among
stakeholders if several proofs land in the same block.

**Cost.** Real feature work on the whistleblower path. **Trigger.** Do it before bounties are worth
more than a transaction's gas — i.e. before mainnet volumes matter, not after.

## SP-04 · the Rust core and the Move assumption

**Evidence.** AV-014: SHA-256 instead of `keccak256(abi.encode(...))`, an unused `secret` parameter
advertising a keyed hash that does not exist, `f64` money, no `deadline`, no `AuditTrail`, a scorer
whose weights sum to 0.8 (max score 80 of 100). It cannot produce a valid v2 commitment.

**Options.** (a) Rewrite the crate as a thin v2 core reusing `MerkleLib` semantics + parity vectors;
(b) delete it and ship no Rust SDK; (c) leave it and keep `skipped` in the report. Today we are at
(c), which is honest but leaves a repo-wide "supported language" claim misleading.

Separately: the project brief describes a **Move** artifact for Monad. It does not exist here — the
protocol is Solidity 0.8.37 on the EVM (Monad is EVM-compatible), and `contracts/foundry.toml` plus
`tools/compile.mjs` are the only build paths. Either the brief is corrected or the artifact is
written; the current docs must not imply a second implementation we don't have.

## SP-05 · timelock and role hygiene

**Evidence.** T3: `setTreasury`, `setMinStake`, `setMinScore`, `setScoreReader`, `setSlasher`,
`setChallengeWindow` are single-transaction `onlyOwner`/admin changes. AV-007 proved how much damage
one of them could do pre-fix (a window value that overflowed and reverted *every* attestation).

**Smallest change.** A 24–48 h timelock on parameter changes plus governance-visible `queued`/
`executed` events; multisig-with-announced-intent for the admin key. Bound `minStake`/`minScore` to
a band so a "typo" can't zero the entry price.

**Cost.** None to the protocol's trust model; some to incident response speed (keep a `emergency*`
path for pausing, which is different from silently repricing the system).

## SP-06 · scorer service entry point

**Evidence.** The formulas are tested and correct, and the service cannot be run: `src/index.ts` is
not in the repository, yet `services/scorer/package.json` declares `main = ./src/index.ts` and its
`start` / `score` / `leaderboard` scripts all exec `tsx src/index.ts …` (`make score`,
`make leaderboard`). `make smoke-kimi` calls a `smoke:kimi` script that doesn't exist, and
`make gateway` / `make smoke-privy` `cd services/gateway`, a directory with no `package.json` at all.
`tools/doctor.py` surfaces each of these as a warning today; they should be fixed or deleted rather
than left as red herrings for an integrator.

**Smallest change.** Add `src/index.ts` with a `score --agent <id> [--anchor]` CLI (reads the
deployment manifest, calls the same pure functions), plus `serve` for HTTP. Or delete the Makefile
targets and the `main` field and state plainly that this service is a library.

## SP-07 · grounded-feedback Sybil resistance

**Evidence.** T5: a ring of staked reviewers can move a score because grounding is per-reviewer, not
per-*identity-cluster*. Cost to attack = `minStake` per reviewer, which is money but finite.

**Smallest change.** Per-reviewer marginal weight decay (`w = 1/√n` over reviewers sharing a
funding graph heuristic), plus a `feedbackUniqueReviewers` floor before a score band can change.
Both are off-chain-policy + one view; no consensus change.

## SP-08 · report-rate instrumentation

**Evidence.** The model is "prove it and you are paid half". Nothing in the repo measures whether
anyone proves anything. If the report rate is ~0, the deterrent is theoretical (R-09).

**Smallest change.** One query + dashboard: `OutcomeAttested` count vs `DeviationUpheld` vs
`ChallengeRejected` vs bond burned, per week, per chain. Decide `challengerBond`/`bountyBps` from
that, not from intuition.

## SP-09 · real-token fork test

**Evidence.** Every number in `verification/` comes from `MockUSDC`. Real USDC is pausable, has a
blacklist, and its transfer behaviour under `safeTransferFrom` with `force_approve` semantics is not
what a mock guarantees (R-07, G-01).

**Smallest change.** One Foundry fork test against mainnet USDC covering stake/withdraw/attest/
challenge plus the credit-market paths, run in CI nightly with `RPC_URL` from secrets.

## SP-10 · one canonical encoder, versioned

**Evidence.** Two encoders today (SDK: escapes non-ASCII, rejects `bigint`/floats; scorer: keeps
non-ASCII, 6-dp floats, `bigint` as decimal string). The split is *correct* by domain and pinned by
tests — but the fact that `JSON.stringify`'s integer-key reordering bit both layers suggests the
"build an object then stringify it" shape is the real hazard.

**Smallest change.** Promote one `canonical.v2` module (direct writer, code-point sort, ASCII
escaping, integers-only numbers with explicit decimal strings) shared by both layers, tagged in the
hash domain string (`Avaira.Intent.v2`) so old anchors stay verifiable and new ones are uniform.
Version-tagging is what makes this safe: `intentHash` is `keccak256(abi.encode("Avaira.Intent.v1", …))`
precisely so a future change can be a new domain instead of a silent break.
