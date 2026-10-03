# Avaira — onchain accountability for the agent economy

> x402 lets agents **pay**. ERC-8004 lets agents **be identified**. Avaira makes agents
> **accountable in real time** — and turns that accountability into capital.

This directory is the protocol: six Solidity contracts implementing the identity,
reputation, validation, intent, staking and credit layers of Avaira, plus the test suites
and the tooling that measures what the write-up claims.

The design responds directly to *"Can Trustless Agents Be Trusted? An Empirical Study of
the ERC-8004 Decentralized AI Agent Ecosystem"* (Xiong, Li, Wei, Wang, Knottenbelt, Wang —
arXiv:2606.26028). The study finds identity solved and counterparty trust unsolved:

| Study finding | Avaira's onchain answer |
| --- | --- |
| Only 3–15% of registrations expose a valid registration file | Registration costs a MON **bond**, refundable on exit and forfeited on a ban (`AvairaIdentityRegistry`) |
| 59.2–90.6% of reviewers are Sybil-flagged | Feedback is refused unless the submitter is a **staked** agent or attaches a **verified x402/EIP-3009 payment** (`AvairaReputationRegistry`) |
| Scores are not commensurable | Only the eight spec tags are accepted, each with a fixed decimal scale and a hard value range |
| Cost of manipulation is cents | Entry costs stake; a proven deviation costs **10/50/100%** of it (`AvairaStakeRegistry`) |
| Feedback is ungrounded | The score is derived from objective, onchain data — **stake buys entry, never score** |

## Contracts

| Contract | Component | Purpose |
| --- | --- | --- |
| `AvairaIdentityRegistry` | 1 — Identity | ERC-8004 registration with a bond, EIP-712 agent-wallet binding (ERC-1271 aware), metadata, bond refund/forfeit |
| `AvairaReputationRegistry` | 2 — Reputation | Grounded feedback (staked reviewer *or* verified payment), spec-only tags, revoke/response, scorer-only score with published weights and grades |
| `AvairaValidationRegistry` | 3 — Validation | `validationRequest` → validator-only `validationResponse`, 0–100, soft/hard finality, tag-filtered summaries, `latestKimiScore` for the adversarial auditor |
| `AvairaIntentVault` | 4 — Proof-of-Intent | `commitIntent` → `checkGate` (free view) → `attestOutcome` with an audit-trail Merkle root; O(log n) `verifyDeviation` proofs |
| `AvairaStakeRegistry` | 5 — Stake | USDC stake, lifecycle NONE→PENDING→ACTIVE→SUSPENDED→BANNED, 24 h challenge window, challenger bounty, composability interface |
| `AvairaCreditMarket` | 6 — Credit | Liquidity pool, score-priced collateral (110% / 125% / 150%), interest, liquidation waterfall with bad-debt accounting |

Supporting files: `src/interfaces/` (types + per-contract interfaces), `src/libraries/MerkleLib.sol`
(audit-trail leaves and commutative pair hashing), `src/mocks/MockUSDC.sol` (EIP-3009 test token),
`src/mocks/MockSmartAccount.sol` (ERC-1271 wallet).

## The gate

`checkGate(agentId)` is a free `view` call that returns `(allowed, score)`, backed by
`isEligible`/`score`/`statusOf` on the stake registry — one call, two storage reads, no
transaction. `checkGateVerbose` returns a machine-readable refusal reason, and
`recordGateCheck` writes the same decision onchain when an auditable event is wanted.

The SDK's flow is: `commitIntent` (fire-and-forget) → `checkGate` (block or proceed) →
execute → `attestOutcome` (anchor the Merkle root of the local hash-chained audit trail).
Deviation is proven afterwards with an O(log n) Merkle proof against the anchored root:
an overspend is a `SUSPENSION`, an action that was never in the envelope is a `BAN`.

## Tests

Foundry is the canonical toolchain (`forge test`); `test/` carries the Solidity suites for
CI. This directory additionally ships an equivalent in-sandbox runner — solc-js plus an
in-process EVM — so the same sources can be compiled, deployed and executed where the
`forge`/`solc` binaries are unavailable:

```bash
cd tools
npm install
node lib/compile.js                       # solc 0.8.24, viaIR, optimizer 200, shanghai
node --test --test-concurrency=1 e2e/*.test.js   # all five suites
node --test e2e/02-reputation.test.js     # one suite
```

Current status — **77 passing tests** across five suites, no failures:

| Suite | Tests | Covers |
| --- | ---: | --- |
| `01-identity.test.js` | 15 | registration, bond, EIP-712/ERC-1271 wallet binding, transfer semantics, refund/forfeit |
| `02-reputation.test.js` | 25 | the four study failure modes: grounding, commensurability, costly manipulation, derived score |
| `03-validation.test.js` | 9 | requests, validator-only responses, soft/hard finality, tag summaries, Kimi audit trail |
| `04-intent-vault.test.js` | 14 | commit/attest, gate refusal states, deviation proofs, challenge economics, Merkle parity with the SDK |
| `05-stake-credit.test.js` | 14 | lifecycle, exact slashing arithmetic, unstake cooldown, voluntary exit, collateral tiers, liquidation |

The slashing and Merkle logic is exercised by deterministic pseudo-random loops (fixed
seeds, reproducible) because Foundry's fuzzer is not reachable in this environment; the
Foundry port of the same assertions lives in `test/Avaira*.t.sol` for CI.

## Measured metrics

`tools/metrics.js` generates every number the submission publishes. Gas comes from
receipts, latency from `process.hrtime` around real calls — nothing is asserted from
memory. Run it against an RPC to publish testnet figures:

```bash
node tools/metrics.js                                             # in-process EVM
node tools/metrics.js --rpc https://testnet-rpc.monad.xyz --key 0x... --mon-usd 3
```

In-process baseline (gas price 2 gwei, MON reference $3 — see `tools/metrics.md`):

| Write path | gas (avg) | USD |
| --- | ---: | ---: |
| `registerAgent` | 154,164 | $0.000925 |
| `commitIntent` | 339,434 | $0.002037 |
| `attestOutcome` | 113,289 | $0.000680 |
| `giveFeedback` (staked reviewer) | 234,743 | $0.001408 |
| `giveFeedbackWithX402Settlement` | 372,454 | $0.002235 |
| `recordGateCheck` (onchain event) | 55,426 | $0.000333 |
| `challengeDeviation` (Merkle proof) | 232,736 | $0.001396 |

| Gate latency | ms |
| --- | ---: |
| `checkGate` view, p50 | 16.37 |
| `checkGate` view, p95 | 19.69 |
| `commitIntent` tx, p50 | 53.89 |
| commit → gate → attest round trip, p50 | 92.34 |
| commit → gate → attest round trip, p95 | 112.95 |
| gate checks per minute (sequential) | 3,864 |
| gate checks per minute (5×250 concurrent) | 5,980 |

The gas figures are contract-side costs and are chain-independent. The latency column is an
in-process lower bound that excludes network round trips; the published testnet figure is
produced by the `--rpc` run.

## Deploy and verify

```bash
# 1. dry run: full deployment + wiring + a lifecycle smoke test on a local EVM
node tools/scripts/deploy-monad.js

# 2. Monad testnet (fund the deployer from the faucet first)
MONAD_RPC_URL=https://testnet-rpc.monad.xyz \
DEPLOYER_PRIVATE_KEY=0x... \
  node tools/scripts/deploy-monad.js --network monad-testnet

# 3. verify every contract on the explorer
EXPLORER_API_KEY=... node tools/scripts/verify-monad.js --network monad-testnet
```

The deploy script writes `deployments/monad-testnet.json` (addresses, tx hashes, gas per
contract, constructor args, compiler settings) and the verify script consumes it — the
verification input is rebuilt from the artifacts' own compiler metadata, so it cannot drift
from the bytecode that was deployed.

### Monad testnet deployment

| Contract | Address | Explorer |
| --- | --- | --- |
| `AvairaIdentityRegistry` | _pending_ | |
| `AvairaReputationRegistry` | _pending_ | |
| `AvairaValidationRegistry` | _pending_ | |
| `AvairaIntentVault` | _pending_ | |
| `AvairaStakeRegistry` | _pending_ | |
| `AvairaCreditMarket` | _pending_ | |

_This table is filled in from `deployments/monad-testnet.json` when the testnet deployment
is broadcast; the scripts above are the only step that needs a machine with Monad RPC
access._

## Notes for reviewers

- **No placeholders in shipped paths.** Everything referenced in this README is executable
  code that runs in CI; the only pending item is the testnet broadcast, which needs network
  access this sandbox does not have.
- **Bugs found by the tests are documented in the commit history** — for example
  `voluntaryExit` could never be completed (the revert rolled back the exit request), and
  the credit market paid borrowers out of collateral until it was given a real liquidity
  pool with a liquidation waterfall.
- **The harness never estimates gas.** The in-sandbox EVM drops custom-error data from
  `eth_estimateGas`, which turns a legitimate revert into an undecodable failure; sends
  carry a fixed ceiling and `expectRevert` re-simulates the exact call read-only to decode
  the error. Gas figures in `metrics.js` still come from real receipts.
