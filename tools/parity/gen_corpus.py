#!/usr/bin/env python3
"""Generate the fixed cross-artifact parity corpus.

    python3 tools/parity/gen_corpus.py [--write]

The corpus is the anchor of the parity claim: a set of *inputs* plus the outputs the Python SDK
(`sdk/python/avaira`) computes for them, pinned to disk. Every other artifact — the TypeScript
SDK, the onchain `MerkleLib`/`RiskEnvelopeLib` as compiled into bytecode, and the Rust core —
has to reproduce those outputs byte-for-byte (`tools/parity/compare.py`).

Inputs are chosen to be *unpleasant*, not merely random: empty strings, a 200-byte action,
non-ASCII, embedded NULs, `2**256-1` spends, duplicate leaves, odd tree sizes, zero and max
`intentHash`, 33-leaf trees. Those are exactly where two implementations of "abi.encode +
keccak + sorted pairs" tend to part ways.

The file is generated, committed, and its sha256 is printed in every report. Regeneration is
idempotent: running this without `--write` exits 1 if the corpus on disk is not what the
generator would produce, so a hand-edit cannot sneak through (`make parity-check`).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, os.path.join(REPO_ROOT, "sdk", "python"))

# Import the module, not the package: `avaira/__init__.py` pulls in the web3/httpx client, and
# hashing must stay dependency-free (that is what makes `chainless` usable in a scratch venv).
from avaira.audit import AuditTrail, hash_leaf, hash_pair, merkle_proof, merkle_root  # noqa: E402

from eth_utils import keccak as _keccak  # noqa: E402

#: Same constant as `RiskEnvelopeLib.ENVELOPE_TYPEHASH` in contracts/src/lib/AvairaTypes.sol.
ENVELOPE_TYPEHASH = _keccak(b"RiskEnvelope(uint256 maxSpendUsd,bytes32 allowedActionsHash,uint64 deadline)")

CORPUS = os.path.join(HERE, "corpus.json")
INTENT_HASH = "0x" + hashlib.sha256(b"avaira.parity.intent.v1").hexdigest()[:64]
ACTIONS = ["web.search", "mcp.call", "swap.execute", "email.send", "db.write", "file.read"]
TREE_SIZES = [0, 1, 2, 3, 5, 8, 9, 17, 33]


def lcg(seed: int):
    state = seed & 0xFFFFFFFF

    def nxt() -> int:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state

    return nxt


def leaf(agent_id: int, intent_hash: str, action: str, spend: int, nonce: int) -> dict:
    return {
        "agentId": str(agent_id),
        "intentHash": intent_hash,
        "action": action,
        "spendUsd": str(spend),
        "nonce": str(nonce),
    }


def build_leaves() -> tuple[list[dict], list[dict]]:
    trees = []
    for size in TREE_SIZES:
        rnd = lcg(1000 + size)
        leaves = [
            leaf(7, INTENT_HASH, ACTIONS[rnd() % len(ACTIONS)], (rnd() % 5_000_000) + 1, i) for i in range(size)
        ]
        trees.append({"name": f"tree-{size}", "leaves": leaves})

    adversarial = [
        (leaf(0, "0x" + "00" * 32, "", 0, 0), "zero ids, empty action"),
        (leaf(7, "0x" + "ff" * 32, "a" * 96, 1, 1), "action at the 96-byte contract limit"),
        (leaf(7, INTENT_HASH, "b" * 200, 2, 2), "action above the 96-byte limit"),
        (leaf(1, INTENT_HASH, "ünïcode.✓.日本語", 3, 3), "non-ASCII action"),
        (leaf(2, INTENT_HASH, "x{a,b},c", 4, 4), "braces and commas in the action"),
        (leaf(3, INTENT_HASH, "nul\x00byte", 5, 5), "embedded NUL byte"),
        (leaf(4, INTENT_HASH, "tab\tnewline\n", 6, 6), "control characters"),
        (leaf(5, INTENT_HASH, "swap.execute", 2**256 - 1, 7), "uint256::MAX spend"),
        (leaf(6, INTENT_HASH, "swap.execute", 2**128, 8), "2**128 spend (word boundary)"),
        (leaf(2**128, INTENT_HASH, "web.search", 1, 9), "agentId past int128"),
        (leaf(2**256 - 1, INTENT_HASH, "web.search", 1, 2**256 - 1), "max agentId and nonce"),
        (leaf(7, INTENT_HASH, "email.send", 9, 9), "duplicate-A"),
        (leaf(7, INTENT_HASH, "email.send", 9, 9), "duplicate-B (same values, different position)"),
    ]
    return trees, [{"why": why, "leaf": l} for l, why in adversarial]


def build_envelopes() -> list[dict]:
    return [
        {"why": "two actions", "maxSpendUsd": "5000000", "allowedActions": ["web.search", "mcp.call"], "deadline": "1893456000"},
        {"why": "zero cap", "maxSpendUsd": "0", "allowedActions": ["email.send"], "deadline": "1893456000"},
        {"why": "empty allow-list", "maxSpendUsd": "1", "allowedActions": [], "deadline": "0"},
        {"why": "one action", "maxSpendUsd": "1", "allowedActions": ["only"], "deadline": "1"},
        {"why": "32 actions (contract limit)", "maxSpendUsd": "123456789", "allowedActions": [f"a{i}" for i in range(32)], "deadline": "1893456000"},
        {"why": "duplicate actions", "maxSpendUsd": "7", "allowedActions": ["dup", "dup", "dup"], "deadline": "8"},
        {"why": "uint64 max deadline", "maxSpendUsd": "8", "allowedActions": ["web.search"], "deadline": str(2**64 - 1)},
        {"why": "order matters (A,B)", "maxSpendUsd": "9", "allowedActions": ["a", "b"], "deadline": "9"},
        {"why": "order matters (B,A)", "maxSpendUsd": "9", "allowedActions": ["b", "a"], "deadline": "9"},
        {"why": "unicode action", "maxSpendUsd": "10", "allowedActions": ["✓.ok"], "deadline": "10"},
    ]


def envelope_typehash_and_hash(env: dict) -> tuple[str, str]:
    """`RiskEnvelopeLib.hash` via the Python SDK's own constants.

    `avaira.client.Avaira.hash_envelope` needs a client object (and therefore a provider
    config), so the parity corpus uses the same primitives directly: keccak of
    abi.encode(ENVELOPE_TYPEHASH, maxSpend, keccak(abi.encode(actions)), deadline).
    """
    from eth_abi import encode as abi_encode
    from eth_utils import keccak

    actions_hash = keccak(abi_encode(["string[]"], [env["allowedActions"]]))
    digest = abi_encode(
        ["bytes32", "uint256", "bytes32", "uint64"],
        [ENVELOPE_TYPEHASH, int(env["maxSpendUsd"]), actions_hash, int(env["deadline"])],
    )
    return "0x" + actions_hash.hex(), "0x" + keccak(digest).hex()


def compute(outputs_from: str) -> dict:
    """Every derived value, using the Python SDK as the reference implementation."""
    trees, adversarial = build_leaves()
    out = {
        "schema": "avaira.parity-corpus/v1",
        "generatedBy": f"{outputs_from} (sdk/python/avaira)",
        "intentHash": INTENT_HASH,
        "note": (
            "expected* fields are the outputs of the implementation named in `generatedBy`. "
            "compare.py recomputes them in TypeScript, in Python, and inside the compiled "
            "onchain libraries, and requires all four to agree."
        ),
        "trees": [],
        "adversarialLeaves": [],
        "envelopes": [],
        "primitives": {},
    }

    for tree in trees:
        raw = [AuditTrail.leaf_for(int(l["agentId"]), l["intentHash"], l["action"], int(l["spendUsd"]), int(l["nonce"])) for l in tree["leaves"]]
        root = merkle_root(raw) if raw else "0x" + "00" * 32
        proofs = [merkle_proof(raw, i) for i in range(len(raw))]
        out["trees"].append(
            {
                "name": tree["name"],
                "leaves": tree["leaves"],
                "expectedRawLeaves": raw,
                "expectedRoot": root,
                "expectedProofs": proofs,
            }
        )

    for item in adversarial:
        l = item["leaf"]
        raw = AuditTrail.leaf_for(int(l["agentId"]), l["intentHash"], l["action"], int(l["spendUsd"]), int(l["nonce"]))
        out["adversarialLeaves"].append(
            {
                "why": item["why"],
                "leaf": l,
                "expectedRawLeaf": raw,
                "expectedHashedLeaf": hash_leaf(raw),
                "expectedRootSingleton": merkle_root([raw]),
            }
        )

    for env in build_envelopes():
        actions_hash, hashed = envelope_typehash_and_hash(env)
        out["envelopes"].append({**env, "expectedActionsHash": actions_hash, "expectedEnvelopeHash": hashed})

    out["intentHashes"] = build_intent_hashes(out)

    # Two hand-checkable primitives, so a broken keccak or a wrong domain byte is caught even
    # if everything downstream is consistent with itself.
    zero = "0x" + "00" * 32
    out["primitives"] = {
        "hashLeafZero": hash_leaf(zero),
        "hashPairZeroZero": hash_pair(zero, zero),
        "hashPairOrderIndependent": hash_pair(zero, "0x" + "ff" * 32) == hash_pair("0x" + "ff" * 32, zero),
        "leafDomain": AuditTrail.leaf_for(0, zero, "", 0, 0),
    }
    return out


def build_intent_hashes(corpus_outputs: dict) -> list[dict]:
    """The `intentHash` commitment, per plan. This is the hash the gate is checked against."""
    import json as _json

    from eth_abi import encode as abi_encode
    from eth_utils import keccak

    env0 = corpus_outputs["envelopes"][0]["expectedEnvelopeHash"]
    tasks = [
        ({"id": "t1", "z": 1, "a": 2}, "key order differs from the next vector"),
        ({"a": 2, "id": "t1", "z": 1}, "same content, insertion order reversed"),
        ({"id": "t2", "nested": {"b": [1, {"d": None, "c": True}], "a": "x"}}, "nested object and array"),
        ({"id": "t3", "memo": "café \u00e9 ✓ 😀"}, "non-ASCII and astral plane"),
        ({"id": "t4", "amount": 1.5, "big": 2**53, "neg": -0}, "floats, large ints, negative zero"),
        ({"id": "t5", "quote": 'he said "hi"\\ok'}, "quotes and backslashes"),
        ({"id": "t6", "empty": {}, "list": []}, "empty containers"),
        ({"id": "t7"}, "single-field plan"),
        ({"id": "t8", "10": "ten", "9": "nine", "0": "zero"}, "integer-like keys: string sort, not numeric"),
        ({"id": "t9", "\uffff": 1, "\U0001f600": 2}, "astral key vs U+FFFF: code-point order, not UTF-16"),
    ]
    out = []
    for i, (task, why) in enumerate(tasks):
        # `task_raw` keeps the *insertion* order the plan had on the wire. JSON has no key order,
        # so a corpus that only stored the canonical form would silently erase the very property
        # AV-013 is about: `JSON.stringify` of a re-parsed object always looks sorted.
        task_raw = _json.dumps(task, sort_keys=False, separators=(",", ":"))
        task_json = _json.dumps(task, sort_keys=True, separators=(",", ":"))
        encoded = abi_encode(
            ["string", "uint256", "string", "string", "bytes32", "uint256"],
            ["Avaira.Intent.v1", 7 + i, str(task.get("id", "")), task_json, bytes.fromhex(env0[2:]), 1000 + i],
        )
        out.append(
            {
                "why": why,
                "agentId": str(7 + i),
                "task": task,
                "nonce": str(1000 + i),
                "envelopeHash": env0,
                "taskRaw": task_raw,
                "expectedTaskJson": task_json,
                "expectedIntentHash": "0x" + keccak(encoded).hex(),
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="write corpus.json (default: verify only)")
    args = ap.parse_args(argv)

    fresh = json.dumps(compute("tools/parity/gen_corpus.py"), indent=2, sort_keys=True) + "\n"
    if args.write:
        with open(CORPUS, "w") as fh:
            fh.write(fresh)
        print(f"wrote {os.path.relpath(CORPUS, REPO_ROOT)}  sha256={hashlib.sha256(fresh.encode()).hexdigest()[:16]}…")
        return 0
    if not os.path.exists(CORPUS):
        print(f"missing {CORPUS} — run: python3 tools/parity/gen_corpus.py --write", file=sys.stderr)
        return 1
    current = open(CORPUS).read()
    if current != fresh:
        print("corpus.json does not match the generator. Regenerate with --write and commit it.", file=sys.stderr)
        return 1
    print(f"corpus.json is reproducible  sha256={hashlib.sha256(current.encode()).hexdigest()[:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
