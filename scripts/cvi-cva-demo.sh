#!/usr/bin/env bash
# CVI/CVA compliance demo — one command, full Travel-Rule flow.
#
#   ./scripts/cvi-cva-demo.sh            # local: anvil (chain 10143) + fresh deploy + demo
#   LIVE=1 ./scripts/cvi-cva-demo.sh     # against Monad Testnet (needs funded keys in env)
#
# Local mode needs no keys: it uses anvil's account #0 as the protocol admin /
# Cleanverse issuer. Live mode reads OPERATOR_PRIVATE_KEY (+ optional agent keys)
# and AVAIRA_DEPLOYMENT (defaults to deployments/10143.json).
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${AVAIRA_RPC_URL:-http://127.0.0.1:8545}"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_PID=""

cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [[ "${LIVE:-0}" == "1" ]]; then
  echo "── live mode: Monad Testnet ──"
  RPC="${AVAIRA_RPC_URL:-https://testnet-rpc.monad.xyz}"
  MANIFEST="${AVAIRA_DEPLOYMENT:-deployments/10143.json}"
  : "${OPERATOR_PRIVATE_KEY:?LIVE=1 requires OPERATOR_PRIVATE_KEY}"
else
  echo "── local mode: anvil on chain id 10143 ──"
  if ! curl -s -m 2 -X POST "$RPC" -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' > /dev/null; then
    echo "starting anvil…"
    anvil --chain-id 10143 --block-time 1 --host 127.0.0.1 --port 8545 > /tmp/anvil-cvi.log 2>&1 &
    ANVIL_PID=$!
    sleep 2
  fi
  MANIFEST="deployments/10143.local.json"
  export OPERATOR_PRIVATE_KEY="${OPERATOR_PRIVATE_KEY:-$ANVIL_KEY}"
  rm -f scripts/.demo-state.json

  echo "deploying the Avaira stack (fresh)…"
  (
    cd contracts
    DEPLOYER_PRIVATE_KEY="$OPERATOR_PRIVATE_KEY" MANIFEST_FILE="deployments/10143.local.json" \
      forge script script/Deploy.s.sol:DeployAvaira --rpc-url "$RPC" --broadcast --slow
  ) > /tmp/cvi-deploy.log 2>&1 || { tail -20 /tmp/cvi-deploy.log; exit 1; }
  cp contracts/deployments/10143.local.json "$MANIFEST"
  echo "deployed — manifest at $MANIFEST"
fi

cd scripts
AVAIRA_RPC_URL="$RPC" AVAIRA_DEPLOYMENT="../$MANIFEST" npx tsx demo-cvi-cva.ts
