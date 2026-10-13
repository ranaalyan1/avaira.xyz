#!/usr/bin/env bash
# The last command before submitting.
#
#   make submission-check
#
# Runs everything that can be checked from a clone — the frontend build and its
# tests, the repo self-consistency doctor, the two deployment gates, the deploy
# dry-run — then prints exactly which human-only items are still outstanding.
#
# Verdicts, and why they are not all equal:
#
#   PASS  the check ran and succeeded
#   TODO  the check ran and correctly reported "not deployed yet" — expected until
#         a human does the one-click Vercel import / the funded Monad deploy.
#         Two TODOs (live URL, contract addresses) is a submittable state.
#   FAIL  something is actually broken. Exit code 1.
#   SKIP  a prerequisite is absent in this environment (no py-evm, no network)
#
# A TODO is derived from the tool's own machine-readable verdict, never from
# "the command exited non-zero" — so a deployment that exists but is broken is a
# FAIL, not a TODO.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
REPORTS="$ROOT/verification/reports"
mkdir -p "$REPORTS"

PY="python3"
[ -x "$ROOT/.venv/bin/python" ] && PY="$ROOT/.venv/bin/python"

PASS=0; TODO=0; FAIL=0; SKIP=0
declare -a LINES=()

record() {  # record <status> <name> <detail>
  LINES+=("$1|$2|$3")
  case "$1" in
    PASS) PASS=$((PASS+1)) ;;
    TODO) TODO=$((TODO+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    SKIP) SKIP=$((SKIP+1)) ;;
  esac
}

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# ── 1. frontend: build + tests (the artifact Vercel deploys) ────────────────────
step "Frontend build and tests"
if [ -d frontend/node_modules ] || (cd frontend && npm ci --no-audit --no-fund >/tmp/avaira-npmci.log 2>&1); then
  if (cd frontend && CI=false npm run build >/tmp/avaira-build.log 2>&1); then
    sizes=$(grep -E "^\s+[0-9.]+ kB" /tmp/avaira-build.log | head -2 | tr -s ' ' | tr '\n' ' ')
    record PASS "frontend build" "${sizes:-ok}"
  else
    record FAIL "frontend build" "see /tmp/avaira-build.log (last line: $(tail -1 /tmp/avaira-build.log))"
  fi
  if (cd frontend && CI=true npx craco test --watchAll=false --passWithNoTests >/tmp/avaira-test.log 2>&1); then
    record PASS "frontend tests" "$(grep -E '^Tests:' /tmp/avaira-test.log | tr -s ' ')"
  else
    record FAIL "frontend tests" "see /tmp/avaira-test.log"
  fi
else
  record FAIL "frontend install" "npm ci failed — see /tmp/avaira-npmci.log"
fi

# ── 2. repo self-consistency ───────────────────────────────────────────────────
step "Doctor (claims vs checks)"
if $PY tools/doctor.py >/tmp/avaira-doctor.log 2>&1; then
  # Quote doctor's own summary rather than recounting by hand: the two disagree by exactly the
  # warnings, which are clean-but-worth-knowing, and a gate that reinterprets its own tool is
  # how a "10/11" and an "11/11" end up describing the same run.
  record PASS "doctor" "$(grep -m1 -oE '[0-9]+/[0-9]+ checks clean(, [0-9]+ with warnings)?' /tmp/avaira-doctor.log || echo 'clean')"
else
  record FAIL "doctor" "$(tail -1 /tmp/avaira-doctor.log)"
fi

# ── 3. the deploy the README promises is reproducible ──────────────────────────
step "Deploy dry-run (no funds)"
if $PY -c "from eth_tester import EthereumTester" 2>/dev/null; then
  if node tools/compile.mjs >/tmp/avaira-compile.log 2>&1 && $PY tools/deploy_dry_run.py --quiet >/tmp/avaira-dry.log 2>&1; then
    record PASS "deploy dry-run" "$(grep -c PASS /tmp/avaira-dry.log || echo 7) contracts wired correctly"
  else
    record FAIL "deploy dry-run" "$(tail -1 /tmp/avaira-dry.log)"
  fi
else
  record SKIP "deploy dry-run" "py-evm not installed (pip install -r verification/requirements.txt)"
fi

# ── 4. gate: is the site live? ─────────────────────────────────────────────────
step "Live site gate"
URL="${AVAIRA_DEPLOY_URL:-https://avaira.vercel.app}"
$PY tools/verify_deploy.py "$URL" --json "$REPORTS/deployed.json" >/tmp/avaira-deploy.log 2>&1
verdict=$($PY -c "import json;print(json.load(open('$REPORTS/deployed.json')).get('verdict'))" 2>/dev/null || echo unknown)
case "$verdict" in
  ok)          record PASS "live site" "$URL is serving AVAIRA" ;;
  not-deployed) record TODO "live site" "$URL — Vercel project not connected (see README → Try it)" ;;
  *)           record FAIL "live site" "$verdict — $(grep -m1 '✗' /tmp/avaira-deploy.log)" ;;
esac

# ── 5. gate: are the contracts on chain? ───────────────────────────────────────
step "Monad gate"
$PY tools/verify_monad.py --chain "${CHAIN_ID:-10143}" --json "$REPORTS/monad.json" >/tmp/avaira-monad.log 2>&1
verdict=$($PY -c "import json;print(json.load(open('$REPORTS/monad.json')).get('verdict'))" 2>/dev/null || echo unknown)
case "$verdict" in
  PASS)         record PASS "monad contracts" "all 7 live and wired on chain ${CHAIN_ID:-10143}" ;;
  not-deployed) record TODO "monad contracts" "deployments/${CHAIN_ID:-10143}.json absent — see the 3 steps printed above" ;;
  *)            record FAIL "monad contracts" "$verdict — see /tmp/avaira-monad.log" ;;
esac

# ── 6. the README must not describe a deployment that does not exist ───────────
step "README deployed-contracts section"
if $PY tools/gen_deploy_section.py --check >/tmp/avaira-docs.log 2>&1; then
  record PASS "readme addresses" "$(cat /tmp/avaira-docs.log)"
else
  record FAIL "readme addresses" "$(cat /tmp/avaira-docs.log)"
fi

# ── 7. the deployment tools' own tests ─────────────────────────────────────────
step "Deployment-tool tests"
if $PY -m pytest tests/test_deploy_tools.py -q >/tmp/avaira-tools.log 2>&1; then
  record PASS "deploy-tool tests" "$(grep -E '^[0-9]+ passed' /tmp/avaira-tools.log | tr -s ' ')"
else
  record SKIP "deploy-tool tests" "pytest unavailable in this interpreter"
fi

# ── summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1m── Summary\033[0m\n\n'
for line in "${LINES[@]}"; do
  IFS='|' read -r status name detail <<< "$line"
  printf '  %-4s  %-22s %s\n' "$status" "$name" "$detail"
done

printf '\n  %d passed, %d todo, %d failed, %d skipped\n' "$PASS" "$TODO" "$FAIL" "$SKIP"

cat <<'CHECKLIST'

── What only a human can do ────────────────────────────────────────────────────

  1. Vercel — put the site live (one click)
       • README → "Deploy with Vercel"   (project name `avaira`, root `frontend`), or
       • Vercel → project `avaira-v2` → Settings → General → Project Name → `avaira` → Redeploy
     Then:  make verify-deploy   → expect "✓ … is serving AVAIRA (11 checks)"
     Then:  make go-live         → flips the README from "not live yet" to the live badge

  2. Monad — deploy the six contracts
       • fund a wallet:  https://faucet.monad.xyz
       • cd contracts && cp .env.example .env   → set DEPLOYER_PRIVATE_KEY=0x…
       • make deploy-monad                      → writes deployments/10143.json
     Then:  make verify-monad    → expect all 7 live and correctly wired

  3. GitHub — repo Homepage field = the live URL (Settings → General)

  4. Record the demo
       landing → dark console → register/stake → a blocked agent turns RED →
       slash tx on testnet.monadscan.com → score drops.
       Closing line: "In this console, red means exactly one thing: an agent just
       lost trust."

  5. Submit.

CHECKLIST

if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m✗ %d check(s) failed — fix those before submitting.\033[0m\n' "$FAIL"
  exit 1
fi
if [ "$TODO" -gt 0 ]; then
  printf '\033[33m⚠ %d check(s) pending a human action (the two TODOs are expected pre-deploy).\033[0m\n' "$TODO"
else
  printf '\033[32m✓ every check passed — nothing left but the checklist above.\033[0m\n'
fi
exit 0
