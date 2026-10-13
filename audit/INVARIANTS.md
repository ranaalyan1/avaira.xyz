# Invariants

Every invariant here is **evaluated mechanically on every state the campaign reaches**, and the
report publishes how many times each one was evaluated
(`invariantEvaluationsById` in `verification/reports/campaign.json`). An id that is declared but
never evaluated is treated as a bug in the harness: `campaign.py` prints
`CAMPAIGN BUG: declared invariants never evaluated: …` and the merged matrix verdict goes `FAIL`.
That rule exists because a decorative invariant is worse than none — it launders risk into
"we checked that".

Legend for the **checked by** column:

* `campaign` — evaluated after every fuzzed state (`tools/avaira_evm/campaign.py`)
* `attack` — asserted as an expectation by a hand-written scenario (`tools/avaira_evm/attacks.py`)
* `parity` — cross-language byte equality (`tools/parity/compare.py`)
* `test` — unit test in an SDK / service
* `doctor` — repo-consistency gate (`tools/doctor.py`)

---

## Ledger and capital

### INV-LEDGER-01 — per-staker ledger equals the sum of that staker's agents
`∀ staker s ≠ 0 : accountStake(s) = Σ{ stakeOf(a) : stakerOf(a) = s }`

*Why it buys something:* one address can stake for several agents. If the aggregate ledger and the
per-agent ledger drift, `unstake` frees more than was locked and the shortfall is socialised onto
every other staker. This is the invariant that makes "the stake is real" mean something; it is
checked on **every agent in every state**, not just after stake operations, so a bug in an
unrelated code path (slash, ban, reactivate) that mutates one of the two maps is caught too.

*Checked by:* campaign (240 evaluations per 60×10 smoke run).

### INV-LEDGER-02 — the registry is never short of the stake it accounts for
`balanceOf(stakeRegistry, USDC) ≥ Σ_a stakeOf(a)`

*Why:* the slash ladder and the whistleblower bounty are only enforceable if the contract actually
holds the money. A deficit here means an accounting entry was created without collateral — a
withdrawal that works and a protocol that is insolvent.

*Checked by:* campaign.

### INV-SLASH-01 — slashing can never remove more than was staked
`∀ a : slashedTotal(a) ≤ Σ{ amounts ever staked for a }`

*Why:* the opposite is the classic "negative stake" bug class: percentage-of-current-stake slashing
combined with an unstake in the same block, or a slash applied twice to one snapshot. It makes
`slashAgent` a profit opportunity for whoever controls the slasher role.

*Checked by:* campaign.

### INV-SLASH-02 — `SUSPENDED` may only be left at or after the cooldown deadline
`status: 3 → 2 ⇒ block.timestamp ≥ suspendedUntil_before`

*Why:* suspension is the protocol's only *non-terminal* punishment, and `stake()`/`reactivate()`
both offer a way out of it. If either could clear the status early, the cooldown is decoration and
an agent can slash-wash its way back to eligibility with the same capital (see AV-012, which is
the attack that probes exactly this).

*Checked by:* campaign (transition-based: the harness snapshots `status`/`suspendedUntil` per step
and only fires when a real reactivation happened too early).

### INV-SLASH-03 — a BAN leaves no capital behind, and is terminal for the gate
`status(a) = 4 ⇒ stakeOf(a) = 0`

*Why:* BAN is the thing we tell counterparties is permanent. If a banned agent kept a balance the
treasury couldn't reach, or kept the ability to top up into eligibility, "terminal" would be a
label rather than a property.

*Checked by:* campaign.

---

## The gate

### INV-GATE-01 — the gate verdict is exactly `(ACTIVE ∧ stake ≥ minStake ∧ score ≥ minScore)`
`checkGate(a).allowed = (status(a)=ACTIVE ∧ stakeOf(a) ≥ minStake ∧ score(a) ≥ minScore)`

*Why:* `checkGate` is the one function every x402 seller, MCP server and payment router calls
before serving an agent, and it is *free* (an `eth_call`, no tx). If it ever returns `true` for an
agent that should be blocked, the whole "block before execution" claim inverts into "a second
opinion that can be ignored". If it returns `false` for a good agent, we have built an outage.
Both directions are violations, so the campaign asserts equality rather than soundness alone.

*Checked by:* campaign.

### INV-GATE-02 — `checkGate` and `isEligible` can never disagree
`checkGate(a).allowed = isEligible(a)`

*Why:* two entry points, one promise, deliberately implemented along different code paths (one in
the vault over the intent, one on the registry). They are exactly the kind of pair that drifts in
a refactor, and integrators pick one or the other. A disagreement means the same agent is
servable through one API and refused through the other.

*Checked by:* campaign.

---

## Intents

### INV-INTENT-01 — an accepted attestation is anchored exactly as computed
`attestOutcome(...) = ok ⇒ intent.executed ∧ intent.outcomeRoot = root(leaves)` and that root is
never rewritten by a later step.

*Why:* the root is the only commitment that deviation proofs are checked against. An "accepted but
not anchored" bug means a challenger's honest proof fails and the *challenger* forfeits the bond
while the deviation goes unslashable (this is the machinery AV-004 attacks). Verifying the root we
computed — with our own leaf set — rather than "some root" is what makes it an invariant instead
of a tautology.

*Checked by:* campaign, at attestation time and again at a later sampled step (immutability half).

### INV-INTENT-02 — the challenge window is the configured window
`intent.challengeEndsAt = attestedAt + challengeWindow()`, never `0`, never more than
`MAX_CHALLENGE_WINDOW = 3650 days` ahead.

*Why:* `challengeEndsAt` is `uint64(block.timestamp) + challengeWindow`. Before AV-007 was fixed,
one `setChallengeWindow(type(uint64).max)` made every honest attestation revert with a checked-
arithmetic `Panic` — a protocol-wide stop by an admin key. The window bound turns that into a
revert at the *setter*, and this invariant is the tripwire that keeps the arithmetic honest if
either side changes again.

*Checked by:* campaign; `attack` AV-007 asserts the setter bound directly.

*Note on `attestedAt`:* the campaign reads the chain's current block timestamp immediately after
the attestation transaction, not before it — eth-tester mines every transaction into its own block
at parent+1s, and an assertion that ignored that produced a false positive on the first run of
this invariant. A false positive in a fuzz harness is how you teach everyone to ignore the report.

### INV-PANIC-01 — no transaction ever fails with a Solidity `Panic`
No `Panic` (arithmetic `0x11`, under/overflow, `0x12` division by zero, `0x21`-`0x22`
bad conversion, `0x31` underflow on `unchecked`, `0x41`-`0x51` memory, `0x62` insufficient balance
on a low-level op, `0x71`-`0x72` trap) may surface from any protocol call, in any state, for any
sender.

*Why:* a `require`-style custom error is the protocol *working*; a `Panic` is the protocol having
no idea what to do. `Panic`s also defeat the entire error-catalog tooling: `explain_reverts`
maps 94 declared errors to file:line, and a `Panic` has no such mapping, so an integration sees
"reverted" with nothing to fix.

*Checked by:* campaign, on **every** transition (this is why `invariantEvaluations` is dominated by
its count).

### INV-AUTH-01 — no unprivileged call can mutate state
For a random admin/slaker-restricted entry point called from a random key with no role: the state
hash is unchanged afterwards.

*Why:* role checks are the only thing between an exposed ops key and a protocol that can rebind
its own treasury, minimum stake, or ban list. "The call reverted" is not enough — the state must be
provably identical, which is why this compares a keccak over the whole probed agent set instead of
just watching for a revert.

*Checked by:* campaign (`state_hash()` over `AvairaProbe.agents()`).

### INV-VIEW-01 — no read path ever reverts
13 views (`tokenURI`, `statusOf`, `isBanned`, `getSummary`, `gradeOf`, `statusOfBatch`,
`isEligible(address)`, `isLiquidatable`, `borrowCapacity`, `getAgentValidations`,
`isChallengeOpen`, `getIntent`, …) are called for every agent after every sequence.

*Why:* views are how the dashboard, the SDK and every third party *see* the protocol. A view that
reverts on a state reachable by ordinary use is a permanent DoS of the read path — you cannot
`try/catch` your way out of a leaderboard that no longer renders, and there is no admin action
that fixes it (see AV-001, whose whole attack was a reverting view).

*Checked by:* campaign (`full_view_sweep`).

---

## Reputation and scoring

### INV-REP-01 — a feedback value can never overflow the summary accumulator
`valueDecimals ≤ 18` (enforced) ∧ `|value| < 2¹²⁷` ⇒ every scaled term fits `int256`.

*Why:* `getSummary` rescales every record to the widest decimal count before averaging. Without
the 18-decimal cap the sum overflows, and per INV-VIEW-01 a reverting summary is a permanent
read-path DoS. The bound: worst single term ≈ `1.7e38 × 1e18 ≈ 1.7e56`, so overflow needs
`≈3.4e20` records — one transaction each. The cap is load-bearing; this invariant is why
`ValueDecimalsTooLarge` must never be relaxed without redoing that arithmetic.

*Checked by:* `attack` AV-001 (which is why that scenario stays in the suite even though it is
refuted).

### INV-REP-02 — an EIP-3009 authorisation is single-use
`authorizationState[payer][nonce]` is set before the transfer, and reuse reverts
`AuthorizationNonceAlreadyUsed()`.

*Why:* `giveFeedbackWithPayment` treats a paid review as grounded. A replayable authorisation turns
one payment into unlimited grounded reviews — the exact Sybil weakness the registry exists to close.

*Checked by:* `attack` AV-008, with a real signature produced by the harness's own EIP-712 code.

### INV-REP-03 — the six component weights sum to exactly 100 points
`Σ AVAIRA weights = 100`, and every component is bounded by its own weight.

*Why:* the score is posted as `uint8`, so an over-summing table would *not* be caught by the
contract; it would silently invalidate every band comparison and every "0–100" sentence in our
docs. Related and now pinned: because each component is smoothed toward a prior, the maximum
*reachable* score is 97.5, not 100 — dashboards must not treat `score === 100` as "flawless".

*Checked by:* `test` `services/scorer/test/formula.test.ts`; bands themselves are pinned against the
compiled contract by `grade-parity.test.ts` and `attack` AV-009.

---

## Canonical encodings (cross-layer)

### INV-CANON-01 — one intent, one byte string, in every language
For a fixed corpus, `canonicalJson`, `envelopeHash`, deviation-leaf hashing, Merkle
root/proof and `intentHash` are **byte-identical** across the Python SDK, the TypeScript SDK and
the compiled on-chain libraries.

*Why:* this is the property the README sells ("anyone can recompute the commitment"). Two
implementations that merely *look* equivalent split the audit trail in half: an agent commits one
hash, a reviewer recomputes another, and honest deviations become unprovable while innocent plans
look guilty (AV-013). The scorer service has its own encoder for a different domain (its own
numeric inputs, not agent-authored plans), and it is pinned against Python too, including the
`JSON.stringify` integer-key trap that silently reorders `{"10":…,"9":…}` (AV-015).

*Checked by:* `parity` (42 vectors, 3 artifacts, plus negative controls that a swapped leaf and a
tampered root must *fail* verification) and `test` for the encoder edges.

### INV-DOC-01 — every claim links to an executable check
Every finding id in `FINDINGS.md` is exercised by `attacks.py` or `compare.py`; every invariant id
named anywhere in the repo is defined in this file; every Makefile target used by CI exists; no
document claims 4-way parity or an invariant that is not machine-checked.

*Checked by:* `doctor` (`python3 tools/doctor.py`, run in CI).

---

## Credit market

### INV-CREDIT-02 — advertised capacity is always admissible
`borrow(a, borrowCapacity(a))` never reverts: `⌊⌊C·10⁴/R⌋·R/10⁴⌋ ≤ C`.

*Why:* the classic integration killer — a view that promises capacity the mutator refuses. The
inequality holds because flooring twice cannot exceed the collateral; this invariant is the proof
made executable, and it catches any refactor that changes one of the two roundings
(e.g. switching the view to `ceil`).

*Checked by:* `attack` AV-006 over 11 adversarial collateral values, incl. 1 wei and
`2⁶⁴`-adjacent.

---

## Declared gaps (named, deliberately *not* invariants — nothing checks them)

An invariant nobody evaluates is a lie with an id, so these are listed as gaps, not as `INV-*`
entries. `tools/doctor.py` fails the build if an `INV-*` id is *referenced* anywhere in the docs
without being defined here — which is how gap 1 was caught while this file was being written: a draft
`STATE.md` gave the missing token-flow property an id of its own, and CI turned red before anyone
could mistake it for a checked invariant. Keep it that way: mint an id only together with a check.

1. **Token flow does not have to match the ledger.** The harness deploys `MockUSDC`, mints and
   approves for real, and exposes `usdc_balance()` — but no scenario asserts *transfer == ledger delta*
   for `stake`, `slash`, `repay` or intent settlement. A refactor that moves USDC without moving the
   accounting (or the reverse) passes every check in this repo.
   *What it would take:* wrap each money-moving transition in the campaign with a balance-delta
   assertion, keyed by the same `TxResult`, and give the property an id.
2. **`checkGate` has no economic test at all.** The two overloads agree with `isEligible`
   (INV-GATE-01/02) but nothing exercises the *values* — `minScore = 0.55`, `minStakeUsd`,
   `scoreDecayDays`, `maxBlockAge` — because no caller in this repo invokes the gate. See
   `SCOPE_PROPOSALS.md` SP-01.
3. **Oracle freshness is assumed.** `latestRoundData()` is consumed without checking `updatedAt`, and
   the accepted-risk finding `AV-002` is exactly that hole. Not an invariant because the protocol
   currently *chooses* to trust the feed; if that changes, INV gets a home here.

---

## Not invariants (declared, so nobody re-derives them as bugs)

* **A SUSPENDED agent whose cooldown has passed stays `SUSPENDED` until it re-stakes or is
  reactivated** — deliberate: nothing in the protocol should silently restore eligibility.
* **A rejected challenge pays nothing to the challenger and forfeits its bond** — deliberate
  anti-fabrication design (see AV-004/AV-005 for the cost of that choice).
* **`banAgent` failures do not revert the slash** — deliberate: capital penalties must not depend on
  a third contract's availability. The consequence (identity registry can stay `ACTIVE`) is
  tracked as risk **R-06** with `BanPropagationFailed` as the observable.
