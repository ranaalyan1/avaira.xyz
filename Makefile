# Avaira — Monad-native accountability layer for the agent economy.
#
#   make                 show this help
#   make setup           one-command setup + verification of the core (~7s, no keys)
#   make setup-dev       + SDKs and scorer
#   make setup-full      + contracts (Foundry) and frontend deps
#   make console         browser Quickstart Console on http://localhost:8402
#   make test            run every suite that is installed locally
#   make demo            the 4 deterministic proof artifacts (Cognitive OS)
#   make deploy-monad    deploy the 6-contract stack to Monad testnet (needs funds)
#
# `make setup` is the recommended entry point; it wraps ./setup.sh, which is
# idempotent and safe to re-run. Everything chain-related reads contracts/.env
# (see contracts/.env.example).

SHELL := /bin/bash
.DEFAULT_GOAL := help

PORT ?= 8402
CHAIN_ID ?= 10143
# Absolute so recipes that `cd` into a subdirectory still find the venv.
VENV_PY := $(shell test -x .venv/bin/python && echo $(CURDIR)/.venv/bin/python || echo python3)
PY := $(VENV_PY)

.PHONY: help setup setup-dev setup-full setup-check console gateway demo test \
        test-core test-contracts test-sdk test-scorer test-python \
        deploy-monad verify-monad benchmark measure-monad fmt clean legacy-dev

help:
	@grep -E '^#   ' Makefile | sed 's/^#   /  /'

# ── setup ───────────────────────────────────────────────────────────────────────

setup: quickstart
quickstart:
	./setup.sh --yes

setup-dev:
	./setup.sh --dev --yes

setup-full:
	./setup.sh --full --yes

setup-check:
	./setup.sh --check

# Alias kept for older docs: the old `services/gateway` was never committed, the
# working local service is the Quickstart Console.
gateway: console

console:
	./setup.sh --serve --port $(PORT)

demo:
	$(PY) -m avaira_os.demos

# ── tests ───────────────────────────────────────────────────────────────────────

# Runs the fast core suite first (works with zero configuration), then every
# optional suite whose toolchain is actually present.
test: test-core
	@if command -v forge >/dev/null 2>&1; then $(MAKE) test-contracts; \
	else echo "  · skipping contracts — forge not installed (make setup-full --with-foundry)"; fi
	@if command -v npm >/dev/null 2>&1 && [ -d sdk/typescript/node_modules ]; then \
	$(MAKE) test-sdk; else echo "  · skipping TS SDK — run make setup-dev"; fi
	@if command -v npm >/dev/null 2>&1 && [ -d services/scorer/node_modules ]; then \
	$(MAKE) test-scorer; else echo "  · skipping scorer — run make setup-dev"; fi
	@if [ -d sdk/python ]; then $(MAKE) test-python; fi
	@echo "✓ every installed suite is green"

test-core:
	$(PY) -m pytest tests/test_cognitive_os.py -q
	$(PY) -m avaira_os.demos >/dev/null && echo "✓ 4/4 proof artifacts PASS"

test-contracts:
	@command -v forge >/dev/null 2>&1 || { echo "forge not installed — run: ./setup.sh --full --with-foundry"; exit 1; }
	cd contracts && forge test

test-sdk:
	cd sdk/typescript && npm run typecheck && npm test

test-scorer:
	cd services/scorer && npm run typecheck && npm test

test-python:
	cd sdk/python && $(PY) -m pytest -q

# ── Monad ───────────────────────────────────────────────────────────────────────

deploy-monad:
	cd contracts && make deploy-monad

verify-monad:
	cd contracts && make verify-monad CHAIN_ID=$(CHAIN_ID)

# Real gas for every primitive (execution gas, identical on Monad).
benchmark:
	cd contracts && make benchmark

# Live gate latency against Monad: commit → checkGate → execute round trip.
measure-monad:
	cd sdk/typescript && npm run benchmark -- --rpc $${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz} --chain $(CHAIN_ID) --runs $${RUNS:-50}

# Same benchmark against a throwaway local chain — no faucet, no funds.
gate-bench:
	@if [ -d demo ]; then cd demo && ./bench-local.sh; \
	else echo "local gate benchmark is unavailable in this checkout"; fi

# ── housekeeping ────────────────────────────────────────────────────────────────

fmt:
	cd contracts && forge fmt
	cd sdk/typescript && npx prettier --write 'src/**/*.ts' 'test/**/*.ts' 2>/dev/null || true

clean:
	cd contracts && forge clean 2>/dev/null || true
	rm -rf sdk/typescript/dist services/*/dist

# The pre-Monad offchain product is still runnable; it is not part of the v2 path.
legacy-dev:
	docker-compose up
