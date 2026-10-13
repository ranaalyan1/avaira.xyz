#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Avaira — one-command setup.
#
#   ./setup.sh                 fast path  (~7s, no config, no keys, no wallet)
#   ./setup.sh --dev           fast path + TypeScript/Python SDK + scorer tests
#   ./setup.sh --full          dev + contracts (Foundry) + frontend dependencies
#   ./setup.sh --serve         set up, then serve the browser Quickstart Console
#   ./setup.sh --check         doctor: report what is present / missing, change nothing
#
#   Flags: --yes (no prompts, for agents/CI) --json (machine-readable result on
#          stdout) --offline --with-foundry --no-color --port N
#
# The fast path is deliberately boring: it creates a local `.venv`, installs
# the handful of small dependencies the core needs, then *proves the install
# works* by running the four deterministic proof artifacts and all 21 kernel
# tests (eth-utils is what un-skips the keccak selector cross-check). No API keys, no database, no seed phrase, no sudo, no network config.
#
# Exit codes: 0 = the requested level is verified · 1 = core verification failed
#             · 2 = bad usage.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ── defaults ──────────────────────────────────────────────────────────────────
MODE="fast"            # fast | dev | full | check
ASSUME_YES=0
JSON=0
OFFLINE=0
SERVE=0
WITH_FOUNDRY=0
USE_COLOR=1
PORT="${AVAIRA_PORT:-8402}"
START_TS=$(date +%s)

# ── output helpers ────────────────────────────────────────────────────────────
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then USE_COLOR=1; else USE_COLOR=0; fi
C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
if [ "$USE_COLOR" = 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
fi

# Human-readable progress always goes to stderr so `--json` keeps stdout clean.
log()  { printf '%s\n' "$*" >&2; }
step() { printf '\n%s▸ %s%s\n' "$C_CYAN" "$*" "$C_RESET" >&2; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
note() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET" >&2; }

die_usage() { log "setup: $*"; log "Try: ./setup.sh --help"; exit 2; }

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat >&2 <<'TXT'

Modes
  (default) --fast     local .venv + deps, then verify the Cognitive OS
  --dev                also install & test the TS SDK, Python SDK and scorer (~11s)
  --full               also contracts (Foundry), frontend deps, .env scaffolds (~30s+)
  --check              doctor only — report status, change nothing

Examples
  ./setup.sh --yes --json          # what an AI agent should run
  ./setup.sh --serve               # set up, then open the Quickstart Console
  ./setup.sh --dev                 # contributor machine
TXT
}

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── argument parsing ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --fast|--quick)   MODE="fast" ;;
    --dev|--developer) MODE="dev" ;;
    --full)           MODE="full" ;;
    --check|--doctor) MODE="check" ;;
    --serve|--console) SERVE=1 ;;
    -y|--yes)         ASSUME_YES=1 ;;
    --json)           JSON=1 ;;
    --offline)        OFFLINE=1 ;;
    --with-foundry)   WITH_FOUNDRY=1 ;;
    --no-color)       USE_COLOR=0 ;;
    --port)           shift; PORT="${1:-}"; [ -n "$PORT" ] || die_usage "--port needs a number" ;;
    -h|--help)        usage; exit 0 ;;
    *)                die_usage "unknown argument: $1" ;;
  esac
  shift
done

# ── results collection ────────────────────────────────────────────────────────
RESULTS=()      # "name|status|detail"
record() { RESULTS+=("$1|$2|$3"); }

emit_json() {
  local status="$1"; shift
  local elapsed=$(( $(date +%s) - START_TS ))
  local first=1
  printf '{'
  printf '"status":"%s","mode":"%s","elapsedSeconds":%s,' "$status" "$MODE" "$elapsed"
  printf '"python":"%s","venv":"%s","port":%s,' "$PY_DESC" "${PY_BIN:-}" "$PORT"
  printf '"steps":['
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r n s d <<<"$r"
    [ $first = 1 ] || printf ','
    first=0
    printf '{"name":"%s","status":"%s","detail":"%s"}' \
      "$(printf '%s' "$n" | sed 's/"/\\"/g')" "$s" "$(printf '%s' "$d" | sed 's/"/\\"/g')"
  done
  printf ']}\n'
}

# ── run: execute a command, keep output, surface it only on failure ──────────
RUN_LOG="$(mktemp -t avaira-setup.XXXXXX)"
trap 'rm -f "$RUN_LOG"' EXIT

run() {  # run <label> <cmd...>
  local label="$1"; shift
  if "$@" >>"$RUN_LOG" 2>&1; then
    return 0
  fi
  bad "$label failed — last 20 lines:"
  tail -20 "$RUN_LOG" | sed 's/^/      /' >&2
  return 1
}

# Same, but silent on failure — used for attempts we can fall back from.
run_quiet() { local label="$1"; shift; run "$label" "$@" 2>/dev/null; }

# ── environment detection ─────────────────────────────────────────────────────
PY_DESC=""; PY_BIN=""

detect_python() {
  local candidates=(python3 python)
  for c in "${candidates[@]}"; do
    if need_cmd "$c"; then
      if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
        BASE_PY="$(command -v "$c")"
        return 0
      fi
    fi
  done
  return 1
}

# Prefer an existing venv (instant), then a system python that already has
# pydantic (also instant), and only then pay for creating a venv.
resolve_python() {
  if [ -x "$REPO_ROOT/.venv/bin/python" ]; then
    PY_BIN="$REPO_ROOT/.venv/bin/python"
    PY_DESC=".venv ($($PY_BIN -V 2>&1))"
    return 0
  fi

  detect_python || {
    bad "No Python >= 3.10 found. Install one and re-run:"
    note "  macOS:  brew install python@3.12"
    note "  Ubuntu: sudo apt install python3 python3-venv python3-pip"
    return 1
  }

  if "$BASE_PY" -c 'import pydantic' >/dev/null 2>&1; then
    PY_BIN="$BASE_PY"
    PY_DESC="system python with pydantic ($("$PY_BIN" -V 2>&1))"
    return 0
  fi

  step "Creating a local virtualenv (.venv)"
  if ! run "python -m venv" "$BASE_PY" -m venv "$REPO_ROOT/.venv"; then
    warn "Could not create a venv (missing python3-venv / ensurepip?)."
    note "Falling back to the system interpreter."
    PY_BIN="$BASE_PY"; PY_DESC="system python ($("$PY_BIN" -V 2>&1))"
    return 0
  fi
  PY_BIN="$REPO_ROOT/.venv/bin/python"
  PY_DESC=".venv ($($PY_BIN -V 2>&1))"
  ok "created .venv"
}

install_python_deps() {  # install_python_deps <task-label> <packages...>
  local label="$1"; shift
  if "$PY_BIN" -c 'import pydantic, pytest, eth_utils' >/dev/null 2>&1; then
    ok "$label already installed — skipping download"
    return 0
  fi
  if [ "$OFFLINE" = 1 ]; then
    warn "$label missing and --offline was given"
    return 1
  fi
  if run "$label (pip install)" "$PY_BIN" -m pip install --quiet --disable-pip-version-check "$@"; then
    ok "installed $label"
    return 0
  fi
  return 1
}

# ── checks ────────────────────────────────────────────────────────────────────
check_core() {
  step "Core — Cognitive OS v5.0 (offline, deterministic)"
  resolve_python || { record "python" "fail" "no python >= 3.10"; return 1; }
  record "python" "ok" "$PY_DESC"

  if install_python_deps "core deps (pydantic, pytest, eth-utils)" \
      "pydantic>=2" "pytest>=8" "eth-utils>=2.3" "eth-hash[pycryptodome]>=0.5"; then
    record "deps" "ok" "pydantic + pytest + eth-utils"
  else
    record "deps" "fail" "could not install pydantic/pytest"
    return 1
  fi

  : >"$RUN_LOG"
  if run "proof artifacts" "$PY_BIN" -m avaira_os.demos; then
    local n
    n=$(grep -c '\[PASS\]' "$RUN_LOG" || true)
    if grep -q 'all proof artifacts: PASS' "$RUN_LOG"; then
      ok "proof artifacts: $n/4 PASS (self-correction, ambiguity, math-safety clamp, slash)"
      record "proof-artifacts" "ok" "$n/4 PASS"
    else
      bad "proof artifacts did not all pass"
      tail -20 "$RUN_LOG" | sed 's/^/      /' >&2
      record "proof-artifacts" "fail" "incomplete transcript"
      return 1
    fi
  else
    record "proof-artifacts" "fail" "run failed"
    return 1
  fi

  : >"$RUN_LOG"
  if run "kernel tests" "$PY_BIN" -m pytest tests/test_cognitive_os.py -q; then
    local summary
    summary="$(tail -3 "$RUN_LOG" | grep -Eo '[0-9]+ passed[^,]*' | head -1 || true)"
    if [ -z "$summary" ] && ! grep -q 'passed' "$RUN_LOG"; then
      bad "kernel tests did not report a pass line"
      record "kernel-tests" "fail" "unexpected pytest output"
      return 1
    fi
    ok "kernel tests: ${summary:-passed}"
    record "kernel-tests" "ok" "${summary:-passed}"
  else
    record "kernel-tests" "fail" "pytest failed"
    return 1
  fi

  ok "integration frozen by seed + logical clock — two runs are byte-identical"
  return 0
}

check_dev() {
  step "Developer — SDKs & scorer"
  if [ "$OFFLINE" = 1 ]; then
    warn "--offline: skipping npm and SDK installs"
    record "dev" "skip" "offline"
    return 0
  fi
  if ! need_cmd npm; then
    warn "npm not found — skipping TypeScript SDK & scorer (core still verified)"
    record "dev" "skip" "npm missing"
    return 0
  fi
  local failed=0

  if [ ! -d sdk/typescript/node_modules ]; then
    run "sdk/typescript npm install" npm --prefix sdk/typescript install --no-audit --no-fund \
      || failed=1
  fi
  if [ -d sdk/typescript/node_modules ]; then
    : >"$RUN_LOG"
    if run "TS SDK tests" bash -c 'cd sdk/typescript && npm test'; then
      ok "TypeScript SDK: tests pass"
      record "ts-sdk" "ok" "tests pass"
    else
      record "ts-sdk" "fail" "npm test failed"; failed=1
    fi
  fi

  if [ ! -d services/scorer/node_modules ]; then
    run "services/scorer npm install" npm --prefix services/scorer install --no-audit --no-fund \
      || failed=1
  fi
  if [ -d services/scorer/node_modules ]; then
    : >"$RUN_LOG"
    if run "scorer test" bash -c 'cd services/scorer && npm test'; then
      ok "scorer: tests pass"
      record "scorer" "ok" "tests pass"
    else
      record "scorer" "fail" "npm test failed"; failed=1
    fi
  fi

  if [ -d sdk/python ]; then
    if ! "$PY_BIN" -c 'import avaira' >/dev/null 2>&1; then
      run "pip install -e sdk/python" "$PY_BIN" -m pip install --quiet --disable-pip-version-check \
        -e sdk/python || failed=1
    fi
    : >"$RUN_LOG"
    if run "python SDK tests" "$PY_BIN" -m pytest sdk/python/tests -q; then
      ok "python SDK: tests pass"
      record "py-sdk" "ok" "tests pass"
    else
      record "py-sdk" "fail" "pytest failed"; failed=1
    fi
  fi

  return $failed
}

check_full() {
  local failed=0
  check_dev || failed=1
  step "Contracts — Foundry suite"

  # .env scaffolds (never overwrite, never invent secrets)
  if [ ! -f contracts/.env ] && [ -f contracts/.env.example ]; then
    cp contracts/.env.example contracts/.env
    ok "created contracts/.env (copy of .env.example — fill in before deploying)"
    record "contracts-env" "ok" "contracts/.env scaffolded"
  fi

  if need_cmd forge; then
    : >"$RUN_LOG"
    if run "forge test" bash -c 'cd contracts && forge test'; then
      ok "contracts: Foundry suite passes"
      record "contracts" "ok" "forge test passes"
    else
      record "contracts" "fail" "forge test failed"
      failed=1
    fi
  elif [ "$WITH_FOUNDRY" = 1 ]; then
    if [ "$OFFLINE" = 1 ]; then
      warn "cannot install Foundry with --offline"
      record "contracts" "skip" "offline"
    else
      step "Installing Foundry (foundryup)"
      if run "foundryup" bash -c 'curl -sL https://foundry.paradigm.xyz | bash && "$HOME/.foundry/bin/foundryup"'; then
        export PATH="$HOME/.foundry/bin:$PATH"
        if run "forge test" bash -c 'cd contracts && forge test'; then
          ok "contracts: Foundry suite passes"
          record "contracts" "ok" "installed foundry + forge test passes"
        else
          record "contracts" "fail" "forge test failed after install"
          failed=1
        fi
      else
        record "contracts" "fail" "foundryup failed"
        failed=1
      fi
    fi
  else
    warn "forge not found — skipping the Solidity suite (no keys or funds needed to run it)"
    note "Install it with:  ./setup.sh --full --with-foundry"
    record "contracts" "skip" "forge not installed"
  fi

  step "Frontend — React protocol dashboard (optional)"
  if [ "$OFFLINE" = 1 ] || ! need_cmd npm; then
    record "frontend" "skip" "npm missing or offline"
  elif [ -d frontend/node_modules ]; then
    ok "frontend/node_modules present"
    record "frontend" "ok" "deps present"
  elif [ "$ASSUME_YES" = 1 ]; then
    # CI uses yarn against frontend/yarn.lock; npm needs --legacy-peer-deps because
    # the CRA + shadcn dependency tree has long-standing peer conflicts.
    local fe_ok=0
    if need_cmd yarn && [ -f frontend/yarn.lock ]; then
      if run_quiet "frontend yarn install" bash -c 'cd frontend && yarn install --frozen-lockfile'; then
        ok "frontend dependencies installed (yarn)"
        record "frontend" "ok" "yarn install done"
        fe_ok=1
      else
        note "yarn failed (often a stale local yarn cache) — retrying with npm"
      fi
    fi
    if [ "$fe_ok" = 0 ]; then
      # npm needs --legacy-peer-deps: the CRA + shadcn tree has long-standing peer conflicts.
      if run "frontend npm install" npm --prefix frontend install --no-audit --no-fund --legacy-peer-deps; then
        ok "frontend dependencies installed (npm)"
        record "frontend" "ok" "npm install done"
      else
        # The dashboard is optional; the core and contracts verdicts already stand.
        warn "frontend install failed — retry with: cd frontend && npm install --legacy-peer-deps"
        record "frontend" "warn" "install failed (optional)"
      fi
    fi
  else
    warn "frontend dependencies not installed (~30s). Run: cd frontend && npm install --legacy-peer-deps"
    record "frontend" "skip" "deps not installed"
  fi

  note "Backend control plane is intentionally out of the fast path: it needs"
  note "MongoDB + API keys. See SETUP.md → 'Control plane' when you want it."
  return $failed
}

# ── check mode ────────────────────────────────────────────────────────────────
doctor() {
  step "Avaira doctor — environment report"
  detect_python && ok "python: $BASE_PY ($("$BASE_PY" -V 2>&1))" || bad "python >= 3.10 missing"
  if [ -x .venv/bin/python ]; then ok "venv: .venv present"; else warn "venv: not created yet"; fi
  if [ -x .venv/bin/python ] && .venv/bin/python -c 'import pydantic' 2>/dev/null; then
    ok "pydantic: installed in .venv"
  elif detect_python && "$BASE_PY" -c 'import pydantic' 2>/dev/null; then
    ok "pydantic: available in system python"
  else
    warn "pydantic: not installed (the fast path installs it in .venv)"
  fi
  for t in forge node npm docker; do
    need_cmd "$t" && ok "$t: $(command -v "$t")" || warn "$t: not installed"
  done
  [ -f contracts/.env ] && ok "contracts/.env: present" || warn "contracts/.env: not scaffolded"
  printf '\n' >&2
  log "Run ./setup.sh to fix everything on the fast path."
  return 0
}

# ── main ──────────────────────────────────────────────────────────────────────
log ""
log "${C_DIM}Avaira setup${C_RESET} — ${C_DIM}repo: $REPO_ROOT${C_RESET}"

FAILED=0
case "$MODE" in
  check) doctor; exit 0 ;;
  fast)  check_core || FAILED=1 ;;
  dev)   check_core || FAILED=1; [ "$FAILED" = 1 ] || check_dev || FAILED=1 ;;
  full)  check_core || FAILED=1; [ "$FAILED" = 1 ] || check_full || FAILED=1 ;;
esac

ELAPSED=$(( $(date +%s) - START_TS ))
STATUS=$([ "$FAILED" = 0 ] && echo "ok" || echo "failed")

if [ "$JSON" = 1 ]; then
  emit_json "$STATUS"
else
  log ""
  if [ "$FAILED" = 0 ]; then
    printf '%s' "$C_GREEN" >&2
    log "  ✓ Avaira is set up and verified in ${ELAPSED}s"
    printf '%s' "$C_RESET" >&2
    log ""
    log "  Next:"
    if [ "$MODE" = "fast" ]; then
      log "    ./setup.sh --serve        → browser console: run the proof artifacts live"
      log "    ./setup.sh --dev          → add the SDKs and scorer"
      log "    ./setup.sh --full         → add contracts + frontend"
    else
      log "    ./setup.sh --serve        → browser console: run the proof artifacts live"
    fi
    log "    make help                 → every task"
    log ""
  else
    printf '%s' "$C_RED" >&2
    log "  ✗ setup failed after ${ELAPSED}s — scroll up for the failing step"
    printf '%s' "$C_RESET" >&2
    log ""
  fi
fi

[ "$FAILED" = 0 ] || exit 1

# ── optional: serve the Quickstart Console ────────────────────────────────────
if [ "$SERVE" = 1 ]; then
  step "Quickstart Console → http://localhost:${PORT}"
  exec "$PY_BIN" tools/quickstart/server.py --port "$PORT"
fi
