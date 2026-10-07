#!/usr/bin/env python3
"""Generate `audit/specs/*.md` from the build manifest + NatSpec — never by hand.

Hand-written interface docs rot within a commit; these are regenerated from
`build/avaira/{artifacts,error-catalog}.json`, so the ABI, every custom error, every
selector, and the deployed size in each spec are exactly what the compiler produced.

    python3 tools/gen_contract_specs.py           # write audit/specs/
    python3 tools/gen_contract_specs.py --check    # fail if the committed specs are stale

Covered: every Avaira*/MerkleLib/RiskEnvelopeLib contract in contracts/src plus MockUSDC,
and the two non-EVM artifacts whose interfaces are equally load-bearing for cross-layer parity
(services/scorer, sdk/typescript + sdk/python).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "build/avaira/artifacts.json"
ERRORS = ROOT / "build/avaira/error-catalog.json"
OUT_DIR = ROOT / "audit/specs"

# Only the protocol's own surface; OpenZeppelin imports are dependencies, not the audit target.
PROTOCOL = [
    "AvairaIntentVault",
    "AvairaStakeRegistry",
    "AvairaValidationRegistry",
    "AvairaReputationRegistry",
    "AvairaIdentityRegistry",
    "AvairaCreditMarket",
    "MerkleLib",
    "RiskEnvelopeLib",
    "MockUSDC",
]

TY = {
    "address": "address", "bool": "bool", "string": "string", "bytes32": "bytes32",
}


def sol_type(t: dict) -> str:
    if t["type"] == "tuple":
        inner = ", ".join(sol_type(c) for c in t.get("components", []))
        return f"({inner})"
    return t["type"]


def natspec_before(src: str, offset: int) -> str:
    """The closest preceding ///** */ or /// comment block above an AST-free match."""
    head = src[:offset].rstrip()
    lines = head.split("\n")
    block: list[str] = []
    for line in reversed(lines):
        s = line.strip()
        if s.startswith("///"):
            block.append(s.lstrip("/").strip())
        elif s.endswith("*/") or s.startswith("*"):
            block.append(s.lstrip("/* ").rstrip(" */").strip())
        elif not s:
            if block:
                break
        else:
            break
    out = [b for b in reversed(block) if b]
    # drop section banners like "── admin ──────────" and bare rules
    out = [b for b in out if not re.fullmatch(r"[-|=]{4,}.*", b.strip()) and "---" not in b and "==" not in b]
    return " ".join(out).strip()


def declaration_offsets(src: str, name: str, keyword: str) -> list[int]:
    return [m.start() for m in re.finditer(rf"\b{keyword}\s+{re.escape(name)}\b", src)]


def _declared_functions(src: str) -> list[dict]:
    """Functions declared in a source file, with the NatSpec above them. Used for libraries,
    whose `internal` functions have no ABI entry at all."""
    out: list[dict] = []
    for m in re.finditer(r"function\s+(\w+)\s*\(", src):
        open_paren = src.index("(", m.start() + 8)
        depth, i = 0, open_paren
        while i < len(src):
            depth += src[i] == "("
            depth -= src[i] == ")"
            i += 1
            if depth == 0:
                break
        args = src[open_paren + 1 : i - 1]
        # the mutability / returns clause runs until the body opens (or the statement ends)
        body = src.find("{", i)
        semi = src.find(";", i)
        end = min(x for x in (body, semi, len(src)) if x >= 0)
        head = " ".join(src[i:end].split())
        rets = ""
        if "returns" in head:
            r_start = head.index("returns") + len("returns")
            rets = head[r_start:].strip().lstrip("(").split(")")[0]
        mut = next((k for k in ("pure", "view", "payable") if re.search(rf"\b{k}\b", head)), "")
        sig = "(" + ", ".join(
            (a.split()[-1] + ": " + " ".join(a.split()[:-1])) if len(a.split()) > 1 else a.split()[0]
            for a in (x.strip() for x in args.split(",")) if a
        ) + ")"
        if rets:
            sig += " → (" + ", ".join(r.split()[-1] for r in rets.split(",") if r.strip()) + ")"
        out.append({"sig": f"{m.group(1)}{sig}", "mut": mut, "doc": natspec_before(src, m.start())})
    return out


def render_contract(name: str, art: dict, err_catalog: dict) -> str:
    rel = art["source"]
    cand = [ROOT / "contracts" / rel, ROOT / rel]
    src_path = next((str(c.relative_to(ROOT)) for c in cand if c.exists()), rel)
    src = (ROOT / src_path).read_text(encoding="utf-8")
    abi = art["abi"]
    deployed = art["deployedBytecode"]
    size = (len(deployed) - 2) // 2 if deployed.startswith("0x") else 0

    # NatSpec on the contract itself: first /// or /** block before the contract keyword.
    for kw in ("abstract contract", "contract", "library"):
        offs = declaration_offsets(src, name, kw)
        if offs:
            doc = natspec_before(src, offs[0])
            break
    else:
        doc = ""

    is_library = re.search(rf"^library\s+{re.escape(name)}\b", src, re.M) is not None
    declared_fns = _declared_functions(src) if not any(e.get("type") == "function" for e in abi) else []

    lines = [
        f"# {name}",
        "",
        f"> Generated by `tools/gen_contract_specs.py` from `{src_path}` + `build/avaira/artifacts.json`. Do not edit by hand.",
        "",
    ]
    if doc:
        # turn `@tag text @tag text` runs into a bullet list, one tag per line
        tags = re.split(r"(?=@(?:title|notice|dev|param|return|inheritdoc|custom:)[A-Za-z0-9_-]*\s)", doc)
        pretty = [t.strip() for t in tags if t.strip()]
        lines += [f"* {t}" if not t.startswith("#") else t for t in pretty] + [""]

    lines += [
        "## At a glance",
        "",
        "| | |",
        "| --- | --- |",
        f"| source | `{src_path}` |",
        f"| source sha256 | `{hashlib.sha256(src.encode()).hexdigest()}` |",
        f"| {'declared functions (internal — no ABI)' if is_library else 'external functions'} "
        f"| {len(declared_fns) if is_library else sum(1 for e in abi if e.get('type') == 'function' and e.get('stateMutability') != 'pure')} |",
        f"| events | {sum(1 for e in abi if e.get('type') == 'event')} |",
        f"| custom errors | {sum(1 for e in abi if e.get('type') == 'error')} |",
        f"| deployed bytecode | {'— (library, linked at compile time)' if is_library else f'{size} bytes'} |",
        "",
    ]

    if is_library and declared_fns:
        lines += [
            "## Functions",
            "",
            "These are `internal` library functions: they are linked into callers at compile time, so",
            "they have no selectors and no ABI entry. They are listed here because they define the byte",
            "layout every SDK must reproduce (`INV-CANON-01`, `PARITY.md`).",
            "",
            "| signature | mutability | NatSpec |",
            "| --- | --- | --- |",
        ]
        for fn in declared_fns:
            note = fn["doc"]
            if len(note) > 300:
                note = note[:297] + "…"
            lines.append(f"| `{fn['sig']}` | {fn['mut'] or '—'} | {note or '—'} |")
        lines.append("")

    fns = [e for e in abi if e.get("type") == "function"]
    if fns:
        lines += ["## Functions", "", "| selector | signature | mutability | NatSpec |",
                  "| --- | --- | --- | --- |"]
        for f in sorted(fns, key=lambda x: x["name"]):
            sig = f"{f['name']}({','.join(sol_type(i) for i in f['inputs'])})"
            outs = f" → ({','.join(sol_type(o) for o in f.get('outputs', []))})" if f.get("outputs") else ""
            offs = declaration_offsets(src, f["name"], "function") or declaration_offsets(src, f["name"], "modifier")
            note = natspec_before(src, offs[0]) if offs else ""
            if len(note) > 220:
                note = note[:217] + "…"
            lines.append(f"| `{keccak4(sig)}` | `{sig}`{outs} | {f.get('stateMutability','')} | {note or '—'} |")
        lines.append("")

    errs = [e for e in abi if e.get("type") == "error"]
    if errs:
        lines += ["## Custom errors", "", "| selector | signature | declared | why it exists |",
                  "| --- | --- | --- | --- |"]
        cat = err_catalog if "errors" not in err_catalog else err_catalog["errors"]
        for e in sorted(errs, key=lambda x: x["name"]):
            sig = f"{e['name']}({','.join(sol_type(i) for i in e['inputs'])})"
            # the catalog is keyed by bare 8-hex selectors (no 0x), as solc emits them
            row = cat.get(keccak4(sig).replace("0x", "", 1), {})
            offs = declaration_offsets(src, e["name"], "error")
            note = natspec_before(src, offs[0]) if offs else ""
            lines.append(
                f"| `{keccak4(sig)}` | `{sig}` | `{row.get('contract','?')}:{row.get('line','?')}` | {(note or '—')} |"
            )
        lines.append("")

    evs = [e for e in abi if e.get("type") == "event"]
    if evs:
        lines += ["## Events", "", "| signature | indexed |", "| --- | --- |"]
        for e in sorted(evs, key=lambda x: x["name"]):
            sig = f"{e['name']}({', '.join(sol_type(i) + (' indexed' if i.get('indexed') else '') for i in e['inputs'])})"
            lines.append(f"| `{sig}` | {sum(1 for i in e['inputs'] if i.get('indexed'))}/{len(e['inputs'])} |")
        lines.append("")
    return "\n".join(lines) + "\n"


def keccak4(sig: str) -> str:
    """4-byte selector for an ABI signature, or "—" if no keccak is importable.

    Uses `eth_utils`, which the Python SDK already depends on; the generator must not
    invent its own hash. A missing dependency degrades to a dash, never to a wrong value.
    """
    global _KECCAK
    if _KECCAK is False:
        return "—"
    if _KECCAK is None:
        try:
            from eth_utils import keccak as _k

            def _KECCAK(s: str) -> str:  # noqa: F811
                return "0x" + _k(s.encode()).hex()[:8]
        except Exception:
            _KECCAK = False
            return "—"
    return _KECCAK(sig)


_KECCAK = None


SCORER_SPEC = """# Scorer service (`services/scorer`) and the on-chain band table

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
"""


def sdk_spec(_unused: str = "") -> str:
    return """# SDK surface — `@avaira/sdk` (TypeScript) and `avaira` (Python)

> The SDKs are part of the audit target because they *compute consensus-relevant bytes*: the
> canonical intent JSON, the intent hash, the deviation leaf, and the gate call the vault re-checks.

## Primitives that must agree (and are checked to agree)

| primitive | TypeScript | Python | cross-check |
| --- | --- | --- | --- |
| canonical intent JSON | `canonicalJson` (`src/canonical.ts`) | `json.dumps(sort_keys=True, separators=(",", ":"))` in `client.py` | `tools/parity/compare.py`, 42 vectors |
| `intentHash` | `Avaira.hashIntent(agentId, task, envelopeHash, nonce)` | `Avaira.hash_intent(...)` | same corpus, 10 intent vectors |
| `envelopeHash` | `envelopeHash(envelope)` | `hash_envelope(envelope)` | same, 10 vectors |
| deviation leaf | `AuditTrail.leafFor(agentId, intentHash, action, spendUsd, nonce)` | `AuditTrail.leaf_for(...)` | 13 adversarial leaves |
| Merkle root / proof | `merkleRoot`, `verifyProof` | `merkle_root`, `merkle_proof` | 9 trees incl. single-leaf and odd counts |

Shared formula, both languages, byte for byte:

```
intentHash  = keccak256(abi.encode("Avaira.Intent.v1", agentId, taskId, canonicalJson(task), envelopeHash, nonce))
envelopeHash= keccak256(abi.encode("RiskEnvelope(uint256,bytes32,uint64)", maxSpendUsd,
                                    keccak256(abi.encode("string[]", allowedActions)), deadline))
leaf        = keccak256(abi.encode(agentId, intentHash, action, spendUsd, nonce))   # then sorted-pair Merkle
```

Rules the canonical encoder pins (AV-013 was found because these were not pinned): keys sorted at
**every** depth **by code point** (not UTF-16 unit), `,`/`:` separators, non-ASCII escaped `\\uXXXX`
with lowercase hex including surrogate pairs, `-0` → `0`, `undefined` members dropped, and
`bigint`/`NaN`/`Infinity`/`Date`/`Map`/class instances **rejected** rather than mangled; depth
capped at 64.

## API surface

```ts
const avaira = new Avaira({ /* config from deployment manifest */ })
await avaira.commit(taskId, envelope)                    // commitIntent
await avaira.run(taskId, plan, envelope, execute)        // hashIntent → commit → execute → attest, one leaf per action
avaira.hashIntent(agentId, task, envelopeHash, nonce)     // the commitment, standalone
await avaira.prove(taskId)                                // audit-trail proof for one intent
```

```python
client = AvairaClient.from_deployment(chain_id=143)      # or load_manifest(...)
client.hash_intent(agent_id, task, envelope_hash, nonce)
client.commit_intent(agent_id, intent_hash, envelope)
client.check_gate_for_intent(agent_id, intent_hash, envelope_hash)
client.attest_outcome(agent_id, intent_hash, outcome_hash, merkle_root)
client.record_gate_decision(...)                         # telemetry the scorer later reads
```

## Out of scope for parity

`sdk/avaira-rust-core` is pre-v2 (SHA-256 over concatenated strings, float money, no deadline, no
`AuditTrail`) and is reported as `skipped` by `tools/parity/compare.py` — see FINDINGS.md AV-014.
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="generate audit/specs/*.md")
    ap.add_argument("--check", action="store_true", help="exit non-zero if committed specs are stale")
    args = ap.parse_args()

    if not ARTIFACTS.exists() or not ERRORS.exists():
        print("build/avaira/{artifacts,error-catalog}.json missing — run `node tools/compile.mjs`", file=sys.stderr)
        return 2
    art = json.loads(ARTIFACTS.read_text(encoding="utf-8"))
    cat = json.loads(ERRORS.read_text(encoding="utf-8"))

    rendered: dict[str, str] = {}
    for name in PROTOCOL:
        if name not in art:
            print(f"skip {name}: not in build", file=sys.stderr)
            continue
        rendered[f"{name}.md"] = render_contract(name, art[name], cat)
    rendered["scorer-service.md"] = SCORER_SPEC
    rendered["sdk-surface.md"] = sdk_spec("")

    index = [
        "# Specifications (generated)",
        "",
        "Every file here is produced by `tools/gen_contract_specs.py` from the compiled build — ABI, selectors,",
        "NatSpec and deployed sizes cannot drift from the code because they *are* the code's output.",
        "Rebuild with `make specs`; CI fails if the committed files are stale (`tools/doctor.py`).",
        "",
        "| spec | contents |",
        "| --- | --- |",
    ]
    for f in sorted(rendered):
        index.append(f"| [`{f}`](./{f}) | {'generated from Solidity build' if not f.endswith(('scorer-service.md','sdk-surface.md')) else 'hand-maintained cross-layer'} |")
    index += [
        "",
        "## Known gap",
        "",
        "`sdk/avaira-rust-core` has no spec here: it is pre-v2 and cannot express a v2 intent",
        "(`sha256` over concatenated strings instead of `keccak256(abi.encode(...))`, no `AuditTrail`,",
        "no deadline in its envelope). See [AV-014](../../FINDINGS.md#av-014) — the parity harness",
        "reports it as `skipped`, never as passing.",
        "",
    ]
    rendered["README.md"] = "\n".join(index) + "\n"

    if args.check:
        stale = []
        for n, body in rendered.items():
            dest = OUT_DIR / n
            if (not dest.exists()) or dest.read_text(encoding="utf-8") != body:
                stale.append(n)
        if stale:
            print("stale or missing specs: " + ", ".join(sorted(stale)), file=sys.stderr)
            print("  regenerate with `make specs`", file=sys.stderr)
            return 1
        print(f"specs fresh ({len(rendered)} files)")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for n, body in rendered.items():
        (OUT_DIR / n).write_text(body, encoding="utf-8")
    print(f"wrote {len(rendered)} specs to {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
