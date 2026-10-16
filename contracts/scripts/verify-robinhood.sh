#!/usr/bin/env bash
# Avaira — verify every deployed contract on Robinhood.
#
#   contracts/scripts/verify-robinhood.sh [chainId]
#
# Reads deployments/{chainId}.json (written by Deploy.s.sol) and verifies each contract
# with the correct constructor arguments. Robinhood has two public verification paths and we
# try both: Sourcify (keyless, always available) and RobinhoodScan/Blockscout (human-friendly
# UI, needs no key either but rate-limits).
set -euo pipefail

cd "$(dirname "$0")/.."
source .env 2>/dev/null || true

CHAIN_ID="${1:-46630}"
MANIFEST="deployments/${CHAIN_ID}.json"
[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — run make deploy-robinhood first" >&2; exit 1; }

case "$CHAIN_ID" in
  46630)
    RPC_URL="${ROBINHOOD_TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}"
    EXPLORER="https://explorer.testnet.chain.robinhood.com"
    SOURCIFY="https://sourcify-api-robinhood.blockvision.org/"
    BLOCKSCOUT="https://explorer.testnet.chain.robinhood.com/api"
    ;;
  4663)
    RPC_URL="${ROBINHOOD_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
    EXPLORER="https://robinhoodchain.blockscout.com"
    SOURCIFY="https://sourcify-api-robinhood.blockvision.org/"
    BLOCKSCOUT="https://robinhoodchain.blockscout.com/api"
    ;;
  *)
    echo "unknown chain id $CHAIN_ID" >&2; exit 1 ;;
esac

j() { jq -r "$1" "$MANIFEST"; }

IDENTITY=$(j .identityRegistry)
REPUTATION=$(j .reputationRegistry)
VALIDATION=$(j .validationRegistry)
STAKE=$(j .stakeRegistry)
VAULT=$(j .intentVault)
MARKET=$(j .creditMarket)
USDC=$(j .settlementToken)
ADMIN=$(j .admin)
BOND=$(j .registrationBond)
MIN_STAKE=$(j .minStake)
MIN_SCORE=$(j .minScore)
WINDOW=$(j .challengeWindow)

encode() { cast abi-encode "$1" "${@:2}" | cut -c3-; }

verify() {
  local name="$1" address="$2" args="$3" label="$4"
  echo "── verifying $name at $address"
  echo "   explorer: $EXPLORER/address/$address"

  local ok=0
  if forge verify-contract "$address" "src/$(path_for "$name")" \
      --chain "$CHAIN_ID" --verifier sourcify --verifier-url "$SOURCIFY" \
      --constructor-args "$args" >/tmp/verify-$name.log 2>&1; then
    echo "   ✓ verified on Sourcify (keyless)"
    ok=1
  else
    echo "   · Sourcify: $(tail -2 /tmp/verify-$name.log | tr '\n' ' ')"
  fi

  if [ "$ok" = 0 ]; then
    if forge verify-contract "$address" "src/core/$name.sol:$name" \
        --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$BLOCKSCOUT" \
        --constructor-args "$args" >/tmp/verify-$name.log 2>&1; then
      echo "   ✓ verified on RobinhoodScan (Blockscout)"
      ok=1
    else
      echo "   ✗ RobinhoodScan: $(tail -2 /tmp/verify-$name.log | tr '\n' ' ')"
    fi
  fi

  [ "$ok" = 1 ] || echo "   ! $name left unverified — see /tmp/verify-$name.log"
}

path_for() {
  case "$1" in
    MockUSDC) echo "tokens/MockUSDC.sol:MockUSDC" ;;
    *) echo "core/$1.sol:$1" ;;
  esac
}

verify AvairaIdentityRegistry   "$IDENTITY"   "$(encode 'constructor(uint256,address)' "$BOND" "$ADMIN")"            "identity"
verify AvairaReputationRegistry "$REPUTATION" "$(encode 'constructor(address,address,address,address)' "$IDENTITY" "$(cast address-zero)" "$USDC" "$ADMIN")" "reputation"
verify AvairaValidationRegistry "$VALIDATION" "$(encode 'constructor(address,address)' "$IDENTITY" "$ADMIN")"          "validation"
verify AvairaStakeRegistry      "$STAKE"      "$(encode 'constructor(address,address,address,uint256,uint8,address)' "$USDC" "$IDENTITY" "$REPUTATION" "$MIN_STAKE" "$MIN_SCORE" "$ADMIN")" "stake"
verify AvairaIntentVault        "$VAULT"      "$(encode 'constructor(address,address,address,uint64,address)' "$IDENTITY" "$STAKE" "$USDC" "$WINDOW" "$ADMIN")" "vault"
verify AvairaCreditMarket       "$MARKET"     "$(encode 'constructor(address,address,address,address)' "$USDC" "$STAKE" "$IDENTITY" "$ADMIN")" "market"
verify MockUSDC                 "$USDC"       "" "usdc"

echo
echo "all addresses:"
jq . "$MANIFEST"
