# FINDINGS — Team RED log

Every finding here was produced by an attack scenario that **ran against the compiled
bytecode**, not by reading code and shrugging. Each entry names the scenario that proves it; the
whole file is machine-replayable:

```bash
python3 tools/avaira_evm/attacks.py --json verification/reports/redteam.json   # exit 0 == this doc is accurate
```

`attacks.py` asserts a *declared expectation* per scenario: `BLOCKED` when the protocol is fixed
and must stay fixed, `EXPLOIT-CONFIRMED` when the behaviour is a documented, accepted risk. Either
way, if the code and this document ever drift apart, CI fails. That is the point of the file — it
is a tripwire, not a trophy case.

Scope of the sweep: `contracts/src/**` (all six protocol contracts plus `MerkleLib`,
`RiskEnvelopeLib`, `MockUSDC`), the cross-layer surface between them and the identity registry,
the TypeScript/Python SDKs, and the scorer service. 93 custom errors are enumerated from the
build into `build/avaira/error-catalog.json`, so "did anything revert with a Solidity `Panic`?"
is answered per run, not per hope (`INV-PANIC-01`).

| id | title | severity | status | proof |
| --- | --- | --- | --- | --- |
| [AV-001](#av-001) | int256 overflow in `getSummary` | — | **refuted** | `attacks.py --id AV-001` |
| [AV-002](#av-002) | unstake inside the challenge window escapes slashing | **high** | accepted risk (R-01) | `attacks.py --id AV-002` |
| [AV-003](#av-003) | `maxSpendUsd == 0` meant "unlimited" | medium | **fixed** | `attacks.py --id AV-003` |
| [AV-004](#av-004) | attest a root that omits the deviation | medium | accepted risk (R-02) | `attacks.py --id AV-004` |
| [AV-005](#av-005) | bounty race: copied challenge beats the reporter | medium | accepted risk (R-03) | `attacks.py --id AV-005` |
| [AV-006](#av-006) | `borrowCapacity` vs `borrow` rounding | — | **refuted** | `attacks.py --id AV-006` |
| [AV-007](#av-007) | one admin call bricks every `attestOutcome` | **high** | **fixed** | `attacks.py --id AV-007` |
| [AV-008](#av-008) | EIP-3009 authorisation replay | — | **refuted** | `attacks.py --id AV-008` |
| [AV-009](#av-009) | grade bands: chain vs scorer service | medium | **fixed** | `attacks.py --id AV-009` + `services/scorer` tests |
| [AV-010](#av-010) | BAN propagation fails silently | medium | **mitigated** | `attacks.py --id AV-010` |
| [AV-011](#av-011) | failed `setAgentWallet` burns the nonce | — | **refuted** | `attacks.py --id AV-011` |
| [AV-012](#av-012) | suspension cooldown bypass via `stake` | — | **refuted** | `attacks.py --id AV-012` |
| [AV-013](#av-013) | TS and Python computed different `intentHash` values | **critical** | **fixed** | `tools/parity/compare.py` |
| [AV-014](#av-014) | Rust core is pre-v2 and cannot interoperate | **high** | open (scope call) | `tools/doctor.py` |
| [AV-015](#av-015) | scorer's canonical JSON reordered integer-like keys | **high** | **fixed** | `services/scorer/test/canonical.test.ts` |

---

## AV-001 · int256 overflow in `getSummary` — refuted {#av-001}

**Attack.** `giveFeedback` accepts `int128 value` with `uint8 valueDecimals ≤ 18`.
`getSummary` scales every record to the widest decimal count seen (`value * 10**(maxDecimals -
decimals)`) before averaging. A record at `2**127 - 1` with 0 decimals next to a record with 18
decimals should overflow the `int256` accumulator, and a reverting view is a permanent read-path
DoS: the dashboard, every indexer and any protocol reading the score breaks, and only the
*attacker* can revoke their own record.

**Result.** Not exploitable. The accumulator is `int256` while inputs are `int128`, so the
worst single contribution is `≈1.7e38 × 1e18 ≈ 1.7e56`; overflowing needs `≈3.4e20` such records,
i.e. one transaction each. The 18-decimal cap on `valueDecimals` is what buys that margin — it is
load-bearing, not cosmetic.

**Keep as a guard.** `ValueDecimalsTooLarge` (the `> 18` check) is now named in
`audit/INVARIANTS.md#INV-REP-01` with this arithmetic, and the scenario stays in the suite so
raising the cap without redoing the bound fails CI.

---

## AV-002 · unstake inside the challenge window escapes slashing — **high, accepted** {#av-002}

**Attack.** Deviation is provable for `challengeWindow` (24 h default) after attestation. Slashing
takes a *percentage of the current stake*. There is no unbonding delay on `unstake`/`voluntaryExit`.
So an agent that expects to be caught withdraws everything first:

```
attestOutcome(root)                     # root commits to a leaf that blew the spend cap
unstake(agentId, stakeOf(agentId))      # legal: not SUSPENDED yet
challengeDeviation(...)                 # proof verifies, challenge is UPHELD
→ amountSlashed = 50% of 0 = 0, status NONE, no bounty paid
```

**Evidence.** `attacks.py --id AV-002` → `challengeAccepted: true`, `slashedTo: 0`,
`stakeBeforeExit: 100000000`. The deviation is recorded and the intent is flagged, but the
economic penalty is zero, and the whistleblower's 50% bounty is 0.

**Why not fixed here.** The fix is an exit delay (or a slash-escrow on the challenge window), which
changes the capital model — a product decision, not a bug fix. It is also the single most
important thing an auditor should form an opinion on: **the stake is bondable only by
coincidence of timing.** Recorded as risk **R-01**; proposal **SP-01** in `SCOPE_PROPOSALS.md`.

**Interim, in-repo mitigations.** `audit/THREAT_MODEL.md` documents it as the top T1/T4 combined
risk; the SDK's `run()` closes the intent and attests in the same call so a *correctly instrumented*
agent never leaves a window open; `isChallengeOpen` is exposed so a counterparty can refuse to
settle while an intent is un-attested.

---

## AV-003 · `maxSpendUsd == 0` meant "unlimited" — **fixed** {#av-003}

**Attack.** `overSpend = intent.maxSpendUsd > 0 && leaf.spendUsd > intent.maxSpendUsd`. The
`> 0` guard means committing a zero cap *disables* overspend detection entirely: a $1,000,000
spend against a committed cap of $0 was unslashable as long as the action name was in the
allow-list. Any agent that wanted to opt out of the spend check could, and any SDK that defaulted
`maxSpendUsd` to 0 (the natural default in every language) silently shipped an agent with no
spend cap.

**Fix.** `contracts/src/core/AvairaIntentVault.sol`: `overSpend = leaf.spendUsd > intent.maxSpendUsd`.
Zero now means *zero*, matching `RiskEnvelope`'s doc ("Maximum USD-denominated spend for the
intent").

**Evidence.** Before: `challengeAccepted: true` with no slash. After: the challenge is upheld, the
agent lands in `SUSPENDED` and its stake is actually cut — asserted by the scenario, which
inverts its expectation to `BLOCKED`.

---

## AV-004 · attest a root that omits the deviation — **accepted** {#av-004}

**Attack.** `attestOutcome` accepts any `merkleRoot`, including a root over a tree the agent
fabricated to contain only innocent leaves — or `bytes32(0)`. Deviation proofs are verified
against *that* root, so every honest challenge fails `MerkleLib.verify`, and the failed-challenge
path sends the challenger's bond to the treasury. The agent's audit trail is thus self-attesting
for anything it chooses to leave out.

**Evidence.** `attacks.py --id AV-004` → challenge against an all-zero root is rejected and
`challengerBondLost: 5000000` (5 USDC) goes to the treasury. The protocol pays the *reporter*
for the agent's junk attestation.

**Why this is inherent, and what bounds it.** No commitment scheme can prove the *absence* of a
leaf. The honest framing (now in `audit/README.md` and `THREAT_MODEL.md#T2`) is: the chain proves
**deviations the agent published**, and relies on `deadline` expiry, off-chain log collection and
`recordGateDecision` telemetry for the rest. Two concrete mitigations exist today: the gate
blocks an intent whose deadline has passed, so "attest nothing" does not buy more execution time;
and the bond is what makes junk-attestation cheap for the agent, which is a *tunable* — see
`setChallengerBond`.

**Do not "fix" this by requiring `merkleRoot != 0`.** That only blocks the trivial case, and
three vault unit tests currently attest with a zero root; the change would be security theatre
with a test-suite cost. Proposal **SP-02** records the alternative (mandatory
`outcomeHash = AuditTrail.head` binding, which at least makes "empty trail" a detectable
predicate for counterparties).

---

## AV-005 · bounty race — **accepted** {#av-005}

**Attack.** A deviation proof is public data the moment it is submitted. `challengeDeviation`
pays `msg.sender` and latches `intent.challenged`, so a watcher who copies the whistleblower's
calldata and outbids it takes the 50% bounty; the reporter gets nothing and loses their gas.

**Evidence.** `attacks.py --id AV-005`: the sniper's identical challenge succeeds, the honest
reporter's reverts with `AlreadyChallenged(agentId,intentHash)`.

**Why accepted.** First-upheld-wins is a *deliberate* anti-fabrication property: paying the
confirmer is what makes an unsupported claim worthless. Fixing the race needs commit-reveal or a
delayed payout queue (SP-03) — real, but a feature on the whistleblower path, and Monad's
mempool exposure is the actual dependency. Documented in `THREAT_MODEL.md#T6` with the
recommendation that bounties be paid from a queue if the market value of a bounty ever exceeds
gas.

---

## AV-006 · `borrowCapacity` vs `borrow` rounding — refuted {#av-006}

**Attack.** The view floors `collateral·BPS/ratio`; the mutator floors `newDebt·ratio/BPS`.
If they ever disagreed, the API would advertise capacity that reverts — the classic
"integration works in the demo, fails on mainnet" bug.

**Result.** Probed 11 adversarial collateral values (1 wei, word boundaries, `2**64`-adjacent);
`borrow(borrowCapacity(a))` never reverted. It cannot: `M = ⌊C·10⁴/R⌋ ≤ C·10⁴/R ⇒ ⌊M·R/10⁴⌋ ≤ C`,
so the capacity is always admissible. Recorded as a *verified property*
(`audit/INVARIANTS.md#INV-CREDIT-02`) rather than a non-issue, and the scenario keeps running the
scan so a future refactor that breaks the inequality is caught.

---

## AV-007 · one admin call bricks every attestation — **fixed** {#av-007}

**Attack.** `challengeEndsAt = uint64(block.timestamp) + challengeWindow`, and
`setChallengeWindow` had no bound. `setChallengeWindow(type(uint64).max)` makes that addition
overflow → Solidity 0.8 checked arithmetic reverts → **every honest `attestOutcome` reverts
forever**, so no intent can ever complete: the whole protocol stops on one transaction by a key
that is only "admin" in name (a leaked ops key, a bad governance payload, a fat-fingered
`cast send`).

**Evidence (before fix).** `attestOutcomeAfter: "Panic error 0x11: Arithmetic operation results in
underflow or overflow"` — the campaign's `INV-PANIC-01` class of bug, found by a one-line setter.

**Fix.** `MAX_CHALLENGE_WINDOW = 3650 days`, enforced in *both* `setChallengeWindow` and the
constructor with a new `ChallengeWindowTooLarge(uint64,uint64)`. A 10-year ceiling leaves the
overflow unreachable for any plausible timestamp while keeping the knob useless as a weapon.

---

## AV-008 · EIP-3009 authorisation replay — refuted {#av-008}

**Attack.** `giveFeedbackWithPayment` grounds a review by settling an EIP-3009 transfer in the
same transaction. If an authorisation could be replayed, one real payment would buy unlimited
"grounded" reviews — the exact Sybil weakness the registry exists to close.

**Result.** `MockUSDC` marks `authorizationState[payer][nonce]` before the transfer and reverts
`AuthorizationNonceAlreadyUsed()` on reuse; the second submission in the scenario reverts.
Verified with a *real* signature: the harness builds the EIP-712 digest itself and checks it
against the chain (`audit/INVARIANTS.md#INV-REP-02`).

---

## AV-009 · grade bands disagreed between chain and scorer — **fixed** {#av-009}

**Finding.** `AvairaReputationRegistry.gradeOfScore` (the on-chain string every consumer reads)
and `services/scorer/src/formula.ts` (what our own API/dashboard render) implemented different
tables. **30 of 101 scores graded differently**: a score of 82 was `A` on-chain and `B+` from the
service; 57 was `D` on-chain and `C-` from the service. The contract comment even claimed the
bands were "preserved from the offchain scorer". They were not.

**Why it matters more than it looks.** The gate floor is `minScore = 60` ≙ `C`. "Grade C or
better means the gate lets you act" is a sentence in our own docs, and it was false for the
55–59 band under the scorer's table. Any underwriter reading the API and any protocol reading the
chain were told different things about the same agent.

**Fix.** The chain's table is the single source of truth (two of three implementations already
agreed with it); `GRADE_BANDS` in `services/scorer/src/formula.ts` now matches
`gradeOfScore` exactly, and two independent guards keep it that way:

* `services/scorer/test/grade-parity.test.ts` — *parses the Solidity source* and compares all
  101 scores, so editing the contract without the scorer fails;
* `attacks.py --id AV-009` — compares the same 101 scores against the **compiled** contract in
  the EVM harness.

---

## AV-010 · a terminal BAN can fail to propagate, silently — **mitigated** {#av-010}

**Attack.** `slashAgent(BAN)` ends with
`(bool ok,) = identityRegistry.call(abi.encodeWithSignature("banAgent(...)")); ok;` — the failure
is deliberately discarded ("a registry that refuses to ban must not block the slash"). But
`banAgent` only accepts `owner()` or the configured `enforcer`. If deployment skipped
`setEnforcer(stakeRegistry)` — one `onlyOwner` call, nothing asserting it happened — then every
BAN leaves the agent **BANNED in the stake registry and fully ACTIVE in the identity registry**:
`isBanned() == false`, `isActive() == true`, the ERC-721 still transferable, and every consumer
that treats the identity registry as the source of truth (x402 sellers, ERC-8004 crawlers, the
credit market's `_isBanned`) keeps serving a slashed agent.

**Evidence.** `attacks.py --id AV-010`: `stakeRegistryStatus: 4` (BANNED) with
`identityRegistryBanned: false` and `identityRegistryStillActive: true`.

**Fix (observability + a deploy-time wall, not a behaviour change).**
1. `AvairaStakeRegistry` now emits `BanPropagationFailed(uint256 indexed agentId, address registry)`
   when the low-level call fails, so the divergence is indexable instead of invisible. The slash
   still does not revert — capital penalty and reputation death must not depend on a third
   contract's mood.
2. `contracts/script/Deploy.s.sol` asserts the wiring:
   `require(identity.enforcer() == stake, "identity:enforcer != stake registry")` — a
   mis-deployed stack now fails the deploy instead of shipping a broken trust guarantee.
3. The verification harness refuses to boot without that wiring (`harness.deploy_stack`), so no
   report in `verification/` can ever be produced against a stack that cannot propagate bans.

**Residual.** A registry that *reverts* `banAgent` for another reason still cannot block a slash.
Recorded as **R-06**, with the note that the identity registry's own guard
(`if (_banned[id]) revert`) is the realistic cause and is idempotent-safe.

---

## AV-011 · failed `setAgentWallet` burns the nonce — refuted {#av-011}

**Attack.** `uint256 nonce = agentWalletNonce[agentId]++;` runs *before* signature verification,
which looked like a way to invalidate a wallet-signed authorisation still in flight (spam bad
signatures, shift the nonce, the owner's real payload no longer matches).

**Result.** It cannot work: the failed verification reverts the whole transaction, and the
`++` is rolled back with it. `nonceAfter == nonceBefore` in the scenario. Kept in the suite as a
`BLOCKED` expectation so that "make the nonce increment unconditional" (a plausible-looking
cleanup) trips a documented alarm instead of silently enabling a grief.

---

## AV-012 · suspension cooldown bypass via `stake` — refuted {#av-012}

**Attack.** `stake()` reactivates a SUSPENDED agent when `total >= minStake`, which looked like a
cooldown bypass: slash → top up → eligible again.

**Result.** The reactivation branch is guarded by `block.timestamp >= suspendedUntil[agentId]`,
so topping up inside the cooldown leaves the status at `SUSPENDED` (verified: `statusAfterReStake: 3`).
The gate's own `checkGate` also refuses SUSPENDED before any stake/score check, so even a status
bug would not turn into a bypass.

---

## AV-013 · TypeScript and Python computed different `intentHash` values — **critical, fixed** {#av-013}

**Finding.** The intent commitment is

```
keccak256(abi.encode("Avaira.Intent.v1", agentId, taskId, <plan JSON>, envelopeHash, nonce))
```

The Python SDK serialised the plan with `json.dumps(task, sort_keys=True, separators=(",", ":"))`.
The TypeScript SDK used `JSON.stringify(task)` — insertion-ordered, non-ASCII preserved. Two
different byte strings for the same plan, therefore two different `intentHash` values.

**Consequences, all real:**
* an agent that commits with `@avaira/sdk` and is verified by a counterparty using `avaira`
  (Python) gets `INTENT_NOT_COMMITTED` — the gate blocks work that was legitimately committed;
* a reviewer reconstructing a deviation from the plan text hashes something else and can never
  reproduce the commitment — the "anyone can recompute it" claim in `README.md` and in
  `services/scorer/src/types.ts` was false for any plan with unordered keys or non-ASCII text;
* key order is *stable* within one language, so every unit test in every SDK passed. This is
  exactly the class of bug per-language tests cannot see, and it sat in the trust root.

**Fix.** `sdk/typescript/src/canonical.ts` implements the pinned canonical encoding — keys sorted
at every depth, no insignificant whitespace, non-ASCII escaped `\uXXXX` (including UTF-16 surrogate
pairs for astral characters), `-0 → 0`, `NaN`/`Infinity`/`bigint`/`Date` **rejected rather than
silently mangled** — and `Avaira.hashIntent()` (new, public, tested) is now the one place the
formula lives in TS; `run()` calls it. Python exposes the same operation as `Avaira.hash_intent`.

**Proof.**
* `python3 tools/parity/compare.py` — 42 vectors, byte-identical across **Python**, **TypeScript**
  and the **compiled on-chain** libraries, with negative controls (a swapped leaf and a tampered
  root must fail `MerkleLib.verify`, and do), and it recomputes the *legacy* encodings to show 5
  vectors really did differ before the fix (`legacyDivergenceAV013.vectorsWhereLegacyDiffers`).
* `sdk/typescript/test/canonical.test.ts` — 6 tests: order independence, unicode/astral escaping,
  numeric edges, depth guard, undefined-vs-null.

---

## AV-014 · the Rust core cannot participate in parity — **open, scope decision** {#av-014}

`sdk/avaira-rust-core` is pre-v2 code that is incompatible with the protocol by construction:

| v2 primitive | Rust core today |
| --- | --- |
| `intentHash` = keccak256 of an ABI encoding | `sha2::Sha256` over `format!("{}{}{}{}{}", …)` — different hash, no ABI encoding |
| `intentHash` is public, verifiable by anyone | constructor is `AvairaCore::new(secret: String)`; the field is **never read** in `compute_intent_hash` |
| `RiskEnvelope { uint256 maxSpendUsd, string[] allowedActions, uint64 deadline }` | `{ max_spend_usd: f64, allowed_actions, blocked_actions, max_concurrent_tasks }` — float money, extra fields, **no deadline** |
| spend comparison against the committed cap | `if intent.value_usd > envelope.max_spend_usd` — floats, and no action-hash binding |
| six weighted components, points in `[0, weight]`, integer USDC inputs | `0.30·success_rate + … − 0.20·slash_penalty` on `f64` metrics in 0–100 units: max reachable score is **80**, not 100, and the slash term can drive it below zero into a clamp |
| `AuditTrail` leaves, Merkle root/proof | absent |

Two of these are bugs in their own right: the unused `secret` parameter advertises a keyed hash
that does not exist, and a scorer whose weights sum to 0.8 cannot express the score the chain
stores.

**Decision (rule 4).** Rewriting this crate into a v2 core is not "adding a feature", but it *is*
a rewrite of an artifact we do not currently ship to any customer on the first-run path, and the
brief also assumes a **Move** artifact that does not exist in this repository (see
`SCOPE_PROPOSALS.md#SP-04` — Monad is EVM-compatible and the contracts are Solidity 0.8.37).
So the parity suite reports the Rust artifact as **`skipped`, with the reason**, and never as
passing; `tools/doctor.py` fails if any document claims 4-way parity. The honest claim today is:
**three artifacts (Python, TypeScript, on-chain bytecode) are byte-identical on a fixed corpus.**

---

## AV-015 · the scorer's canonical encoder reordered integer-like keys — **high, fixed** {#av-015}

**Finding.** `services/scorer/src/canonical.ts` sorted object keys and then handed the sorted
*object* to `JSON.stringify`:

```ts
const out = {};
for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
return JSON.stringify(out);          // ← reorders integer-like keys on output
```

`JSON.stringify` emits integer-like keys in ascending **numeric** order regardless of the order you
inserted them, so `{ "0":…, "10":…, "9":… }` serialised as `{"0":…,"9":…,"10":…}` while every other
implementation — Python's `json.dumps(..., sort_keys=True)` included, which compares the *strings* —
produces `{"0":…,"10":…,"9":…}`. Two auditors, one `inputsHash`, different bytes.

**Why it matters.** `inputsHash`/`breakdownHash` are exactly the "we anchored the inputs, go
re-derive them" claim: `postAvairaScore` stores `breakdownHash` and `ScorePosted` emits it, and the
contract never recomputes it, so the whole verification story depends on an independent
implementation reproducing these bytes. Same failure family as AV-013, one layer over, and — like
AV-013 — invisible to any single-language test.

**Found by.** The parity test I wrote for it: `services/scorer/test/canonical.test.ts` shells out to
`python3` and compares byte-for-byte. It failed on the very first vector. That is the value of
cross-layer checks over per-layer ones.

**Fix.** `canonicalJson` now writes the tokens itself (no intermediate object, so `JSON.stringify`
cannot reorder anything) and sorts keys by Unicode **code point** rather than UTF-16 code unit — the
same ordering rule Python uses. The sibling rule in `sdk/typescript/src/canonical.ts` got the same
code-point sort, which changes nothing for ASCII keys but makes astral keys
(`U+1F600` vs `U+FFFF`) agree across languages; `tools/parity/corpus.json` now pins both cases
(vectors "integer-like keys" and "astral key vs U+FFFF"), and the parity run is green on 42 vectors.

**Also asserted, deliberately:** the two encoders are *not* unified. The scorer's keeps non-ASCII
literal, stringifies `bigint` as a decimal string and rounds floats to 6 dp (its inputs are numeric);
the SDK's escapes non-ASCII and rejects `bigint`/non-finite numbers outright (its input is an
agent-authored plan). `test/canonical.test.ts` asserts the divergence, so a future "let's share one
encoder" change fails a test that explains why it would silently break published anchors.
