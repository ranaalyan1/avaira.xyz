#!/usr/bin/env bash
# Avaira — deploy the full Robinhood-native stack, then verify every contract on the explorer.
#
#   cd contracts && cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY
#   make deploy-robinhood                      # or: ./scripts/deploy-robinhood.sh
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

# ROBINHOOD_DEPLOYER_KEY is accepted as an alias so the name used in the docs and the
# name used by other tooling both work; DEPLOYER_PRIVATE_KEY stays canonical.
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-${ROBINHOOD_DEPLOYER_KEY:-}}"
export DEPLOYER_PRIVATE_KEY

if [[ -z "$DEPLOYER_PRIVATE_KEY" ]]; then
  cat >&2 <<'MSG'
✗ no deployer key — nothing was broadcast.

  Three steps to a real deployment:
    1. Fund a wallet at https://faucet.testnet.chain.robinhood.com          (testnet MON)
    2. cd contracts && cp .env.example .env               then set DEPLOYER_PRIVATE_KEY=0x…
    3. make deploy-robinhood                                  writes deployments/46630.json

  No key yet? `make deploy-dry-run` proves the wiring in-process and spends nothing.
MSG
  exit 1
fi

RPC="${ROBINHOOD_TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}"
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
  echo "✗ deployer has 0 MON. Fund it first: https://faucet.testnet.chain.robinhood.com (faucet)" >&2
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

# Fold forge's broadcast receipts in: the manifest gets the deploy tx hashes (what an
# explorer link or a judge actually needs), not just the addresses the script knows.
REPO_ROOT="$(cd .. && pwd)"
if [[ -f "broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json" ]]; then
  python3 "$REPO_ROOT/tools/merge_deploy_txs.py" --chain "$CHAIN_ID" || {
    echo "! tx hashes were not merged into the manifest — re-run: python3 tools/merge_deploy_txs.py --chain $CHAIN_ID" >&2
  }
else
  echo "! no broadcast record found for chain $CHAIN_ID — tx hashes not merged" >&2
fi

echo
# Liveness first (is it deployed and wired?), then source verification (is it readable?).
python3 "$REPO_ROOT/tools/verify_robinhood.py" --chain "$CHAIN_ID" || {
  echo "! liveness check failed — the addresses in deployments/$CHAIN_ID.json are not all live" >&2
  exit 1
}
echo
bash scripts/verify-robinhood.sh "$CHAIN_ID" || {
  echo "! source verification failed — the deploy succeeded, re-run: make verify-robinhood-explorer" >&2
  exit 1
}
