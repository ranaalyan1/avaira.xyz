#!/usr/bin/env python3
"""Avaira Quickstart Console.

A dependency-free browser page that proves a local Avaira install actually
works. It exposes exactly two actions — the four deterministic proof
artifacts, and the Cognitive OS kernel test suite — and streams their output
back to the page. Nothing else on this machine is reachable from here.

    python3 tools/quickstart/server.py --port 8402

Binds 0.0.0.0 so it works behind container/sandbox preview proxies, which
rewrite the Host header; there is no host allowlist by design.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VENV_PY = REPO_ROOT / ".venv" / "bin" / "python"
RUN_TIMEOUT_S = 180

# The console can only ever run these, with no user-supplied arguments.
ACTIONS = {
    "demos": {
        "label": "Proof artifacts",
        "argv": ["-m", "avaira_os.demos"],
        "blurb": "4 deterministic proofs: self-correction, ambiguity suspension, math-safety clamp, pre-execution slash",
        "pass_marker": "all proof artifacts: PASS",
    },
    "tests": {
        "label": "Kernel tests",
        "argv": ["-m", "pytest", "tests/test_cognitive_os.py", "-q"],
        "blurb": "21 tests across the five Cognitive OS pillars",
        "pass_marker": "passed",
    },
}

_run_lock = threading.Lock()
_last: dict[str, dict] = {}


def python_bin() -> str:
    """Prefer the local .venv — the console may be launched by any interpreter."""
    if VENV_PY.exists():
        return str(VENV_PY)
    return sys.executable


def run_action(key: str) -> dict:
    spec = ACTIONS[key]
    started = time.time()
    try:
        proc = subprocess.run(
            [python_bin(), *spec["argv"]],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_S,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        # The demos/test runners print the most useful lines last.
        passed = proc.returncode == 0 and spec["pass_marker"] in out
        result = {
            "id": key,
            "label": spec["label"],
            "ok": passed,
            "exitCode": proc.returncode,
            "durationMs": round((time.time() - started) * 1000),
            "output": out[-12000:],
            "summary": summarise(key, out, proc.returncode),
            "at": time.strftime("%H:%M:%S"),
        }
    except subprocess.TimeoutExpired:
        result = {
            "id": key, "label": spec["label"], "ok": False, "exitCode": None,
            "durationMs": round((time.time() - started) * 1000),
            "output": f"Timed out after {RUN_TIMEOUT_S}s.",
            "summary": "timed out", "at": time.strftime("%H:%M:%S"),
        }
    _last[key] = result
    return result


def summarise(key: str, out: str, exit_code: int) -> str:
    if key == "demos":
        passed = sum(1 for line in out.splitlines() if "[PASS]" in line)
        return f"{passed}/4 proof artifacts PASS" if passed == 4 else f"{passed}/4 passed"
    for line in reversed(out.splitlines()):
        if "passed" in line or "failed" in line or "error" in line:
            return line.strip()[:160]
    return f"exit {exit_code}"


def health() -> dict:
    tools = {name: bool(shutil.which(name)) for name in ("forge", "node", "npm", "docker", "git")}
    core = None
    try:
        probe = subprocess.run(
            [python_bin(), "-c", "import pydantic,sys;print(pydantic.VERSION);print(sys.version.split()[0])"],
            capture_output=True, text=True, timeout=30, cwd=str(REPO_ROOT),
        )
        if probe.returncode == 0:
            version, py = probe.stdout.split()
            core = {"pydantic": version, "python": py}
    except Exception:
        core = None
    commit = ""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
            timeout=10, cwd=str(REPO_ROOT),
        ).stdout.strip()
    except Exception:
        commit = ""
    return {
        "repo": str(REPO_ROOT),
        "interpreter": python_bin(),
        "core": core,
        "coreReady": core is not None,
        "tools": tools,
        "commit": commit,
        "actions": {k: {"label": v["label"], "blurb": v["blurb"]} for k, v in ACTIONS.items()},
        "last": _last,
    }


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Avaira — Quickstart Console</title>
<style>
  :root { --bg:#0a0e14; --panel:#111823; --line:#1e2a3a; --ink:#e6f1ff;
          --dim:#8ba3bd; --cyan:#00e5ff; --green:#10b981; --red:#ef4444; --amber:#f59e0b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:40px 22px 80px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
  .mark { width:44px; height:44px; border-radius:12px; flex:0 0 auto;
          background:linear-gradient(135deg,var(--cyan),#7c3aed);
          display:grid; place-items:center; font-weight:800; color:#04121a; font-size:20px; }
  h1 { font-size:26px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--dim); margin:2px 0 26px; font-size:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px;
          padding:18px; margin-bottom:16px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:4px 11px; border-radius:999px;
          font-size:12.5px; font-weight:600; border:1px solid var(--line); background:#0d1520; }
  .pill.ok { color:var(--green); border-color:#134e3a; }
  .pill.no { color:var(--red); border-color:#5a1f1f; }
  .pill.warn { color:var(--amber); border-color:#5a431a; }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
  button { font:inherit; font-weight:600; cursor:pointer; border-radius:10px; padding:11px 16px;
           border:1px solid var(--line); background:#16212f; color:var(--ink); transition:.15s; }
  button:hover:not(:disabled) { border-color:var(--cyan); color:var(--cyan); }
  button.primary { background:var(--cyan); color:#04121a; border-color:var(--cyan); }
  button.primary:hover:not(:disabled) { filter:brightness(1.1); color:#04121a; }
  button:disabled { opacity:.5; cursor:progress; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.09em; color:var(--dim);
       margin:0 0 12px; }
  pre { background:#070c13; border:1px solid var(--line); border-radius:10px; padding:14px;
        overflow:auto; max-height:340px; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
        color:#cfe6ff; margin:14px 0 0; white-space:pre-wrap; word-break:break-word; }
  code { font-family:ui-monospace,Menlo,monospace; background:#0d1520; border:1px solid var(--line);
         padding:1.5px 6px; border-radius:6px; font-size:13px; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
        border-bottom:1px dashed #16202e; font-size:13.5px; }
  .kv:last-child { border-bottom:0; }
  .kv span:first-child { color:var(--dim); }
  .mono { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; }
  .hint { color:var(--dim); font-size:13px; margin-top:10px; }
  a { color:var(--cyan); }
  .steps li { margin-bottom:6px; color:var(--dim); }
  .steps b { color:var(--ink); font-weight:600; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark">A</div>
    <div>
      <h1>Avaira Quickstart Console</h1>
      <div class="sub" style="margin:0">Local proof that your install works — no keys, no chain, no database.</div>
    </div>
  </header>

  <div class="card">
    <h2>Environment</h2>
    <div id="health" class="row"><span class="pill">probing…</span></div>
    <div id="details" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>Run the verification</h2>
    <div class="grid">
      <div>
        <button class="primary" id="btn-demos" onclick="run('demos')">Run proof artifacts</button>
        <div class="hint">Self-correction · ambiguity suspension · math-safety clamp · pre-execution slash with atomic stake burn.</div>
      </div>
      <div>
        <button id="btn-tests" onclick="run('tests')">Run kernel tests</button>
        <div class="hint">21 tests over the five Cognitive OS pillars (kernel, memory, prover, gate, ledger).</div>
      </div>
    </div>
    <pre id="out">Pick a button above. Output streams here.</pre>
  </div>

  <div class="card">
    <h2>Next steps</h2>
    <ol class="steps">
      <li><b>Guard a real agent:</b> <code>pip install -e sdk/python</code>, then wrap your execution function.</li>
      <li><b>Add the SDKs and scorer:</b> <code>./setup.sh --dev</code></li>
      <li><b>Run the Solidity suite:</b> <code>./setup.sh --full --with-foundry</code></li>
      <li><b>Deploy to Monad testnet:</b> fund a wallet from <a href="https://testnet.monad.xyz" target="_blank" rel="noreferrer">the faucet</a>, fill <code>contracts/.env</code>, run <code>make deploy-monad</code>.</li>
    </ol>
    <div class="hint">Full docs: <code>SETUP.md</code> · agent instructions: <code>AGENTS.md</code></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function loadHealth() {
  try {
    const h = await (await fetch('api/health')).json();
    const pills = [];
    pills.push(`<span class="pill ${h.coreReady ? 'ok' : 'no'}"><i class="dot"></i>${h.coreReady
      ? 'Cognitive OS ready · pydantic ' + h.core.pydantic + ' · py ' + h.core.python
      : 'Core not installed — run ./setup.sh'}</span>`);
    for (const [name, present] of Object.entries(h.tools)) {
      if (!present) continue;
      pills.push(`<span class="pill ok"><i class="dot"></i>${name}</span>`);
    }
    $('health').innerHTML = pills.join('');
    $('details').innerHTML = `
      <div class="kv"><span>Repository</span><span class="mono">${esc(h.repo)}</span></div>
      <div class="kv"><span>Interpreter</span><span class="mono">${esc(h.interpreter)}</span></div>
      <div class="kv"><span>Commit</span><span class="mono">${esc(h.commit || 'unknown')}</span></div>
      <div class="kv"><span>Missing tools</span><span class="mono">${
        Object.entries(h.tools).filter(([, p]) => !p).map(([n]) => n).join(', ') || 'none'}</span></div>`;
  } catch (e) {
    $('health').innerHTML = '<span class="pill no"><i class="dot"></i>server unreachable</span>';
  }
}

async function run(id) {
  const btn = $('btn-' + id), out = $('out');
  const label = id === 'demos' ? 'proof artifacts' : 'kernel tests';
  btn.disabled = true;
  out.textContent = `Running ${label}…`;
  try {
    const r = await (await fetch('api/run/' + id, { method: 'POST' })).json();
    const head = r.ok
      ? `✓ ${r.label}: ${r.summary} — ${r.durationMs} ms\n`
      : `✗ ${r.label}: ${r.summary} (exit ${r.exitCode}) — ${r.durationMs} ms\n`;
    out.textContent = head + '─'.repeat(72) + '\n' + r.output;
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('stale'));
    loadHealth();
  } catch (e) {
    out.textContent = 'Request failed: ' + e;
  } finally {
    btn.disabled = false;
  }
}
loadHealth();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "AvairaQuickstart/1.0"

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: dict, code: int = 200) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/api/health":
            self._json(health())
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        key = path.rsplit("/", 1)[-1] if path.startswith("/api/run/") else ""
        if key not in ACTIONS:
            self._json({"error": "unknown action"}, 404)
            return
        # One heavy subprocess at a time; the deterministic runs are short anyway.
        with _run_lock:
            self._json(run_action(key))

    def log_message(self, fmt: str, *args) -> None:  # quieter logs
        sys.stderr.write("  · %s\n" % (fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser(description="Avaira Quickstart Console")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AVAIRA_PORT", 8402)))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"  Avaira Quickstart Console → http://localhost:{args.port}", flush=True)
    print(f"  repo: {REPO_ROOT}", flush=True)
    print("  Ctrl-C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
