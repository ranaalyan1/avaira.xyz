# Avaira contracts — Monad-native accountability layer for the agent economy.
#
#   make build          compile
#   make test           run the Foundry suite (unit + fuzz + invariants)
#   make coverage       branch coverage report (requires a native solc)
#   make benchmark      measure gas for every primitive -> metrics/gas.json
#   make deploy-monad   deploy + verify the whole stack on Monad testnet
#   make verify-monad   re-run verification from deployments/{chainId}.json
#   make measure-monad  measure real gate latency against Monad -> metrics/
#   make gate-bench     same, against a local anvil chain (no faucet needed)
#
# `contracts/.env` is loaded automatically when present (see .env.example).

SHELL := /bin/bash
.DEFAULT_GOAL := help

RPC_TESTNET ?= https://testnet-rpc.monad.xyz
CHAIN_ID    ?= 10143

ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help build test test-ci snapshot coverage benchmark fmt lint clean \
        deploy-monad verify-monad measure-monad gate-bench anvil sizes

help:
	@grep -E '^#   ' Makefile | sed 's/^#   /  /'

build:
	forge build

sizes:
	forge build --sizes

test:
	forge test

# Heavier fuzz/invariant budget for CI.
test-ci:
	FOUNDRY_PROFILE=ci forge test

snapshot:
	forge snapshot

coverage:
	# Requires a native solc (svm). Coverage instrumentation + viaIR exceeds the
	# emscripten heap of the solc-js fallback shim.
	forge coverage --report summary --ir-minimum
	forge coverage --report lcov --ir-minimum

# Real gas per primitive, written to metrics/gas.json.
benchmark:
	forge test --match-contract GasBenchmark -vv

clean:
	forge clean

fmt:
	forge fmt

lint:
	forge lint

# ── Monad ───────────────────────────────────────────────────────────────────────

deploy-monad:
	bash scripts/deploy-monad.sh

verify-monad:
	bash scripts/verify-monad.sh $(CHAIN_ID)

measure-monad:
	bash scripts/measure-monad.sh $(RPC_TESTNET)

# Full-stack latency/throughput benchmark against a throwaway local chain.
gate-bench:
	bash scripts/gate-bench-local.sh

anvil:
	anvil --chain-id 10143 --block-time 0.4
