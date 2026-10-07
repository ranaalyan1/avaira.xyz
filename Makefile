# Avaira — Monad-native accountability layer for the agent economy.
#
#   make install       install every dependency (contracts, SDK, services, python)
#   make test          run everything: Foundry suite + SDK tests + scorer tests
#   make deploy-monad  deploy the whole stack to Monad testnet and verify it
#   make gateway       start the API + dashboard on http://localhost:8402
#   make demo-heist    run "The Agent Heist" scenario end to end
#   make metrics       refresh metrics/ from real runs (gas, latency, coverage)
#
#   make check         everything CI runs except the slow campaign matrix
#   make redteam       attack scenarios against the compiled bytecode (needs an EVM harness)
#   make fuzz          deterministic campaign matrix over SEEDS, then aggregated
#   make parity        cross-language canonical-encoding parity (Python / TypeScript / on-chain)
#   make demo          deterministic end-to-end lifecycle trace (+ --check in CI)
#   make specs         regenerate audit/specs from the build
#   make doctor        repo self-consistency: claims vs checks
#   make verify        compile + check + redteam + parity + demo + doctor
#
# Everything reads contracts/.env (see contracts/.env.example).

SHELL := /bin/bash
.DEFAULT_GOAL := help

PORT ?= 8402
CHAIN_ID ?= 10143
PY ?= python3
NODE ?= node

# The fuzz matrix: seeds are fixed, so `make fuzz` on any machine reproduces the same report.
SEEDS ?= 20261007 991 4242 777
FUZZ_SEQUENCES ?= 500
FUZZ_DEPTH ?= 12
FUZZ_JOBS ?= 2
REPORTS := verification/reports

.PHONY: help install install-verification test test-contracts test-sdk test-scorer test-python \
        deploy-monad verify-monad benchmark gate-bench measure-monad metrics \
        gateway dashboard score leaderboard demo-heist demo-sybil anvil \
        smoke-kimi smoke-privy fmt clean legacy-dev \
        compile check redteam fuzz fuzz-quick parity demo demo-check specs doctor verify

help:
	@grep -E '^#   ' Makefile | sed 's/^#   /  /'

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

test: test-contracts test-sdk test-scorer
	@echo "✓ all suites green"

test-contracts:
	cd contracts && forge test

test-sdk:
	cd sdk/typescript && npm run typecheck && npm test

test-scorer:
	cd services/scorer && npm run typecheck && npm test

test-python:
	cd sdk/python && python3 -m pytest -q

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

# The same benchmark against a throwaway local chain — no faucet, no funds.
gate-bench:
	cd demo && ./bench-local.sh

# Refresh metrics/ from real runs.
metrics:
	cd contracts && make benchmark
	cd sdk/typescript && npm run benchmark -- --chain $(CHAIN_ID) --runs $${RUNS:-50} --out ../../metrics/gate-latency.json || true
	$(PY) scripts/collect-metrics.py || true

# ── services ────────────────────────────────────────────────────────────────────

gateway:
	@test -d services/gateway || { echo "services/gateway does not exist in this repository — see STATE.md (open items) / SCOPE_PROPOSALS.md SP-06"; exit 1; }
	cd services/gateway && PORT=$(PORT) npm start

# Alias: the dashboard is served by the gateway at /.
dashboard: gateway

score:
	cd services/scorer && npm run score -- --agent $${AGENT:-1} --anchor

leaderboard:
	cd services/scorer && npm run leaderboard

demo-heist:
	cd demo && ./heist.sh

demo-sybil:
	cd demo && ./sybil.sh

anvil:
	anvil --chain-id $(CHAIN_ID) --block-time 0.4

# ── sponsor smoke tests (require real credentials) ──────────────────────────────

smoke-kimi:
	cd services/scorer && npm run smoke:kimi

smoke-privy:
	cd services/gateway && npm run smoke:privy

# ── housekeeping ────────────────────────────────────────────────────────────────

fmt:
	cd contracts && forge fmt
	cd sdk/typescript && npx prettier --write 'src/**/*.ts' 'test/**/*.ts' 2>/dev/null || true

clean:
	cd contracts && forge clean
	rm -rf sdk/typescript/dist services/*/dist

# The pre-Monad offchain product is still runnable; it is not part of the v2 path.
legacy-dev:
	docker-compose up
