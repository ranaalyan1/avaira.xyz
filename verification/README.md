# `verification/` — evidence, not assertions

Two things live here:

1. **`reports/`** — machine-readable JSON produced by the checks below. Committed on purpose: a
   finding without its artifact is an anecdote. Each report carries `build.sourceDigest`, so a stale
   report is detectable — and `tools/doctor.py` fails CI when one is stale.
2. **`verify_*.py`** — pre-existing product smoke scripts (UI/v2 hardening/pivot), kept as-is; they
   are not part of the protocol verification suite and are not referenced by `make check`.

## The reports

| file | produced by | what it proves | current verdict |
| --- | --- | --- | --- |
| `reports/redteam.json` | `make redteam` | 12 named attack scenarios against the compiled bytecode, each matched against its *declared* expectation (`BLOCKED` for fixed/guard-holds, `EXPLOIT-CONFIRMED` for accepted risks) | 12/12 match, 0 mismatches |
| `reports/campaign.json` | `make fuzz` | the 4-seed invariant matrix, merged from shards; refuses to merge if any shard ran different bytecode | PASS, 0 violations |
| `reports/campaign-shard-<seed>.json` | `campaign.py --out` | per-seed detail: calls, reverts, revert histogram by decoded error, per-invariant evaluation counts, violations with replay commands | see `campaign.json` |
| `reports/parity.json` | `make parity` | 42 canonical-encoding vectors byte-identical across Python / TypeScript / on-chain, negative controls, corpus reproducibility, and the count of vectors where the *pre-fix* encodings really differed | PASS |

`campaign.json` also carries `invariantsNeverEvaluated`. A declared invariant that nothing checks is
a bug in this repo, so it is reported explicitly rather than being averaged away.

## Reproducing everything

```bash
make install-verification          # python deps for the EVM harness (web3 + eth-tester + py-evm)
node tools/compile.mjs             # build/avaira/*  (viaIR, Cancun, optimizer — mirrors foundry.toml)
make redteam                       # -> reports/redteam.json
make fuzz                          # 4 shards + merge -> reports/campaign.json
make parity                        # -> reports/parity.json
python3 tools/demo.py --check      # deterministic lifecycle trace vs tools/demo-expect.txt
python3 tools/doctor.py            # claims vs checks
```

Nothing here needs a testnet, an RPC URL, a faucet, an API key, or network access at all. `make fuzz`
is ~11 minutes wall-clock on 2 cores (4 shards, 500 sequences × 12 ops each); `make check` is the
minutes-scale subset CI runs on every push.

If you rebuild (`node tools/compile.mjs`) the digest changes and every report becomes stale by
construction — re-run the layers, or `doctor` tells you exactly which ones. That is deliberate: the
alternative is a repository where `FINDINGS.md` describes bytecode nobody has compiled since.

## Reading a report

```bash
python3 - <<'PY'
import json
r = json.load(open("verification/reports/campaign.json"))
print(r["verdict"], r["totals"])
print(r["invariantEvaluationsById"])
for v in r["violations"]:
    print(v["invariant"], v["detail"], "| replay:", v.get("replay", ""))
PY
```

Two ways to read what the fuzzer hit:

* `revertKinds` (per shard) keys the **fully decoded** revert — custom error name, arguments, and
  the `file:line` that declared it, via `build/avaira/error-catalog.json` — so a bucket is replayable.
* `revertKindsByError` (merged matrix) folds those into per-error counts, and `revertDecodeCoverage`
  says what share of reverts decoded to a named error at all. A low percentage would mean the fuzzer
  is mostly hitting `require(string)` reverts or bare reverts — i.e. guards we have not given a name,
  which is itself a finding, not a shrug.
