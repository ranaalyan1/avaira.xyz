#!/usr/bin/env bash
# Avaira — deploy the full Monad-native stack, then verify every contract on the explorer.
#
#   cd contracts && cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY
#   make deploy-monad                      # or: ./scripts/deploy-monad.sh
#
# Writes deployments/{chainId}.json, which the SDK, dashboard and README read.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY in contracts/.env (see .env.example)}"
RPC="${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")

echo "── Avaira deploy ──────────────────────────────────────────"
echo "  rpc      : $RPC"
echo "  chain id : $CHAIN_ID"
echo "  deployer : $(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "  balance  : $(cast balance --ether "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" --rpc-url "$RPC") MON"
echo "───────────────────────────────────────────────────────────"

# Sanity: refuse to broadcast an unfunded deploy.
BALANCE_WEI=$(cast balance "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" --rpc-url "$RPC")
if [[ "$BALANCE_WEI" == "0" ]]; then
  echo "✗ deployer has 0 MON. Fund it first: https://testnet.monad.xyz (faucet)" >&2
  exit 1
fi

forge script script/Deploy.s.sol:DeployAvaira \
  --rpc-url "$RPC" \
  --broadcast \
  --slow \
  --gas-estimate-multiplier 120

echo
echo "✓ deployment manifest written to deployments/$CHAIN_ID.json"
echo
bash scripts/verify-monad.sh "$CHAIN_ID" || {
  echo "! verification failed — deploy succeeded, re-run: make verify-monad" >&2
  exit 1
}
