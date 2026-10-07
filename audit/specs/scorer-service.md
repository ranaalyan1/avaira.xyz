# Scorer service (`services/scorer`) and the on-chain band table

> Hand-maintained, because it spans two languages on purpose: the chain is the source of truth for
> grades, the service must agree with it, and that agreement is what AV-009 was about.

## Where truth lives, and what checks it

| property | source of truth | check |
| --- | --- | --- |
| grade bands (A+ ≥90, A ≥80, B ≥70, C ≥60, D below) | `AvairaReputationRegistry.gradeOfScore` | `test/grade-parity.test.ts` parses the Solidity and compares all 101 scores; `attacks.py --id AV-009` compares them against the **compiled** contract |
| weight table sums to 100 points | `WEIGHTS` in `src/types.ts` | `test/formula.test.ts` (INV-REP-03) |
| score bounded to 0–100 for adversarial inputs | `computeScore` | `test/formula.test.ts` |
| eligibility is enforced by **caps**, not by weights | `computeCaps` (banned → 0, suspended → 55, under-staked / recent-deviation / mostly-unfulfilled → 59) | `test/formula.test.ts` |
| canonical bytes behind `inputsHash`/`breakdownHash` | `src/canonical.ts` | `test/canonical.test.ts` against `python3 json.dumps(..., sort_keys=True)` |

## Public surface

```ts
// src/formula.ts
export function computeComponents(inputs: ScoreInputs, nowSeconds: number): ComponentScore[]
export function computeCaps(inputs: ScoreInputs, nowSeconds: number, blockCap?: number): ScoreCap[]
export function computeScore(inputs, nowSeconds, penalty?): ScoreResult   // {components, subtotal, caps, penalty, score, grade}
export function gradeForScore(score: number): string                      // must equal the chain's gradeOfScore
export function decayedSlashPenalty(events, nowSeconds, halfLifeDays?): number
export function consistencySpread(attested, windows?): number | null      // null when there is not enough data
export function smoothedRate(successes, attempts, prior, alpha): number   // Laplace-style prior
export const MAX_AUDIT_PENALTY = 15
export function weights(): Record<ComponentKey, number>

// src/canonical.ts  (scorer domain: sorts by code point, 6-dp floats, bigint as decimal string)
export function canonicalJson(value: unknown): string
export function hashCanonical(value: unknown): Hex
export function evidenceDocument(breakdown): string
```

## Two properties worth knowing before you integrate

* **The maximum reachable score is 97.5, not 100.** Every ratio component is smoothed toward a
  prior and `appealWinRate` has no appeals to judge, so `score === 100` never fires. `A+` (≥90)
  does. `test/formula.test.ts` pins this so nobody "fixes" it by clamping up.
* **`breakdownHash` is a commitment nobody on-chain recomputes.** `postAvairaScore` stores it and
  `ScorePosted` emits it, and verification is entirely "re-derive it from the published inputs with
  this encoder". That is why `canonical.ts` is pinned against Python in a test even though no Python
  scorer exists yet — see FINDINGS.md AV-015 for the bug that pinning found.

## Known gaps (also in STATE.md)

* `package.json` `main` points at `./src/index.ts`, which does not exist; there is no CLI or HTTP
  entry point in this service, so `make score` / `make leaderboard` cannot work. Declared, not
  hidden — `tools/doctor.py` reports it.
* There is no test that exercises `scoreFromOnchain`/RPC reads, because the service currently ships
  no reader; every number above is derived from inputs a caller supplies.
