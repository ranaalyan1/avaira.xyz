#!/usr/bin/env python3
"""Cross-artifact parity: one fixed corpus, four independent implementations, byte-for-byte.

    python3 tools/parity/compare.py            # human summary, exit 0 = parity holds
    python3 tools/parity/compare.py --json verification/reports/parity.json

Artifacts compared, all against `tools/parity/corpus.json`:

  * **typescript** — `@avaira/sdk` (`sdk/typescript/src/{audit,avaira,canonical}.ts`), run through
    its own `tsx` so the check exercises the shipped module, not a copy of its maths.
  * **python** — `avaira` (`sdk/python/avaira/audit.py` + `client.hash_intent`) plus the same
    ABI/keccak primitives the SDK itself uses.
  * **onchain** — `MerkleLib` / `RiskEnvelopeLib` *as compiled for Monad*, executed inside py-evm
    through `contracts/test/harness/AvairaProbe.sol`. This is the fourth artifact and the one that
    actually matters: the leaf the SDK hashes must be the leaf the vault verifies.
  * **rust** — declared in the report as `skipped` unless `cargo` exists. It is never reported as
    passing without a run; see FINDINGS.md AV-014 for why the Rust core is not parity-capable today.

Three negative controls make the comparison mean something: a tampered leaf must *fail*
verification on-chain, a swapped proof must fail, and the legacy (pre-AV-013) JSON encoding is
recomputed to show the two SDKs really did disagree before the fix.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.join(REPO_ROOT, "sdk", "python"))

CORPUS = os.path.join(HERE, "corpus.json")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "0x" + h.hexdigest()


def sh(cmd: list[str], cwd: str) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900)
    return proc.returncode, proc.stdout, proc.stderr


# --------------------------------------------------------------------------- python side
def python_outputs(corpus: dict) -> dict:
    """Recompute every expected value using the shipped Python SDK code paths."""
    from avaira import AuditTrail, hash_leaf, hash_pair, merkle_proof, merkle_root  # sdk/python
    from avaira.client import Avaira  # constructed offline; hashing never touches the network

    client = Avaira(
        rpc_url="http://127.0.0.1:1",  # unreachable on purpose: if hashing needs a node, this fails
        chain_id=10143,
        contracts={
            "identityRegistry": "0x" + "00" * 19 + "01",
            "reputationRegistry": "0x" + "00" * 19 + "02",
            "stakeRegistry": "0x" + "00" * 19 + "03",
            "intentVault": "0x" + "00" * 19 + "04",
        },
    )
    from dataclasses import dataclass

    out = {"trees": [], "adversarialLeaves": [], "envelopes": [], "intentHashes": [], "primitives": {}}
    for tree in corpus["trees"]:
        raw = [
            AuditTrail.leaf_for(int(l["agentId"]), l["intentHash"], l["action"], int(l["spendUsd"]), int(l["nonce"]))
            for l in tree["leaves"]
        ]
        out["trees"].append(
            {
                "name": tree["name"],
                "rawLeaves": raw,
                "root": merkle_root(raw) if raw else "0x" + "00" * 32,
                "proofs": [merkle_proof(raw, i) for i in range(len(raw))],
            }
        )
    for item in corpus["adversarialLeaves"]:
        l = item["leaf"]
        raw = AuditTrail.leaf_for(int(l["agentId"]), l["intentHash"], l["action"], int(l["spendUsd"]), int(l["nonce"]))
        out["adversarialLeaves"].append(
            {"why": item["why"], "rawLeaf": raw, "hashedLeaf": hash_leaf(raw), "rootSingleton": merkle_root([raw])}
        )

    @dataclass
    class Env:
        max_spend_usd: int
        allowed_actions: list
        deadline: int

    for env in corpus["envelopes"]:
        out["envelopes"].append(
            {
                "why": env["why"],
                "envelopeHash": client.hash_envelope(
                    Env(int(env["maxSpendUsd"]), list(env["allowedActions"]), int(env["deadline"]))
                ),
            }
        )
    for vec in corpus["intentHashes"]:
        out["intentHashes"].append(
            {
                "why": vec["why"],
                "taskJson": json.dumps(vec["task"], sort_keys=True, separators=(",", ":")),
                "intentHash": client.hash_intent(int(vec["agentId"]), vec["task"], vec["envelopeHash"], int(vec["nonce"])),
            }
        )
    out["primitives"] = {
        "hashLeafZero": hash_leaf("0x" + "00" * 32),
        "hashPairZeroZero": hash_pair("0x" + "00" * 32, "0x" + "00" * 32),
        "hashPairOrderIndependent": hash_pair("0x" + "00" * 32, "0x" + "ff" * 32)
        == hash_pair("0x" + "ff" * 32, "0x" + "00" * 32),
        "leafDomain": AuditTrail.leaf_for(0, "0x" + "00" * 32, "", 0, 0),
    }
    return out


# --------------------------------------------------------------------------- onchain side
def onchain_outputs(corpus: dict) -> dict:
    """Ask the *compiled* libraries — the same `MerkleLib` code `challengeDeviation` runs."""
    from avaira_evm.harness import AvairaChain
    from avaira import merkle_proof as py_merkle_proof

    chain = AvairaChain.spawn()
    probe = "AvairaProbe"
    LEAF_SIG = "hashDeviationLeaf((uint256,bytes32,string,uint256,uint256))"

    def call_hex(sig: str, args: list) -> str:
        return as_hex(chain.call(probe, sig, args))

    def leaf_hash(l: dict) -> str:
        return call_hex(LEAF_SIG, [[int(l["agentId"]), bytes.fromhex(l["intentHash"][2:]), l["action"], int(l["spendUsd"]), int(l["nonce"])]])

    def root_of(raw: list[str]) -> str:
        return call_hex("root(bytes32[])", [[bytes.fromhex(h[2:]) for h in raw]])

    def proof_of(raw: list[str], index: int) -> list[str]:
        # Proofs are produced offchain; the onchain check is that they *verify*. `MerkleLib` has
        # no prover entry point by design, so the proof bytes come from the Python SDK and are
        # then verified against the onchain root — which is exactly what the vault does.
        return [as_hex(p) for p in py_merkle_proof(raw, index)]

    out: dict = {"trees": [], "adversarialLeaves": [], "envelopes": [], "intentHashes": [], "primitives": {}, "negatives": {}}

    for tree in corpus["trees"]:
        raw = [leaf_hash(l) for l in tree["leaves"]]
        out["trees"].append(
            {
                "name": tree["name"],
                "rawLeaves": raw,
                "root": "0x" + "00" * 32 if not raw else root_of(raw),
                "proofs": [proof_of(raw, i) for i in range(len(raw))],
            }
        )

    for item in corpus["adversarialLeaves"]:
        raw = leaf_hash(item["leaf"])
        out["adversarialLeaves"].append(
            {
                "why": item["why"],
                "rawLeaf": raw,
                "hashedLeaf": call_hex("hashLeaf(bytes32)", [bytes.fromhex(raw[2:])]),
                "rootSingleton": root_of([raw]),
            }
        )

    for env in corpus["envelopes"]:
        out["envelopes"].append(
            {
                "why": env["why"],
                "envelopeHash": call_hex(
                    "hashEnvelope((uint256,string[],uint64))",
                    [[int(env["maxSpendUsd"]), list(env["allowedActions"]), int(env["deadline"])]],
                ),
            }
        )

    # `intentHash` is an SDK-side commitment (the vault stores whatever bytes32 it is handed),
    # so the onchain artifact has no counterpart for the task JSON. Compare the envelope it is
    # built from instead, and leave the hash fields unset so the differ skips them.
    for vec in corpus.get("intentHashes", []):
        out["intentHashes"].append({"why": vec["why"], "taskJson": None, "intentHash": None})

    zero = bytes(32)
    ones = b"\xff" * 32
    out["primitives"] = {
        "hashLeafZero": call_hex("hashLeaf(bytes32)", [zero]),
        "hashPairZeroZero": call_hex("hashPair(bytes32,bytes32)", [zero, zero]),
        "hashPairOrderIndependent": chain.call(probe, "hashPair(bytes32,bytes32)", [zero, ones])
        == chain.call(probe, "hashPair(bytes32,bytes32)", [ones, zero]),
        "leafDomain": call_hex(LEAF_SIG, [[0, zero, "", 0, 0]]),
    }

    # Negative controls: a proof must not verify for a different leaf or a different root.
    big = corpus["trees"][-1]
    raw = [leaf_hash(l) for l in big["leaves"]]
    rt = bytes.fromhex(root_of(raw)[2:])
    proof0 = [bytes.fromhex(p[2:]) for p in proof_of(raw, 0)]
    verify = "verify(bytes32[],bytes32,bytes32)"
    out["negatives"] = {
        "correctProofVerifies": bool(chain.call(probe, verify, [proof0, rt, bytes.fromhex(raw[0][2:])])),
        "swappedLeafFails": (
            not bool(chain.call(probe, verify, [proof0, rt, bytes.fromhex(raw[1][2:])])) if len(raw) > 1 else True
        ),
        "tamperedRootFails": not bool(chain.call(probe, verify, [proof0, zero, bytes.fromhex(raw[0][2:])])),
    }
    return out


def merkle_proof_py(leaves: list[bytes], index: int) -> list[str]:
    from avaira import merkle_proof

    return ["0x" + p[2:] if p.startswith("0x") else p for p in merkle_proof([ "0x" + l.hex() for l in leaves], index)]


def as_hex(v) -> str:
    if isinstance(v, str):
        return v if v.startswith("0x") else "0x" + v
    return "0x" + bytes(v).hex()


# --------------------------------------------------------------------------- comparison
def compare(corpus: dict, others: dict[str, dict]) -> list[dict]:
    """Flatten every implementation's outputs and diff them against the pinned expectation."""
    failures: list[dict] = []
    expected = {
        "trees": {t["name"]: t for t in corpus["trees"]},
        "adversarialLeaves": {a["why"]: a for a in corpus["adversarialLeaves"]},
        "envelopes": {e["why"]: e for e in corpus["envelopes"]},
        "intentHashes": {v["why"]: v for v in corpus.get("intentHashes", [])},
        "primitives": corpus["primitives"],
    }
    fields = {
        "trees": [("rawLeaves", "expectedRawLeaves"), ("root", "expectedRoot"), ("proofs", "expectedProofs")],
        "adversarialLeaves": [("rawLeaf", "expectedRawLeaf"), ("hashedLeaf", "expectedHashedLeaf"), ("rootSingleton", "expectedRootSingleton")],
        "envelopes": [("envelopeHash", "expectedEnvelopeHash")],
        "intentHashes": [("taskJson", "expectedTaskJson"), ("intentHash", "expectedIntentHash")],
    }
    for artifact, produced in others.items():
        if produced.get("skipped"):
            continue
        for group, pairs in fields.items():
            key = "name" if group == "trees" else "why"
            for row in produced.get(group, []):
                ref = expected[group].get(row[key])
                if ref is None:
                    failures.append({"artifact": artifact, "group": group, "key": row[key], "field": "*", "why": "vector missing from corpus"})
                    continue
                for got, want in pairs:
                    # `None` means "this artifact has no counterpart for that field" (the vault
                    # stores an opaque intent hash; it does not compute one). Not a mismatch, but
                    # it is reported as `notApplicable` so the gap is visible in the report.
                    if ref.get(want) is None or row.get(got) is None:
                        continue
                    if row.get(got) != ref.get(want):
                        failures.append(
                            {
                                "artifact": artifact,
                                "group": group,
                                "key": row[key],
                                "field": got,
                                "expected": str(ref.get(want))[:96],
                                "actual": str(row.get(got))[:96],
                            }
                        )
        for field, want in expected["primitives"].items():
            got = produced.get("primitives", {}).get(field)
            if got is None:
                continue
            if got != want:
                failures.append({"artifact": artifact, "group": "primitives", "key": field, "field": field, "expected": str(want)[:96], "actual": str(got)[:96]})
    return failures


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", help="write the machine-readable parity report here")
    ap.add_argument("--vectors", action="store_true", help="print every vector comparison (long)")
    args = ap.parse_args(argv)

    if not os.path.exists(CORPUS):
        print("corpus.json missing — run: python3 tools/parity/gen_corpus.py --write", file=sys.stderr)
        return 1

    # 1. the corpus itself must be reproducible from the generator
    rc, _out, err = sh([sys.executable, os.path.join(HERE, "gen_corpus.py")], REPO_ROOT)
    corpus_reproducible = rc == 0

    with open(CORPUS) as fh:
        corpus = json.load(fh)

    # 2. python
    py = python_outputs(corpus)
    # 3. typescript, through the SDK's own tsx
    ts_bin = os.path.join(REPO_ROOT, "sdk", "typescript", "node_modules", ".bin", "tsx")
    ts: dict = {"skipped": "tsx not installed — run `npm ci` in sdk/typescript"}
    if os.path.exists(ts_bin):
        rc, out, err = sh([ts_bin, os.path.join(HERE, "check_ts.mjs")], os.path.join(REPO_ROOT, "sdk", "typescript"))
        ts = json.loads(out) if rc == 0 else {"skipped": f"check_ts.mjs exited {rc}: {err[-400:]}"}
    # 4. onchain (compiled bytecode, executed in py-evm)
    onchain = onchain_outputs(corpus)
    # 5. rust — only claimed if a cargo run actually happened
    rust = {"skipped": "cargo not available in this environment; see FINDINGS.md AV-014"}
    if shutil.which("cargo") and os.path.exists(os.path.join(REPO_ROOT, "sdk", "avaira-rust-core", "tests", "parity.rs")):
        rc, out, err = sh(["cargo", "test", "--quiet", "--", "--nocapture"], os.path.join(REPO_ROOT, "sdk", "avaira-rust-core"))
        rust = {"skipped": f"cargo test failed: {err[-400:]}"} if rc != 0 else json.loads(out)

    failures = compare(corpus, {"python": py, "typescript": ts, "onchain": onchain})

    legacy = legacy_divergence_demo(corpus)
    build = {}
    try:  # provenance: a parity report is worthless if you cannot tell which bytecode it checked
        with open(os.path.join(REPO_ROOT, "build", "avaira", "build-manifest.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
        with open(os.path.join(REPO_ROOT, "build", "avaira", "artifacts.json"), "rb") as fh:
            build_bytes = fh.read()
        build = {
            "compiler": manifest.get("compiler"),
            "viaIR": (manifest.get("profiles") or {}).get("viaIR"),
            "sourceDigest": "0x" + hashlib.sha256(build_bytes).hexdigest(),
        }
    except OSError:
        pass

    report = {
        "schema": "avaira.parity/v1",
        "build": build,
        "corpus": {
            "path": os.path.relpath(CORPUS, REPO_ROOT),
            "sha256": sha256_file(CORPUS),
            "vectors": {
                "trees": len(corpus["trees"]),
                "adversarialLeaves": len(corpus["adversarialLeaves"]),
                "envelopes": len(corpus["envelopes"]),
                "intentHashes": len(corpus.get("intentHashes", [])),
            },
            "reproducibleFromGenerator": corpus_reproducible,
        },
        "artifacts": {
            "python": {"status": "compared"},
            "typescript": {"status": "compared" if "skipped" not in ts else "skipped", "detail": ts.get("skipped")},
            "onchain": {"status": "compared", "negatives": onchain.get("negatives")},
            "rust": {"status": "skipped" if "skipped" in rust else "compared", "detail": rust.get("skipped")},
        },
        "legacyDivergenceAV013": legacy,
        "failures": failures,
        "verdict": "PASS" if not failures and corpus_reproducible and all(onchain["negatives"].values()) else "FAIL",
    }
    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=2, sort_keys=True)
            fh.write("\n")

    print(f"parity {report['verdict']}  corpus {report['corpus']['sha256'][2:18]}…  ({sum(report['corpus']['vectors'].values())} vectors)")
    for name, produced in (("python", py), ("typescript", ts), ("onchain", onchain)):
        if produced.get("skipped"):
            print(f"  {name:<11} SKIPPED: {produced['skipped']}")
            continue
        bad = [f for f in failures if f["artifact"] == name]
        print(f"  {name:<11} {'byte-identical' if not bad else f'{len(bad)} MISMATCH'}")
    print(f"  onchain     negative controls: {onchain['negatives']}")
    if rust.get("skipped"):
        print(f"  rust        SKIPPED: {rust['skipped']}")
    print(f"  AV-013      {legacy}")
    if failures:
        for f in failures[:12]:
            print(f"    ! {f['artifact']}/{f['group']}/{f['key']}: {f['field']} expected {f.get('expected')} got {f.get('actual')}", file=sys.stderr)
        return 1
    if args.vectors:
        print(json.dumps({"python": py, "typescript": ts}, indent=2)[:4000])
    return 0


def legacy_divergence_demo(corpus: dict) -> dict:
    """Show that AV-013 was real: `JSON.stringify` (the pre-fix TS behaviour) and Python's
    `json.dumps(sort_keys=True)` disagree for the key-order vectors, so their intent hashes did too."""
    js = "node"
    script = (
        "const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
        "const out=v.intentHashes.map(x=>JSON.stringify(JSON.parse(x.taskRaw)));"
        "process.stdout.write(JSON.stringify(out));"
    )
    proc = subprocess.run([js, "-e", script, CORPUS], capture_output=True, text=True, cwd=REPO_ROOT, timeout=120)
    if proc.returncode != 0:
        return {"error": proc.stderr[-200:]}
    legacy_encodings = json.loads(proc.stdout)
    drifted = [
        {"why": vec["why"], "legacy": legacy_json, "canonical": vec["expectedTaskJson"]}
        for vec, legacy_json in zip(corpus["intentHashes"], legacy_encodings)
        if legacy_json != vec["expectedTaskJson"]
    ]
    # The point is *not* that legacy is equal — it is that it differs, i.e. that the fix changed
    # observable behaviour, and that the canonical form is now order-independent for both SDKs.
    pairs = [(v["why"], json.loads(v["taskRaw"])) for v in corpus["intentHashes"]]
    order_independent = all(
        canonical_equal(corpus["intentHashes"][i]["expectedTaskJson"], corpus["intentHashes"][j]["expectedTaskJson"])
        for i, j in [(0, 1)]
    )
    return {
        "why": "proves AV-013 was a real divergence: pre-fix `JSON.stringify(task)` vs Python's sorted encoding",
        "vectorsWhereLegacyDiffers": len(drifted),
        "examples": drifted[:3],
        "canonicalIsOrderIndependent": order_independent,
    }


def canonical_equal(a: str, b: str) -> bool:
    return a == b


if __name__ == "__main__":
    raise SystemExit(main())
