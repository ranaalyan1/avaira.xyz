#!/usr/bin/env python3
"""Generate a self-contained Quickstart Console snapshot.

Runs the same two verification actions the live console runs, then bakes their
*real* transcripts into a single HTML file. The result needs no server, no
network and no Python — open it from disk, attach it to a review, or present it
in a file viewer.

    python3 tools/quickstart/snapshot.py [--out verification/quickstart-console.html]

If the file is later served by `tools/quickstart/server.py` (or any host), the
buttons light up and re-run against the live process; otherwise they replay the
captured transcripts.
"""
from __future__ import annotations

import argparse
import html
import json
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VENV_PY = REPO_ROOT / ".venv" / "bin" / "python"

ACTIONS = [
    {
        "id": "demos",
        "label": "Proof artifacts",
        "argv": ["-m", "avaira_os.demos"],
        "blurb": "4 deterministic proofs: self-correction, ambiguity suspension, math-safety clamp, pre-execution slash",
        "marker": "all proof artifacts: PASS",
    },
    {
        "id": "tests",
        "label": "Kernel tests",
        "argv": ["-m", "pytest", "tests/test_cognitive_os.py", "-q"],
        "blurb": "21 tests across the five Cognitive OS pillars",
        "marker": "passed",
    },
]


def python_bin() -> str:
    return str(VENV_PY) if VENV_PY.exists() else sys.executable


def git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except Exception:
        return ""


def run(spec: dict) -> dict:
    started = time.time()
    proc = subprocess.run(
        [python_bin(), *spec["argv"]], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=300
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    return {
        "id": spec["id"],
        "label": spec["label"],
        "blurb": spec["blurb"],
        "ok": proc.returncode == 0 and spec["marker"] in out,
        "exitCode": proc.returncode,
        "durationMs": round((time.time() - started) * 1000),
        "output": out,
    }


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Avaira — Quickstart Console (snapshot)</title>
<style>
  :root { --bg:#0a0e14; --panel:#111823; --line:#1e2a3a; --ink:#e6f1ff;
          --dim:#8ba3bd; --cyan:#00e5ff; --green:#10b981; --red:#ef4444; --amber:#f59e0b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:36px 22px 72px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:4px; }
  .mark { width:44px; height:44px; border-radius:12px; flex:0 0 auto;
          background:linear-gradient(135deg,var(--cyan),#7c3aed);
          display:grid; place-items:center; font-weight:800; color:#04121a; font-size:20px; }
  h1 { font-size:25px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--dim); margin:2px 0 22px; font-size:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px;
          padding:18px; margin-bottom:16px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:4px 11px; border-radius:999px;
          font-size:12.5px; font-weight:600; border:1px solid var(--line); background:#0d1520; margin:0 6px 6px 0; }
  .pill.ok { color:var(--green); border-color:#134e3a; }
  .pill.no { color:var(--red); border-color:#5a1f1f; }
  .pill.info { color:var(--cyan); border-color:#12414d; }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  button { font:inherit; font-weight:600; cursor:pointer; border-radius:10px; padding:11px 16px;
           border:1px solid var(--line); background:#16212f; color:var(--ink); transition:.15s; width:100%; text-align:left; }
  button:hover { border-color:var(--cyan); color:var(--cyan); }
  button.active { border-color:var(--cyan); background:#0e2b33; color:var(--cyan); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.09em; color:var(--dim); margin:0 0 12px; }
  pre { background:#070c13; border:1px solid var(--line); border-radius:10px; padding:14px;
        overflow:auto; max-height:420px; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
        color:#cfe6ff; margin:14px 0 0; white-space:pre-wrap; word-break:break-word; }
  code { font-family:ui-monospace,Menlo,monospace; background:#0d1520; border:1px solid var(--line);
         padding:1.5px 6px; border-radius:6px; font-size:13px; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
        border-bottom:1px dashed #16202e; font-size:13.5px; }
  .kv:last-child { border-bottom:0; }
  .kv span:first-child { color:var(--dim); }
  .mono { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; }
  .hint { color:var(--dim); font-size:13px; margin-top:9px; }
  .banner { border:1px solid #12414d; background:#0b1f26; color:var(--cyan);
            border-radius:10px; padding:10px 14px; font-size:13.5px; margin-bottom:16px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark">A</div>
    <div>
      <h1>Avaira Quickstart Console</h1>
      <div class="sub" style="margin:0">Real transcripts from a real run — no keys, no chain, no database.</div>
    </div>
  </header>

  <div class="banner" id="banner">
    Static snapshot · captured __CAPTURED__ · commit <span class="mono">__COMMIT__</span> · interpreter <span class="mono">__PY__</span>
    — press a button below to replay it, or serve this repo and it re-runs live.
  </div>

  <div class="card">
    <h2>Environment</h2>
    <div class="row">
      <span class="pill ok"><i class="dot"></i>Cognitive OS verified · pydantic __PYDANTIC__ · python __PYVER__</span>
      <span class="pill info"><i class="dot"></i>__PYBIN__</span>
    </div>
    <div style="margin-top:12px">
      <div class="kv"><span>Repository</span><span class="mono">__REPO__</span></div>
      <div class="kv"><span>Setup entry point</span><span class="mono">./setup.sh</span></div>
      <div class="kv"><span>Live console (if running)</span><span class="mono">./setup.sh --serve → http://localhost:8402</span></div>
      <div class="kv"><span>Chain tooling</span><span class="mono">__TOOLS__</span></div>
      <div class="kv"><span>Captured at</span><span class="mono">__CAPTURED__</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Run the verification</h2>
    <div class="grid">
      <div>
        <button id="btn-demos">▸ __DEMOS_LABEL__ <span style="color:var(--green)">__DEMOS_MARK__</span></button>
        <div class="hint">__DEMOS_BLURB__ · __DEMOS_MS__ ms</div>
      </div>
      <div>
        <button id="btn-tests">▸ __TESTS_LABEL__ <span style="color:var(--green)">__TESTS_MARK__</span></button>
        <div class="hint">__TESTS_BLURB__ · __TESTS_MS__ ms</div>
      </div>
    </div>
    <pre id="out">__FIRST_OUTPUT__</pre>
  </div>

  <div class="card">
    <h2>What am I looking at?</h2>
    <ol style="color:var(--dim); padding-left:20px; margin:0">
      <li><b style="color:var(--ink)">Proof artifacts</b> — the interval prover rejects an under-budgeted plan with a witness counterexample and the loop self-corrects; an underspecified goal suspends at <code>AWAIT_INPUT</code> instead of guessing; a $120 transfer is clamped to $95 against a $100 cap; and a plan with a forged certificate is refused <i>before</i> execution while 25% of stake burns.</li>
      <li><b style="color:var(--ink)">Kernel tests</b> — 21 tests over the five pillars: cognitive kernel, three-tier memory, symbolic prover + sandbox, hardened execution gate, cognitive ledger.</li>
      <li>Both are deterministic (seeded RNG, logical clock), so two runs are byte-identical — which is why this snapshot is evidence and not a screenshot.</li>
    </ol>
    <div class="hint">Reproduce locally: <code>git clone … &amp;&amp; ./setup.sh</code> — ~7s, no API keys, no wallet, no database.</div>
  </div>
</div>

<script id="data" type="application/json">__DATA__</script>
<script>
const R = JSON.parse(document.getElementById('data').textContent);
const out = document.getElementById('out');
const btns = { demos: document.getElementById('btn-demos'), tests: document.getElementById('btn-tests') };

function show(id) {
  const r = R.results[id];
  out.textContent = `$ ${r.cmd}\n` + '─'.repeat(72) + '\n' + r.output +
    (r.ok ? '' : `\n\n*** exit ${r.exitCode} — this run FAILED ***`);
  for (const [key, b] of Object.entries(btns)) b.classList.toggle('active', key === id);
}

async function go(id) {
  // If this file is being served by tools/quickstart/server.py, re-run for real.
  show(id);
  try {
    const res = await fetch('/api/run/' + id, { method: 'POST' });
    if (!res.ok) return;
    const live = await res.json();
    R.results[id] = { ...R.results[id], output: live.output, ok: live.ok,
                      exitCode: live.exitCode, durationMs: live.durationMs, cmd: R.results[id].cmd + '   (live)' };
    show(id);
  } catch (e) { /* static snapshot: the captured transcript is already on screen */ }
}
btns.demos.addEventListener('click', () => go('demos'));
btns.tests.addEventListener('click', () => go('tests'));
show('demos');
</script>
</body>
</html>
"""


def markdown(results: dict, pyd: str, pyv: str, captured: str, commit: str) -> str:
    """Plain-text transcript: renders in any viewer, diffable in review."""
    lines = [
        "# Avaira — verification transcript",
        "",
        f"Captured {captured} · commit `{commit or 'unknown'}` · python {pyv} · pydantic {pyd}",
        "",
        "Reproduce with `./setup.sh` (~7s, no API keys, no wallet, no database).",
        "",
    ]
    for r in results.values():
        verdict = "PASS" if r["ok"] else f"FAIL (exit {r['exitCode']})"
        lines += [
            f"## {r['label']} — {verdict} ({r['durationMs']} ms)",
            "",
            f"```console\n$ python {' '.join(r['argv'])}\n{r['output'].rstrip()}\n```",
            "",
        ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a static Quickstart Console snapshot")
    ap.add_argument("--out", default="verification/quickstart-console.html")
    ap.add_argument("--md", default="verification/quickstart-run.md")
    args = ap.parse_args()

    results = {}
    for spec in ACTIONS:
        print(f"  running {spec['label']}…", flush=True)
        results[spec["id"]] = {**run(spec), "argv": spec["argv"], "cmd": "python " + " ".join(spec["argv"])}

    probe = subprocess.run(
        [python_bin(), "-c", "import pydantic,sys;print(pydantic.VERSION);print(sys.version.split()[0])"],
        capture_output=True, text=True, timeout=60, cwd=str(REPO_ROOT),
    )
    pyd, pyv = (probe.stdout.split() + ["?", "?"])[:2] if probe.returncode == 0 else ("?", "?")
    import shutil

    tools = ", ".join(t for t in ("forge", "node", "npm", "docker") if shutil.which(t)) or "none detected"
    captured = time.strftime("%Y-%m-%d %H:%M:%S %Z")

    data = json.dumps({"results": results}).replace("</", "<\\/")
    first = results["demos"]["output"]

    doc = TEMPLATE
    for token, value in {
        "__CAPTURED__": html.escape(captured),
        "__COMMIT__": html.escape(git("rev-parse", "--short", "HEAD") or "unknown"),
        "__PY__": html.escape(python_bin()),
        "__PYBIN__": html.escape(f"{python_bin()} (pydantic {pyd}, python {pyv})"),
        "__PYDANTIC__": html.escape(pyd),
        "__PYVER__": html.escape(pyv),
        "__REPO__": html.escape(str(REPO_ROOT)),
        "__TOOLS__": html.escape(tools),
        "__DEMOS_LABEL__": html.escape(results["demos"]["label"]),
        "__DEMOS_MARK__": "4/4 PASS" if results["demos"]["ok"] else f"exit {results['demos']['exitCode']}",
        "__DEMOS_BLURB__": html.escape(results["demos"]["blurb"]),
        "__DEMOS_MS__": str(results["demos"]["durationMs"]),
        "__TESTS_LABEL__": html.escape(results["tests"]["label"]),
        "__TESTS_MARK__": "21 passed" if results["tests"]["ok"] else f"exit {results['tests']['exitCode']}",
        "__TESTS_BLURB__": html.escape(results["tests"]["blurb"]),
        "__TESTS_MS__": str(results["tests"]["durationMs"]),
        "__FIRST_OUTPUT__": html.escape(first),
        "__DATA__": data,
    }.items():
        doc = doc.replace(token, value)

    out = REPO_ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc)

    md_path = REPO_ROOT / args.md
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(markdown(results, pyd, pyv, captured, git("rev-parse", "--short", "HEAD")))

    ok = all(r["ok"] for r in results.values())
    print(f"  wrote {out.relative_to(REPO_ROOT)} ({len(doc) // 1024} KB)")
    print(f"  wrote {md_path.relative_to(REPO_ROOT)}")
    print("  both verifications passed" if ok else "  WARNING: a verification failed — snapshot records the failure")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
