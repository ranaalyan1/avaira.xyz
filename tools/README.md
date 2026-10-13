# Avaira Verification Suite — specs, oracle and proofs

This directory is the machinery behind the claims in [`/STATE.md`](../STATE.md) and
[`/FINDINGS.md`](../FINDINGS.md). Nothing here ships to users; everything here is
executable, and every claim the repository makes about correctness is backed by a file in
here.

## Layout

| Path | What it is | Run it |
| --- | --- | --- |
| `compile.mjs` | Toolchain-free Solidity compiler (solc-js 0.8.37, viaIR, Cancun, 200 optimizer runs) producing `build/avaira/*` + `error-catalog.json` + `build-manifest.json` | `npm --prefix tools ci && node tools/compile.mjs` |
| `avaira_evm/harness.py` | In-process py-evm chain (Cancun-pinned) with the whole Avaira stack deployed and wired exactly like `contracts/script/Deploy.s.sol` | imported by everything below |
| `avaira_evm/campaign.py` | Seeded, reproducible **stateful invariant campaign** against the real bytecode | `python3 tools/avaira_evm/campaign.py --sequences 1000 --depth 16` |
| `avaira_evm/attacks.py` | Team RED: 12 named attack scenarios, each asserting the outcome the docs claim | `python3 tools/avaira_evm/attacks.py` |
| `avaira_evm/reverts.py` | Decodes revert payloads into `CustomError(args) [file:line]` and flags Solidity `Panic` | used by the two above |
| `parity/gen_corpus.py` | Generates/verifies the fixed 42-vector parity corpus | `python3 tools/parity/gen_corpus.py` (idempotence check) |
| `parity/compare.py` | Compares Python, TypeScript and the **compiled on-chain** libraries byte-for-byte, with negative controls | `python3 tools/parity/compare.py` |
| `aggregate_campaigns.py` | Merges shard reports into one matrix verdict, refusing to combine shards built from different bytecode | `python3 tools/aggregate_campaigns.py verification/reports/campaign-shard-*.json` |
| `parity/check_ts.mjs` | The TypeScript half of the parity run (drives the SDK source through `tsx`) | used by `compare.py` |
| `gen_contract_specs.py` | Regenerates `audit/specs/*.md` from the build (ABI, selectors, NatSpec, sizes) — never hand-written | `python3 tools/gen_contract_specs.py --check` |
| `demo.py` | `make demo`: the whole lifecycle on a local chain; `--check` diffs the trace against `demo-expect.txt` | `python3 tools/demo.py --json` |
| `doctor.py` | Machine-checks the repository's own claims: stale reports, dead Makefile targets, invariant ids documented but never evaluated, docs citing files that don't exist, overclaiming prose | `python3 tools/doctor.py` |

## Why an in-process chain instead of only Foundry

`forge test` is the right tool and `contracts/test/invariant/` uses it. But "run the proof"
has to work on a laptop with no Foundry, no Docker daemon and no RPC key — otherwise the
verification command is a costume. py-evm gives us the actual compiled bytecode, the actual
Cancun opcode set, and deterministic time control, in `python3 tools/…`.

Two honest limits:

* py-evm is ~100× slower than geth/anvil, so this harness measures **correctness**, never gas
  or wall-clock latency. Gas numbers come from `contracts/test/benchmark/GasBenchmark.t.sol`
  on a real toolchain, and latency claims come from `sdk/typescript`'s benchmark against an
  actual Monad RPC.
* A revert with no returndata is reported as "reverted without data". Custom errors decode
  fully; `require("string")` reverts decode as the string; `Panic` decodes to its code. The
  campaign treats any `Panic` as a violation, so an unexplained revert can never hide.

## The build manifest and why reports are dated

`tools/compile.mjs` writes two side-files next to the bytecode:

* `build/avaira/error-catalog.json` — every custom error's selector, signature, declaring file:line
  and the NatSpec that explains it. This is what lets `reverts.py` decode a revert into
  `AgentIsSuspended(uint256)(2) [AvairaStakeRegistry] src/core/AvairaStakeRegistry.sol:88` instead of
  `0x…`, and what `audit/specs/*.md` is generated from.
* `build/avaira/build-manifest.json` — compiler, `viaIR`/optimizer/`evmVersion` profile, whether the
  profile matches `contracts/foundry.toml` (`matchesFoundryProfile`), the source list and the size of
  the error catalog.

Every report embeds `build.sourceDigest = sha256(build/avaira/artifacts.json)` — the digest of the
bytecode it actually executed, not of the sources. That is what makes the committed reports
auditable rather than decorative: `tools/doctor.py` recomputes the digest and **fails if a report
disagrees with the build in the tree**. Recompile after editing a contract and CI turns red until
`make redteam parity fuzz` is re-run, so a `FINDINGS.md` describing bytecode nobody has built since
cannot quietly stay green. `make doctor` prints the digest it checked against, so there is no number
to copy into a document and let rot.
