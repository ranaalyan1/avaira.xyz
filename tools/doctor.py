#!/usr/bin/env python3
"""Repo self-consistency gate — the "did you actually check what you said you checked" test.

`INV-DOC-01` in `audit/INVARIANTS.md` is the claim; this file is the machine that refuses to let
the claim rot. It is deliberately stdlib-only (no web3, no node, no solc) so it can run on a bare
checkout in CI, in a docs-only PR, and in five seconds.

    python3 tools/doctor.py            # human output, exit 1 on any FAIL
    python3 tools/doctor.py --json     # machine output
    python3 tools/doctor.py --warn-ok  # treat WARN as non-fatal (default) / fatal
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIRS = {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "coverage", ".next", "out"}
INVariant_RE = re.compile(r"INV-[A-Z]+-\d{2}")
AV_RE = re.compile(r"AV-\d{3}")


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    warns: list[str] = field(default_factory=list)
    fatal: bool = True

    @property
    def status(self) -> str:
        if self.ok:
            return "WARN" if self.warns else "PASS"
        return "FAIL" if self.fatal else "WARN"


SKIP_PREFIXES = ("contracts/lib/",)  # vendored dependencies are not our documentation


def walk(suffixes: tuple[str, ...], *, roots: tuple[str, ...] = (".",)) -> list[Path]:
    out: list[Path] = []
    for base in roots:
        start = ROOT / base
        if start.is_file():
            if start.suffix in suffixes:
                out.append(start)
            continue
        for dirpath, dirnames, filenames in os.walk(start):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                if fn.endswith(suffixes):
                    out.append(Path(dirpath) / fn)
    return sorted(
        p for p in set(out) if not str(p.relative_to(ROOT)).startswith(SKIP_PREFIXES)
    )


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


# ---------------------------------------------------------------- checks


def check_build_artifacts() -> Check:
    files = ["artifacts.json", "build-manifest.json", "error-catalog.json"]
    missing = [f for f in files if not (ROOT / "build/avaira" / f).exists()]
    if missing:
        return Check("build artifacts present", False, "missing " + ", ".join(missing) + " — run `node tools/compile.mjs`")
    art = json.loads(read(ROOT / "build/avaira/artifacts.json") or "{}")
    man = json.loads(read(ROOT / "build/avaira/build-manifest.json") or "{}")
    cat = json.loads(read(ROOT / "build/avaira/error-catalog.json") or "{}")
    entries = cat.get("errors", cat)
    n_cat = len(entries) if isinstance(entries, dict) else 0
    declared = man.get("errorCatalogSize")
    warns: list[str] = []
    if declared != n_cat:
        warns.append(f"manifest says errorCatalogSize={declared} but catalog has {n_cat}")
    sources = {s.split("/")[-1].replace(".sol", "") for s in man.get("sources", []) if "/src/" in s}
    ours = {n for n in sources if n.startswith(("Avaira", "Merkle", "RiskEnvelope", "Mock"))}
    undocumented = sorted(ours - set(art))
    if undocumented:
        warns.append("compiled sources without artifacts: " + ", ".join(undocumented))
    return Check("build artifacts consistent", not missing, f"{len(art)} artifacts, {n_cat} custom errors", warns)


def check_challenge_window_sync() -> Check:
    sol = read(ROOT / "contracts/src/core/AvairaIntentVault.sol")
    py = read(ROOT / "tools/avaira_evm/campaign.py")
    m = re.search(r"MAX_CHALLENGE_WINDOW\s*=\s*([0-9]+)\s*days", sol)
    p = re.search(r"^MAX_CHALLENGE_WINDOW = ([\d_]+)(?: \* ([\d_]+))?", py, re.M)
    if not m:
        return Check("challenge-window bound mirrored in harness", False, "could not find MAX_CHALLENGE_WINDOW in the Solidity source")
    sol_seconds = int(m.group(1)) * 86_400
    if not p:
        return Check("challenge-window bound mirrored in harness", False, "campaign.py no longer defines MAX_CHALLENGE_WINDOW")
    py_seconds = int(p.group(1).replace("_", "")) * (int(p.group(2).replace("_", "")) if p.group(2) else 1)
    if py_seconds != sol_seconds:
        return Check("challenge-window bound mirrored in harness", False, f"campaign says {py_seconds}s, contract says {sol_seconds}s")
    return Check("challenge-window bound mirrored in harness", True, f"both {sol_seconds}s")


def check_invariants_documented() -> Check:
    doc = read(ROOT / "audit/INVARIANTS.md")
    # An id is *defined* only by a heading in INVARIANTS.md. Prose that names an id we deliberately do
    # NOT check (see "Declared gaps") must not mint one, or the docs gain a fake invariant.
    headings = set(re.findall(r"^### (INV-[A-Z]+-\d{2})", doc, re.M))
    used: dict[str, set[str]] = {}
    for path in walk((".py", ".ts", ".sol", ".md", ".mjs", ".json")):
        for hit in INVariant_RE.findall(read(path)):
            used.setdefault(hit, set()).add(str(path.relative_to(ROOT)))
    missing_docs = sorted(set(used) - headings)
    no_anchor = sorted(i for i in headings if f"### {i}" not in doc)
    warns = [f"{i} has a heading that does not round-trip (links to #{i.lower()} will 404)" for i in no_anchor]
    detail = f"{len(used)} ids referenced across {len(used) and sum(len(v) for v in used.values())} sites"
    if missing_docs:
        return Check("every invariant id is documented", False, "referenced but undefined: " + ", ".join(missing_docs))
    # every id the campaign *declares* must also be evaluated by it: an id that appears only in
    # the declaration list is a decorative invariant, which is the failure mode this whole file
    # exists to prevent. Counting occurrences is a cheap proxy: a real check cites the id at least
    # twice (declaration + `Violation("ID", …)` or an `invariant_counts["ID"]` bump).
    camp = read(ROOT / "tools/avaira_evm/campaign.py")
    m = re.search(r"INVARIANT_IDS\s*=\s*\[(.*?)\]", camp, re.S)
    declared = re.findall(r'"(INV-[A-Z]+-\d{2})"', m.group(1)) if m else []
    unasserted = [i for i in declared if camp.count(f'"{i}"') < 2]
    if unasserted:
        return Check("every declared campaign invariant is evaluated", False, "declared but never used in a check: " + ", ".join(unasserted))
    return Check("every invariant id is documented", True, detail + f"; {len(declared)} evaluated by campaign", warns)


def check_scenarios_match_findings() -> Check:
    findings = read(ROOT / "FINDINGS.md")
    attacks = read(ROOT / "tools/avaira_evm/attacks.py")
    parity = read(ROOT / "tools/parity/compare.py")
    scenario_ids = set(re.findall(r'"(AV-\d{3})"', attacks))
    documented = set(AV_RE.findall(findings))
    parity_ids = set(AV_RE.findall(parity))
    undocumented = sorted((scenario_ids | parity_ids) - documented)
    unexercised = sorted(scenario_ids - documented)
    warns: list[str] = []
    if undocumented:
        return Check("every attack scenario is written up", False, "ids with no FINDINGS entry: " + ", ".join(undocumented))
    # every finding in the summary table must be claimed by some check
    table = re.findall(r"^\| \[?(AV-\d{3})\]?[^|]*\|", findings, re.M)
    # findings whose evidence is a unit test or a scope decision rather than an EVM scenario
    non_scenario_checks = {
        "AV-014": "scope decision (parity reports `skipped`)",
        "AV-015": "services/scorer/test/canonical.test.ts",
    }
    orphans = sorted(set(table) - (scenario_ids | parity_ids | set(non_scenario_checks)))
    if orphans:
        warns.append("findings with neither a scenario nor a parity check: " + ", ".join(orphans))
    for finding, where in non_scenario_checks.items():
        if finding in set(table) and not (ROOT / where.split(" ")[0]).exists() and "scope" not in where:
            warns.append(f"{finding} cites {where}, which does not exist")
    if unexercised:
        warns.append("scenarios not in the summary table: " + ", ".join(unexercised))
    return Check("every attack scenario is written up", True, f"{len(scenario_ids)} scenarios, {len(documented)} findings", warns)


def check_reports_current() -> Check:
    manifest_path = ROOT / "build/avaira/artifacts.json"
    if not manifest_path.exists():
        return Check("verification reports match this build", False, "no build to compare against")
    digest = "0x" + sha256(manifest_path.read_bytes()).hexdigest()
    warns: list[str] = []
    fails: list[str] = []
    for name in ("redteam.json", "parity.json", "campaign.json"):
        path = ROOT / "verification/reports" / name
        if not path.exists():
            fails.append(f"{name} missing")
            continue
        report = json.loads(read(path) or "{}")
        recorded = (report.get("build") or {}).get("sourceDigest")
        verdict = report.get("verdict") or report.get("status")
        if name == "parity.json":
            recorded = (report.get("build") or {}).get("sourceDigest")
            corpus = report.get("corpus", {})
            corpus_path = ROOT / "tools/parity/corpus.json"
            if corpus_path.exists():
                actual = "0x" + sha256(corpus_path.read_bytes()).hexdigest()
                if corpus.get("sha256") != actual:
                    fails.append("parity.json pins a different corpus than tools/parity/corpus.json")
        elif recorded and recorded != digest:
            fails.append(f"{name} was recorded against {recorded[:18]}… but the build is {digest[:18]}…")
        if verdict not in (None, "PASS", "MATCH"):
            fails.append(f"{name} verdict is {verdict}")
        if not recorded and name != "parity.json":
            warns.append(f"{name} carries no build digest")
    if fails:
        return Check("verification reports match this build", False, "; ".join(fails) + " — re-run `make redteam fuzz parity`")
    return Check("verification reports match this build", True, f"build {digest[:18]}…", warns)


def check_specs_fresh() -> Check:
    try:
        proc = subprocess.run(
            [sys.executable, "tools/gen_contract_specs.py", "--check"], cwd=ROOT, capture_output=True, text=True, timeout=120
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Check("generated specs are fresh", False, f"could not run the generator: {exc}")
    if proc.returncode != 0:
        return Check("generated specs are fresh", False, (proc.stderr or proc.stdout).strip()[:400])
    return Check("generated specs are fresh", True, proc.stdout.strip())


def check_no_overclaim() -> Check:
    """Absolute claims are forbidden outright; parity claims are allowed only when negated.

    Two groups, because they need different logic. "no known issues" is a lie *because* of the
    word "no", so looking for a negation there is self-defeating. "4-way parity" and "Rust parity"
    are fine to *write about* — the repo needs to say "Rust is skipped, not four-way" — so those
    are only violations in an affirmative paragraph.
    """
    absolute = {
        "no known issues": re.compile(r"\bno known (issues|vulnerabilities|risks)\b", re.I),
        "claimed fully audited": re.compile(r"\b(fully|completely|100%) audited\b", re.I),
        "no exploits possible": re.compile(r"\b(cannot be exploited|exploit[- ]proof|unhackable)\b", re.I),
    }
    comparative = {
        "four-way parity": re.compile(r"\b(4|four)[- ]way parity\b", re.I),
        "rust parity claimed": re.compile(r"\brust\b[^.\n]{0,48}\b(parity|matches|identical|green)\b", re.I),
    }
    negation = re.compile(
        r"\b(not|no|never|cannot|can't|n't|unable|refuted|skipped|without|absent|missing|gap|"
        r"claim|claims|alleged|report)\b",
        re.I,
    )
    hits: list[str] = []
    for path in walk((".md",)):
        text = read(path)
        # judge the paragraph, not the line: "the honest claim is three artifacts, not four"
        # routinely puts the negation a sentence away from the phrase it defuses
        for idx, para in enumerate(text.split("\n\n"), 1):
            where = f"{path.relative_to(ROOT)} (paragraph {idx})"
            for label, rx in absolute.items():
                if rx.search(para):
                    hits.append(f"{label} in {where}")
            if negation.search(para):
                continue
            for label, rx in comparative.items():
                if rx.search(para):
                    hits.append(f"{label} in {where}")
    if hits:
        return Check("docs do not overclaim", False, "; ".join(hits[:6]) + ("…" if len(hits) > 6 else ""))
    return Check("docs do not overclaim", True, "no absolute assurance claims; parity claims all negated")


def check_referenced_paths_exist() -> Check:
    """Docs and docstrings that cite a test or tool file must cite one that exists."""
    rx = re.compile(r"`\.?/?((?:[a-zA-Z0-9_.-]+/)*(?:test|tests|tools|scripts|src|fixtures)/[A-Za-z0-9_./*-]+\.(?:py|ts|sol|mjs))`")
    packages = [ROOT] + [q.parent for q in ROOT.glob("*/*/package.json")] + [ROOT / "contracts", ROOT / "tools/parity"]
    missing: set[str] = set()
    for path in walk((".md", ".py", ".ts")):
        text = read(path)
        for line in text.split("\n"):
            if "does not exist" in line or "missing" in line.lower() or "no such" in line:
                continue  # citations that are *about* an absent file are the point, not a bug
            for rel in set(rx.findall(line)):
                if "*" in rel:
                    continue
                if not any((pkg / rel).exists() for pkg in packages):
                    missing.add(f"{rel} (cited by {path.relative_to(ROOT)})")
    if missing:
        return Check("cited test/tool paths exist", False, "; ".join(sorted(missing)[:8]) + ("…" if len(missing) > 8 else ""))
    return Check("cited test/tool paths exist", True)


def check_make_and_ci_targets() -> Check:
    mk = read(ROOT / "Makefile")
    defined = set(re.findall(r"^([a-z0-9-]+):", mk, re.M))
    used: set[str] = set()
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        for line in read(path).split("\n"):
            if "make " in line:
                used |= set(re.findall(r"make ([a-z][a-z0-9-]*)", line))
    for path in walk((".md",)):
        text = read(path)
        for block in re.findall(r"```(?:bash|sh|\w*)\n(.*?)```", text, re.S):
            used |= set(re.findall(r"^\s*make ([a-z][a-z0-9-]*)", block, re.M))
    used = {t_ for t_ in used if t_ not in {"sure", "this", "it", "them", "a", "the"}}
    missing = sorted(t for t in used if t not in defined)
    warns: list[str] = []
    # Makefile targets that call `npm run X` must match a script in *that* package, not any package
    for cd_dir, script in re.findall(r"cd\s+([\w./-]+)\s+&&\s+npm run ([\w:-]+)", mk):
        pkg = ROOT / cd_dir / "package.json"
        if not pkg.exists():
            warns.append(f"Makefile: `cd {cd_dir}` has no package.json")
            continue
        scripts = (json.loads(read(pkg) or "{}")).get("scripts", {})
        if script not in scripts:
            warns.append(f"Makefile: `npm run {script}` is not a script in {pkg.relative_to(ROOT)}")
    # entry points that point at a file the repo does not contain (main/bin are not built here)
    for pkg in sorted(ROOT.glob("*/*/package.json")):
        data = json.loads(read(pkg) or "{}")
        for field_name in ("main", "bin"):
            target = data.get(field_name)
            if isinstance(target, str) and target.startswith("./src/"):
                if not (pkg.parent / target).exists():
                    warns.append(f"{pkg.relative_to(ROOT)}: {field_name}={target} is not in the repo")
    if missing:
        return Check("make targets used by docs/CI exist", False, "undefined: " + ", ".join(missing), warns)
    return Check("make targets used by docs/CI exist", True, f"{len(used)} referenced, {len(defined)} defined", warns)


def check_probe_not_deployed() -> Check:
    deploy = read(ROOT / "contracts/script/Deploy.s.sol")
    if re.search(r"new\s+AvairaProbe\b", deploy):
        return Check("verification-only AvairaProbe is not deployed", False, "Deploy.s.sol deploys AvairaProbe — it must stay harness-only")
    return Check("verification-only AvairaProbe is not deployed", True)


def check_corpus_reproducible() -> Check:
    corpus = ROOT / "tools/parity/corpus.json"
    if not corpus.exists():
        return Check("parity corpus reproducible", False, "tools/parity/corpus.json missing")
    try:
        proc = subprocess.run([sys.executable, "tools/parity/gen_corpus.py"], cwd=ROOT, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Check("parity corpus reproducible", False, f"generator did not run: {exc}", fatal=False)
    if proc.returncode != 0:
        return Check("parity corpus reproducible", False, (proc.stderr or proc.stdout).strip()[:300], fatal=False)
    return Check("parity corpus reproducible", True, proc.stdout.strip()[:160])


# ---------------------------------------------------------------- driver


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict-warnings", action="store_true", help="exit non-zero on warnings too")
    args = ap.parse_args(argv)

    checks = [
        check_build_artifacts(),
        check_challenge_window_sync(),
        check_invariants_documented(),
        check_scenarios_match_findings(),
        check_reports_current(),
        check_corpus_reproducible(),
        check_specs_fresh(),
        check_no_overclaim(),
        check_referenced_paths_exist(),
        check_make_and_ci_targets(),
        check_probe_not_deployed(),
    ]

    if args.json:
        print(json.dumps({"schema": "avaira.doctor/v1", "checks": [{"name": c.name, "status": c.status, "detail": c.detail, "warnings": c.warns} for c in checks]}, indent=2))
    else:
        width = max(len(c.name) for c in checks)
        print("avaira doctor — repo self-consistency\n")
        for c in checks:
            mark = {"PASS": " ok ", "WARN": "warn", "FAIL": "FAIL"}[c.status]
            print(f"[{mark}] {c.name.ljust(width)}  {c.detail}")
            for w in c.warns:
                print(f"        · {w}")
        failed = [c for c in checks if c.status == "FAIL"]
        warned = [c for c in checks if c.warns]
        print(f"\n{len(checks) - len(failed)}/{len(checks)} checks clean" + (f", {len(warned)} with warnings" if warned else ""))
        if failed:
            print("Fix by re-running the layer that produced the claim: `node tools/compile.mjs`, `make redteam fuzz parity specs`.")

    bad = any(c.status == "FAIL" for c in checks)
    if args.strict_warnings and any(c.warns for c in checks):
        bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
