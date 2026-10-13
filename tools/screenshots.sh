#!/usr/bin/env bash
# One command for the human: build the site, serve it, re-capture the screenshots.
#
#   make screenshots            # public routes
#   make screenshots CONSOLE=1  # + the authenticated console (backend required)
#
# The committed verification/*.png predate the dual-theme redesign, so they no
# longer match the shipped UI. This is the documented way to refresh them.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${PORT:-3000}"

PY="python3"
[ -x "$ROOT/.venv/bin/python" ] && PY="$ROOT/.venv/bin/python"

if ! $PY -c "import playwright" 2>/dev/null; then
  cat >&2 <<'MSG'
✗ playwright is not installed, so the screenshots cannot be regenerated here.

  Install it once (~1 min, downloads a chromium build):

      python3 -m pip install playwright
      python3 -m playwright install chromium

  Then re-run:  make screenshots

  If chromium cannot be downloaded in your environment (some sandboxes block the
  CDN), the committed PNGs stay as they are — they are stale, not wrong, and the
  README notes this until they are refreshed.
MSG
  exit 1
fi

echo "── building frontend"
(cd frontend && npm ci --no-audit --no-fund >/dev/null 2>&1 || true)
(cd frontend && CI=false npm run build >/tmp/avaira-shots-build.log 2>&1) || {
  echo "✗ frontend build failed — see /tmp/avaira-shots-build.log" >&2
  exit 1
}

echo "── serving frontend/build on :$PORT"
(cd frontend && npx --yes serve@14 -s build -l "tcp://0.0.0.0:$PORT" --no-clipboard >/tmp/avaira-shots-server.log 2>&1) &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 1
done
curl -sf -o /dev/null "http://localhost:$PORT/" || {
  echo "✗ the preview server never came up — see /tmp/avaira-shots-server.log" >&2
  exit 1
}

echo "── capturing"
if [ "${CONSOLE:-0}" = "1" ]; then
  $PY tools/screenshots.py --base "http://localhost:$PORT" --console
else
  $PY tools/screenshots.py --base "http://localhost:$PORT"
fi

echo
echo "✓ done — review the diffs before committing:"
echo "    git diff --stat verification/*.png"
echo "  The console shots need a backend; without one the SPA redirects to /login,"
echo "  which is why they are opt-in (CONSOLE=1)."
