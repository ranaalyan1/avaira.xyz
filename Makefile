# Avaira — Monad-native accountability layer for the agent economy.
#
#   make install       install every dependency (contracts, SDK, services, python)
#   make test          run everything: Foundry suite + SDK tests + scorer tests
#   make deploy-monad  deploy the whole stack to Monad testnet and verify it
#   make gateway       start the API + dashboard on http://localhost:8402
#   make demo-heist    run "The Agent Heist" scenario end to end
#   make metrics       refresh metrics/ from real runs (gas, latency, coverage)
#
# Everything reads contracts/.env (see contracts/.env.example).

SHELL := /bin/bash
.DEFAULT_GOAL := help

PORT ?= 8402
CHAIN_ID ?= 10143

.PHONY: help install test test-contracts test-sdk test-scorer test-python \
        deploy-monad verify-monad benchmark gate-bench measure-monad metrics \
        gateway dashboard score leaderboard demo-heist demo-sybil demo-cvi anvil \
        perpl-provision perpl perpl-block perpl-test \
        smoke-kimi smoke-privy fmt clean legacy-dev

help:
	@grep -E '^#   ' Makefile | sed 's/^#   /  /'

install:
	@echo "→ contracts"
	cd contracts && (test -d node_modules || npm install --no-audit --no-fund)
	@echo "→ SDK (typescript)"
	cd sdk/typescript && npm install --no-audit --no-fund
	@echo "→ services"
	cd services/scorer && npm install --no-audit --no-fund
	cd services/gateway && npm install --no-audit --no-fund
	@echo "→ SDK (python)"
	python3 -m pip install -q -e sdk/python || pip install -q -e sdk/python
	@echo "✓ installed"

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
	python3 scripts/collect-metrics.py || true

# ── services ────────────────────────────────────────────────────────────────────

gateway:
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

# Cleanverse CVI/CVA compliance demo: fresh local anvil deploy + 5 scenarios
# (Travel-Rule gating, CVI_MISSING / CVI_EXPIRED reverts, CVI_UNVERIFIED gate block).
# LIVE=1 runs against Monad Testnet with OPERATOR_PRIVATE_KEY from the environment.
demo-cvi:
	./scripts/cvi-cva-demo.sh

# ── Perpl trading bot (Workstream 3) ─────────────────────────────────────────
# Every cycle is gated by avaira.run(). Provisioning registers/stakes/scores a
# fresh agent; `perpl` runs the loop; `perpl-block` records one intentionally
# blocked cycle; `perpl-test` runs the 19 unit tests. Requires anvil up (make anvil).
perpl-provision:
	cd services/perpl-bot && npm install --no-audit --no-fund \
		&& AVAIRA_DEPLOYMENT=../../deployments/$(CHAIN_ID).local.json AVAIRA_RPC_URL=http://127.0.0.1:8545 npm run provision

perpl:
	cd services/perpl-bot \
		&& AVAIRA_DEPLOYMENT=../../deployments/$(CHAIN_ID).local.json AVAIRA_RPC_URL=http://127.0.0.1:8545 npm start

perpl-block:
	cd services/perpl-bot \
		&& AVAIRA_DEPLOYMENT=../../deployments/$(CHAIN_ID).local.json AVAIRA_RPC_URL=http://127.0.0.1:8545 npm run demo:block

perpl-test:
	cd services/perpl-bot && npm test

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
