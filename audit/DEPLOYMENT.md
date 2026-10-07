# Deployment audit notes

What a deployer must get right, what is verified automatically, and what is *not* verified anywhere
and therefore has to be checked by a human. The gap list at the bottom is the valuable part.

## Artifacts

| contract | deployed size | source | notes |
| --- | --- | --- | --- |
| `AvairaIntentVault` | 9,129 B | `contracts/src/core/AvairaIntentVault.sol` | the gate + commitment store; `MAX_CHALLENGE_WINDOW` bound lives here |
| `AvairaStakeRegistry` | 8,182 B | `contracts/src/core/AvairaStakeRegistry.sol` | slash ladder, `isEligible`, bounty split |
| `AvairaReputationRegistry` | see report | `contracts/src/core/AvairaReputationRegistry.sol` | grounded feedback, `gradeOfScore` = the band table of record |
| `AvairaValidationRegistry` | see report | `contracts/src/core/AvairaValidationRegistry.sol` | ERC-8004 validation responses, appeal tags |
| `AvairaIdentityRegistry` | see report | `contracts/src/core/AvairaIdentityRegistry.sol` | ERC-721 agent identity, `hashAgentWalletSet` EIP-712 oracle, enforcer-gated `banAgent` |
| `AvairaCreditMarket` | see report | `contracts/src/core/AvairaCreditMarket.sol` | collateralised capacity |
| `MockUSDC` | — | `contracts/src/mocks/` | **test only** — never deploy; see gap G-01 |
| `AvairaProbe` | — | `contracts/test/harness/` | **harness only** — read-only oracle, deliberately absent from `Deploy.s.sol`; `tools/doctor.py` fails CI if it ever appears there |

Exact sizes, ABIs, selectors and every custom error with its declaring line are generated into
[`specs/`](specs/) by `make specs` — do not hand-edit those files, regenerate them.

## Deployment order and wiring

`contracts/script/Deploy.s.sol` is the single source of order. The wiring it asserts (and the
harness refuses to boot without, so no report in `verification/` can come from a mis-wired stack):

1. `MockUSDC` (testnet only) →
2. `AvairaIdentityRegistry(registrationBond, admin)` →
3. `AvairaReputationRegistry(identity, 0x0, usdc, admin)` →
4. `AvairaValidationRegistry(identity, admin)` →
5. `AvairaStakeRegistry(usdc, identity, reputation, minStake, minScore, admin)` →
6. `AvairaIntentVault(identity, stake, usdc, challengeWindow, admin)` →
7. `AvairaCreditMarket(usdc, stake, vault, treasury)` →
8. **`identity.setEnforcer(stake)`** → 9. roles granted (`SCORER_ROLE`, `SLASHER_ROLE`) →
   10. `transferOwnership` to the multisig.

Step 8 is the one that is easy to skip and expensive to miss: **AV-010** is exactly this — a BAN
that slashes capital but leaves the agent `ACTIVE` in the identity registry, i.e. still servable by
every consumer that trusts ERC-8004. Post-fix, the failure is loud (`BanPropagationFailed`), the
deploy script requires the wiring, and the harness will not start without it.

## Pre-flight checklist (before any real chain)

```bash
make verify                      # compile + tests + redteam + parity + demo + doctor
forge test -vvv                  # in contracts/ (CI-only on this machine — no forge here)
forge build --sizes              # >24 KB check on every artifact
node tools/compile.mjs && python3 tools/doctor.py
```

Manual, and nothing in this repo can do it for you:

- [ ] `usdc` is the **real** settlement token for that chain, not a mock (G-01: no real-token path is tested here)
- [ ] `treasury` is a receiving address you control and monitor
- [ ] `minStake` / `minScore` / `challengeWindow` / `challengerBond` values are written down with their reasoning, and reviewed against SP-01/SP-03 (a bond > expected bounty means nobody reports)
- [ ] admin = multisig with a 2-of-3-or-more threshold; the deploy key is revoked after step 10 (SP-05 is open: no timelock exists yet)
- [ ] explorer verification submitted (`make verify-monad`), and `audit/specs/` regenerated from the deployed build
- [ ] indexers subscribe to `OutcomeAttested`, `DeviationUpheld`, `ChallengeRejected`, `BanPropagationFailed`, `Slashed`, `GateChecked`
- [ ] a human has read [`../FINDINGS.md`](../FINDINGS.md) and signed the accepted rows in [`RISK_REGISTER.md`](RISK_REGISTER.md)

## Verified vs unverified, explicitly

| claim | status |
| --- | --- |
| gate verdict equals (status ∧ stake ∧ score) in every fuzzed state | **verified** — `INV-GATE-01`, 8,000 evaluations per shard |
| `checkGate` and `isEligible` never disagree | **verified** — `INV-GATE-02` |
| no `Panic` from any protocol call in 32,109 transitions | **verified** — `INV-PANIC-01` |
| the registry holds the stake it accounts for | **verified** — `INV-LEDGER-02` |
| Python/TS/on-chain commitments are byte-identical | **verified** — `make parity`, 42 vectors |
| an agent cannot escape a slash by exiting early | **not true today** — R-01, SP-01 |
| real USDC behaves as assumed | **untested** — R-07, SP-09 |
| admin keys are governed | **not true today** — R-04, SP-05 |
| gas/latency numbers in `metrics/` reflect Monad mainnet | **no** — testnet + local measurements; `make measure-monad` regenerates |
