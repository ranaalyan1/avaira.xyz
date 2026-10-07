# Parity — one commitment, three implementations

Avaira's core promise is computational, not custodial: *anyone* can recompute an agent's
`intentHash` from the plan, and *anyone* can prove a deviation against an anchored Merkle root.
Both promises die the moment two implementations disagree by one byte — and they did (AV-013).
This file is the machinery that makes that class of bug structurally impossible to ship again.

```bash
make parity                                        # the check
python3 tools/parity/gen_corpus.py                 # corpus reproducibility (no --write = verify)
python3 tools/parity/compare.py --json /tmp/p.json # what CI runs
```

## What is compared

`tools/parity/corpus.json` (42 vectors, `sha256 a5923a0d4a932ca0…`) is *pinned expectations*, and
`gen_corpus.py` regenerates it deterministically — a corpus that can only be reproduced by the code
under test would prove nothing, so reproducibility is itself an assertion in the report
(`corpus.reproducibleFromGenerator`).

| group | count | what it pins |
| --- | --- | --- |
| `trees` | 9 | Merkle root + per-leaf proofs, incl. single-leaf and odd-count trees (the duplicate-last-node trap) |
| `adversarialLeaves` | 13 | deviation-leaf encoding at edges: zero spend, `2^256-1`, empty/unicode action names, max nonce |
| `envelopes` | 10 | `envelopeHash` incl. empty allow-list, 255 actions, deadline 0 |
| `intentHashes` | 10 | the full commitment, incl. key-order, non-ASCII, astral, `-0`, integer-like keys |
| `primitives` | 4 | hand-checkable keccak/pair/order edges, so a broken hash is caught even if everything downstream is self-consistent |

Three artifacts must agree with the corpus, byte for byte:

* **Python** — `avaira.audit` + `AvairaClient.hash_intent`/`hash_envelope`
* **TypeScript** — `@avaira/sdk`: `canonicalJson`, `AuditTrail`, `Avaira.hashIntent` (run through
  `tsx`, so it is the *source*, not a build artifact)
* **On-chain** — `MerkleLib` / `RiskEnvelopeLib` / `AvairaProbe`, executed in py-evm from
  `build/avaira/artifacts.json`, so the comparison is against real deployed bytecode, not a
  Solidity re-implementation in Python

Where an artifact legitimately has no counterpart (the chain stores `intentHash` but never computes
it from a plan), the vector is reported as not-applicable and skipped — never silently passed.

## Negative controls

Green parity across three implementations would also be the result of *three implementations that
share one wrong idea*. So the on-chain half must additionally produce the *right failures*:

| control | required outcome | result today |
| --- | --- | --- |
| `correctProofVerifies` | honest leaf + honest proof verifies | `True` |
| `swappedLeafFails` | a leaf from a sibling position fails | `True` |
| `tamperedRootFails` | verification against a fabricated root fails | `True` |

## What this does *not* prove

* It does not prove the *semantics* are right — only that all three compute the same bytes. That is
  `audit/INVARIANTS.md` + `attacks.py`'s job.
* It does not cover `sdk/avaira-rust-core`, which is pre-v2 and cannot express a v2 commitment at
  all (AV-014). The report says `rust: skipped, reason: …`. `tools/doctor.py` fails any document
  that claims four-way parity, so the gap stays visible instead of being smoothed over.
* `breakdownHash` (the scorer's anchor) is a *separate* domain with its own encoder, deliberately
  not unified with the SDK's; the divergence is asserted by
  `services/scorer/test/canonical.test.ts` — see AV-015 for why unifying them casually would break
  published anchors.

## History this exists because of

1. **AV-013** — TS used `JSON.stringify(plan)`, Python used `json.dumps(sort_keys=True, …)`. Every
   per-language test passed; the two SDKs simply disagreed, and honest agents got gate-rejected.
   Fixed by `canonicalJson` + this harness. The report still recomputes the *legacy* encodings and
   counts how many vectors really differed: **7 of 10** intent vectors, with key-order, nested and
   non-ASCII examples recorded in `verification/reports/parity.json`. A fix nobody can show changing
   behaviour is a fix nobody can review.
2. **AV-015** — the scorer's own `canonicalJson` sorted keys and then handed the object to
   `JSON.stringify`, which re-sorts integer-like keys numerically on output. Found *by the parity
   test written to prevent AV-013*, on its first run. Fixed by writing tokens directly and sorting by
   code point (so astral keys order like Python does, not like UTF-16).
