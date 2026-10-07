# Threat model

Written before the campaigns were run, so the fuzzing had targets rather than only a random walk.
Each attacker class lists: capability, cheapest win, what stops it today, and **the executable check
that keeps that answer true**. Anything without a check is marked as a gap, not a control.

Severity scale: **critical** = loss of funds or permanent protocol stop; **high** = a trust
guarantee we advertise is false; **medium** = a participant can be harmed or the game is degraded;
**low** = cosmetic/operational.

---

## T1 — Malicious agent (registered, staked, rational)

**Capability:** its own key, its own capital, full control over what it commits, what it attests, and
when it withdraws.

| attack | cheapest version | stops today | checked by |
| --- | --- | --- | --- |
| spend beyond the committed cap | `swap.execute` for $90 against a $25 cap | `overSpend` is now unconditional (`maxSpendUsd == 0` means zero, not unlimited — AV-003) | `attacks.py --id AV-003`, `demo.py` step 4b |
| act outside the allow-list | an action name absent from `allowedActions` | leaf carries `keccak(action)`; the vault compares against the committed set | `parity` (13 adversarial leaves), `INV-GATE-01` |
| attest a root that hides the deviation | anchor only innocent leaves | **not stopped** — accepted as **R-02** (AV-004); the challenger forfeits its bond instead | `attacks.py --id AV-004`, `demo.py` step 4a |
| escape slashing after being caught | `unstake()` inside the challenge window | **not stopped** — accepted as **R-01** (AV-002): no unbonding delay exists | `attacks.py --id AV-002` |
| commit nothing, act anyway | skip `commitIntent` | `checkGate` refuses any agent with no live commitment for the intent it presents; deadline expiry closes the escape | `campaign` every state |
| re-attest a friendlier history | second `attestOutcome` for the same intent | `OutcomeAlreadyAttested` — the anchor is one-shot | `campaign` INV-INTENT-01 (immutability), `demo.py` step 4a |
| brick the protocol through its own admin path | `setChallengeWindow(type(uint64).max)` | `MAX_CHALLENGE_WINDOW` (3650 days) bound (AV-007) | `attacks.py --id AV-007` |
| grief a reviewer | burn a wallet-set nonce by sending bad signatures | impossible: a reverting tx rolls back the increment (AV-011, refuted) | `attacks.py --id AV-011` |

**What the model says is fine:** an agent that deviates and is *not* challenged pays nothing until
someone proves it. That is the design (prove-then-slash), bounded by `challengeWindow` — so the
economic weight of the system sits on whistleblower incentives, i.e. T6.

---

## T2 — Reviewer / challenger (any address, adversarial or honest)

**Capability:** reads all commitments and proofs from the chain, can bond a challenge, can front-run.

* **Fabricated deviation** → the proof must verify against the *anchored* root; otherwise the bond is
  forfeited to the treasury. The cost of a false accusation is real, which is the property the
  protocol depends on (`demo.py` step 4a shows the mechanic).
* **Bounty sniping** (copy a real whistleblower's calldata, outbid it) → **not stopped**, accepted as
  **R-03** (AV-005). First-upheld-wins is deliberate; the mitigation if bounty value ever exceeds gas
  is a payout queue (SP-03).
* **DoS by mass-challenging** — every challenge locks a bond, and a rejected challenge forfeits it, so
  the attack costs the attacker 5 USDC per shot per intent while paying the treasury. Bounded, not free.
* **Withholding a known deviation** — no penalty exists for *not* challenging. Accepted: the protocol's
  claim is "deviations are provable", not "are always punished".

---

## T3 — Protocol operator / role holder (`DEFAULT_ADMIN_ROLE`, `SCORER_ROLE`, slasher)

**Capability:** the most dangerous honest actor. Can set `minStake`, `minScore`, `challengeWindow`,
`treasury`, `scoreReader`, post scores, slash.

| attack | impact | stops today | checked by |
| --- | --- | --- | --- |
| `setChallengeWindow(huge)` | every attestation reverts forever | bounds + `INV-INTENT-02` | `attacks.py --id AV-007` |
| post a score of 100 for a slashed agent | bypasses the reputation floor | `checkGate` re-checks status and stake on the same call, so eligibility is not purchasable by score alone; caps in the scorer keep a fresh agent under the floor | `campaign` INV-GATE-01/02, `services/scorer/test/formula.test.ts` |
| set `treasury` to itself and keep bounties | value leakage | expected: treasury is the recipient by design; flagged for a timelock (SP-05) | — gap G-03 |
| deploy the stack without `setEnforcer(stakeRegistry)` | BAN never propagates to identity → slashed agents stay servable | deploy script asserts the wiring; harness refuses to boot otherwise; `BanPropagationFailed` makes it indexable (AV-010) | `DEPLOYMENT.md` pre-flight, `attacks.py --id AV-010` |
| unilaterally `banAgent` | kill an agent's identity without a slash | the identity registry only accepts `owner()` or the configured enforcer for bans | `campaign` INV-AUTH-01 |

**Not mitigated:** there is no timelock, no multisig requirement and no governance veto on admin
actions (G-03). Roles are the residual trust assumption of this protocol and the audit package says
so instead of implying otherwise.

---

## T4 — A counterparty integrating the gate (x402 seller, MCP server, payment router)

**Capability:** one `eth_call` to `checkGate`, one `eth_getStorageAt`-class read of the identity
registry, the SDK.

* **Failure mode that matters most:** the gate says yes and the counterparty is stuck with a bad
  agent. The gate is a *view over state*, so a slash that lands one block later does not retroactively
  change it — a stale read is possible. Mitigated by (a) `isChallengeOpen` to refuse settlement while
  an intent is un-attested, and (b) the committed `deadline` (an expired commitment never passes).
* **Two entry points, one promise** — `checkGate` vs `isEligible` are different code paths and *must*
  agree, or integrators get different answers from the same agent. `INV-GATE-02`, evaluated on every
  fuzzed state.
* **Read-path DoS** — if any view reverts on a reachable state, the counterparty's UI and our own
  dashboard break with no admin fix (`INV-VIEW-01`, AV-001).
* **Cross-layer mismatch** — a counterparty that re-derives `intentHash` in Python while the agent used
  TypeScript would reject honest work. This was *actually broken* (AV-013) and is now pinned by
  `tools/parity/compare.py` rather than by hope.

---

## T5 — Sybil ring (many agents, one controller)

**Capability:** N identities, N × minimum stake, coordinated feedback.

* **Reputation inflation:** feedback is only *grounded* when the reviewer paid ≥ `minGroundedPayment`
  and is itself staked (`isStakedReviewer`), so a ring must buy stake per reviewer, and its own
  reviews raise its own slashing exposure. Not free; not impossible. **R-05** tracks the residual
  (no per-reviewer decay or identity-linkage heuristic exists).
* **Score pumping via `feedbackValues`:** the summary averages over unique reviewers, and the
  `int128`/decimal cap means an attacker cannot break the read path (AV-001 refuted). A ring of
  12 accounts can still move a score meaningfully; the honest mitigation is volume-weighting, which
  costs real settlement — recorded as **R-05**, proposal SP-07.
* **Nonce/key churn:** wallet-set changes are EIP-712-signed by the *current* wallet, so a Sybil must
  control the original key to move the agent's wallet (AV-011).

---

## T6 — Economic / market attacker

**Capability:** no role needed; trades against the incentives.

* **Bounty farming** — needs a *real* deviation to profit, which means paying the 50% slash. The
  protocol therefore self-funds honest reporting and pays nothing for lies; the attack collapses into
  "be an honest whistleblower".
* **Underfunded reporting** — if the bond (5 USDC) exceeds the expected bounty for small intents,
  nobody reports, and T1's "deviates and is not challenged" branch becomes the norm. This is the
  single most important *parameter* question for the auditors: `challengerBond`, `bountyBps` and
  `minStake` are coupled, and no metric in this repo measures report rate. Gap **G-04**: instrument
  `recordGateDecision` + `DeviationUpheld` into a report-rate dashboard before mainnet.
* **Liquidation gaming in the credit market** — `borrowCapacity` is always admissible (AV-006 refuted,
  `INV-CREDIT-02`), and `_isBanned` gates borrowing, so a slashed agent cannot top up to dodge
  liquidation. Banned propagation (AV-010) is what would have broken this; it is now asserted at
  deploy time.

---

## T7 — Protocol-level / chain assumptions

| assumption | if it breaks | mitigation today |
| --- | --- | --- |
| Monad is EVM-equivalent with ~0.4 s blocks and fast finality | the "gate costs one round trip" claim (the product) degrades to a 12 s product | measured, not asserted: `make measure-monad`; the SDK benchmark publishes real numbers |
| `block.timestamp` is monotonic and roughly honest | `challengeEndsAt`, `suspendedUntil`, `deadline` all shift | Cancun `PREVRANDAO` is not used for anything; timing is only ever a *minimum*, never an exact target |
| USDC is a standard 6-decimal ERC-20 | `safeTransferFrom` assumptions, fee-on-transfer rebases | `MockUSDC` is used in every test we ran — **G-01**: real-token behaviour (allowance races, pausable, permit differences) is untested here |
| One canonical JSON encoding across languages | the audit trail splits in half (AV-013) | `tools/parity/` + tests in both SDKs and the scorer (AV-015) |
| The scorer service is honest about inputs | scores are anchored over inputs nobody re-derives | `breakdownHash` is a commitment with **no on-chain verifier**; the canonical encoder is pinned so a third party *can* re-derive (G-02) |

---

## Gaps (declared, not controlled)

| id | gap | why it is a gap and not a control |
| --- | --- | --- |
| G-01 | real-USDC behaviour untested | everything in `verification/` uses `MockUSDC`; an approval race or a pausable token changes T2/T6 economics |
| G-02 | `breakdownHash` has no verifier | the contract stores it, nothing recomputes it; the pinning test exists so an auditor *can* recompute |
| G-03 | no timelock/multisig on admin roles | the blast radius in T3 is "the protocol stops or drains"; only bounds and asserts protect it |
| G-04 | no report-rate instrumentation | if nobody challenges, the model's central mechanism is inert (T6) |
| G-05 | Rust core is pre-v2 | it cannot produce a valid v2 commitment at all; parity is reported as `skipped` (AV-014), not passing |
| G-06 | Move/Monad-native path in the brief does not exist | the repo is Solidity 0.8.37 on EVM; recorded so nobody audits a phantom artifact (SP-04) |
