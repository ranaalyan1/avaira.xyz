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
NODE ?= node

# The fuzz matrix: seeds are fixed, so `make fuzz` on any machine reproduces the same report.
SEEDS ?= 20261007 991 4242 777
FUZZ_SEQUENCES ?= 500
FUZZ_DEPTH ?= 12
FUZZ_JOBS ?= 2
REPORTS := verification/reports

.PHONY: help install install-verification test test-contracts test-sdk test-scorer test-python \
        setup setup-dev setup-full setup-check quickstart console gateway \
        test-core \
        deploy-monad verify-monad benchmark gate-bench measure-monad \
        fmt clean legacy-dev \
        compile check redteam fuzz fuzz-quick parity demo demo-check specs doctor verify

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

install:
	@echo "→ verification toolchain (solc-js)"
	@cd tools && (test -d node_modules || npm install --no-audit --no-fund)
	@echo "→ contracts"
	cd contracts && (test -d node_modules || npm install --no-audit --no-fund)
	@echo "→ SDK (typescript)"
	cd sdk/typescript && npm install --no-audit --no-fund
	@echo "→ services"
	cd services/scorer && npm install --no-audit --no-fund
	@test -d services/gateway \
		&& (cd services/gateway && npm install --no-audit --no-fund) \
		|| echo "  ! services/gateway is not in this tree — 'make gateway' cannot work (STATE.md, SP-06)"
	@echo "→ SDK (python)"
	@$(PY) -m pip install -q -e sdk/python 2>/dev/null \
		|| $(PY) -m pip install -q --break-system-packages -e sdk/python 2>/dev/null \
		|| { echo "  ! could not install the Python SDK into this interpreter (PEP 668 managed env?)."; \
		     echo "    Use a virtualenv: python3 -m venv .venv && . .venv/bin/activate && make install"; exit 1; }
	@echo "→ verification harness"
	@$(MAKE) --no-print-directory install-verification
	@echo "✓ installed"

# Only needed for the EVM-backed targets (redteam / fuzz / parity / demo).
install-verification:
	@$(PY) -c "import web3, eth_tester" 2>/dev/null && echo "  ✓ eth-tester + web3 already present" \
		|| $(PY) -m pip install -q -r verification/requirements.txt --break-system-packages \
		|| $(PY) -m pip install -q -r verification/requirements.txt

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

# ── verification ─────────────────────────────────────────────────────────────────
#
# `tools/compile.mjs` runs solc-js directly, so the EVM harness works on a machine without
# Foundry. It honours the Foundry profile (via_ir, Cancun, optimizer) and writes a manifest the
# other tools read — see tools/README.md for why it exists.

compile:
	@$(NODE) tools/compile.mjs

# Everything CI runs except the campaign matrix (which is minutes-scale, not seconds).
check: test-sdk test-scorer compile redteam parity demo-check doctor
	@echo "✓ check green (run `make fuzz` for the campaign matrix)"

redteam: compile
	@mkdir -p $(REPORTS)
	$(PY) tools/avaira_evm/attacks.py --json $(REPORTS)/redteam.json

# Deterministic campaign matrix, one shard per seed. Reports are merged only if every shard ran the
# same bytecode — `aggregate_campaigns.py` refuses otherwise.
fuzz: compile
	@mkdir -p $(REPORTS)
	@printf '%s\n' $(SEEDS) | xargs -P $(FUZZ_JOBS) -I{} $(PY) tools/avaira_evm/campaign.py \
		--seed {} --sequences $(FUZZ_SEQUENCES) --depth $(FUZZ_DEPTH) --explain-reverts \
		--out $(REPORTS)/campaign-shard-{}.json --quiet
	$(PY) tools/aggregate_campaigns.py $(REPORTS)/campaign-shard-*.json \
		--out $(REPORTS)/campaign.json --title "campaign matrix"

# One seed, one minute: the pre-commit sanity run.
fuzz-quick: compile
	@mkdir -p $(REPORTS)
	$(PY) tools/avaira_evm/campaign.py --seed 7 --sequences 40 --depth 8 --explain-reverts \
		--out /tmp/avaira-campaign-quick.json

parity: compile
	@mkdir -p $(REPORTS)
	$(PY) tools/parity/compare.py --json $(REPORTS)/parity.json

specs: compile
	$(PY) tools/gen_contract_specs.py

demo: compile
	$(PY) tools/demo.py

# CI mode: the trace must match the committed golden file byte for byte.
demo-check: compile
	$(PY) tools/demo.py --check

doctor:
	$(PY) tools/doctor.py

verify: compile
	@$(MAKE) --no-print-directory test-sdk test-scorer
	@$(MAKE) --no-print-directory redteam
	@$(MAKE) --no-print-directory parity
	@$(MAKE) --no-print-directory demo-check
	@$(MAKE) --no-print-directory specs >/dev/null && git diff --quiet audit/specs || \
		{ echo "audit/specs changed — commit the regenerated specs"; exit 1; }
	@$(MAKE) --no-print-directory doctor
	@echo "✓ verify green"

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
