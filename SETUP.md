# Avaira setup — from clone to verified in one command

> **TL;DR**
> ```bash
> ./setup.sh
> ```
> ~7 seconds. No API keys, no wallet, no database, no Docker, no `sudo`.
> It creates a local `.venv`, installs the handful of small dependencies the
> core needs, then **proves the install works** by running the four
> deterministic proof artifacts and all 21 Cognitive OS tests.

---

## 1. Let your AI agent do it

Paste this into Claude Code, Codex, Cursor, Copilot, Windsurf, or any agent that
can run shell commands:

```
Set up the Avaira repo in this working directory for me.
1. Read AGENTS.md.
2. Run: ./setup.sh --yes --json
3. Confirm exit code 0 and "status":"ok", with 4/4 proof artifacts and 21/21 kernel tests passing.
4. Then run ./setup.sh --serve and give me the console URL.
Do not install anything else, do not ask me for API keys or a wallet,
and do not deploy contracts.
```

That is the whole onboarding. `AGENTS.md` contains the permission manifest, the
expected outputs, and the failure playbook, so the agent does not have to ask you
for keys, funds, or approval for each step. It is safe to authorize: the script
installs into `.venv/` and `node_modules/` inside the repo and never writes
secrets.

## 2. Or do it yourself — three levels

| Level | Command | Time (cold) | What you get |
| :--- | :--- | ---: | :--- |
| **Core** (default) | `./setup.sh` | **~7s** | `.venv` + pydantic/pytest/eth-utils, 4/4 proof artifacts, 21/21 kernel tests |
| **Developer** | `./setup.sh --dev` | ~11s | + TypeScript SDK tests, scorer tests, Python SDK tests |
| **Full** | `./setup.sh --full` | 1–4 min | + `contracts/.env` scaffold, `forge test`, frontend dependencies |
| **Full + Foundry** | `./setup.sh --full --with-foundry` | 2–6 min | same, installing Foundry if `forge` is missing |

Useful flags:

```bash
./setup.sh --check            # doctor: what is installed, what is missing — changes nothing
./setup.sh --json             # machine-readable result on stdout (agents, CI)
./setup.sh --serve            # set up, then serve the browser console on :8402
./setup.sh --offline          # never touch the network; reuse what is already installed
./setup.sh --port 9000        # different console port
```

Re-runs are cheap and idempotent: if `.venv` and dependencies already exist the
command finishes in under a second. Nothing is ever overwritten destructively —
your existing `contracts/.env` is left alone.

## 3. See it work in the browser

```bash
./setup.sh --serve
# → Quickstart Console on http://localhost:8402
```

The console probes the environment, then runs the two verification actions on
demand and streams the **real** transcripts:

- **Proof artifacts** — self-correction, ambiguity suspension, math-safety clamp to $95, and a pre-execution slash with an atomic 25% stake burn.
- **Kernel tests** — 21 tests across the five Cognitive OS pillars (kernel, memory tiers, interval prover, execution gate, ledger).

It is a stdlib-only server (`tools/quickstart/server.py`), it binds `0.0.0.0`,
and it can execute exactly those two fixed commands — nothing else, no
user-supplied arguments.

## 4. What setup creates

| Path | What it is | Delete with |
| :--- | :--- | :--- |
| `.venv/` | local Python environment (gitignored) | `rm -rf .venv` |
| `sdk/typescript/node_modules`, `services/scorer/node_modules` | npm deps for `--dev` | `rm -rf …/node_modules` |
| `frontend/node_modules` | npm deps for `--full` | `rm -rf frontend/node_modules` |
| `contracts/.env` | copy of `.env.example`, for `--full` only — fill it in before deploying | `rm contracts/.env` |
| `$HOME/.foundry` | only with `--with-foundry` | `rm -rf ~/.foundry` |

Nothing outside the repo is modified except `$HOME/.foundry` when you explicitly
ask for Foundry.

## 5. After setup — pick your path

### Guard a real agent (Python)

```bash
./setup.sh --dev          # installs the SDK into .venv
```

```python
from avaira import Avaira, RiskEnvelope

avaira = Avaira.from_deployment(chain_id=10143, private_key=os.environ["AGENT_PRIVATE_KEY"])

result = avaira.run(
    agent_id=1,
    task={"id": "treasury-rebalance"},
    execute_fn=lambda ctx: {"swapped": True},
    envelope=RiskEnvelope(max_spend_usd=20_000_000, allowed_actions=["dex.swap"]),
)

if result.status == "blocked":
    print(result.message)      # execute_fn never ran — that is the point
```

Full SDK surface: [`sdk/README.md`](sdk/README.md) and the
[README Quickstart](README.md#-sdk-quickstart).

### Run the Solidity suite

```bash
./setup.sh --full --with-foundry
```

`forge test` is local — it needs no faucet, no RPC and no funds. Deploying is the
only step that needs money, and only ever on request:

```bash
cast wallet new                     # generate a deployer key
# fund it at https://testnet.monad.xyz, then put the key in contracts/.env
make deploy-monad                   # deploys + wires all 6 contracts, writes deployments/10143.json
```

### Control plane (optional, and heavier)

The FastAPI control plane in `backend/` is intentionally **not** part of the fast
path — it needs MongoDB plus model-provider keys:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt       # ~1.5 GB, several minutes
cp backend/.env.example backend/.env          # then fill in MONGO_URL + provider keys
docker compose up -d mongo                    # or point MONGO_URL at your own cluster
uvicorn backend.server:app --port 8000
```

Skip it unless you specifically want the zero-trust execution shield API,
telemetry and simulation endpoints.

### Frontend dashboard (optional)

```bash
cd frontend && npm install && npm start       # http://localhost:3000, reads REACT_APP_BACKEND_URL
```

## 6. Troubleshooting

| Symptom | Cause / fix |
| :--- | :--- |
| `No Python >= 3.10 found` | `apt install python3 python3-venv` (Debian/Ubuntu) or `brew install python@3.12` |
| venv creation fails | missing `ensurepip`/`python3-venv`; setup falls back to the system interpreter automatically |
| pip or npm download failures | re-run; behind a closed network use `--offline` with pre-warmed deps |
| `ModuleNotFoundError: avaira_os` | run from the repo root — `setup.sh` must be run where it lives |
| A proof artifact fails | `./setup.sh --json` for the failing step; the script prints the last 20 log lines of the failed command |
| `forge: command not found` | `./setup.sh --full --with-foundry`, or install Foundry manually and re-run |
| Console not reachable from a container/sandbox | it already binds `0.0.0.0`; expose/forward port 8402 |

Still stuck? `./setup.sh --check` prints a one-screen environment report you can
paste into an issue: <https://github.com/ranaalyan1/avaira.xyz/issues>.

## 7. What "verified" means

`setup.sh` does not print "done" because a command exited 0. It asserts the
**content** of the run:

1. `python -m avaira_os.demos` must print all four `[PASS]` lines and end with
   `all proof artifacts: PASS`.
2. `pytest tests/test_cognitive_os.py` must report passing tests and zero
   failures (21 passed expected; `eth-utils` is installed precisely so the keccak
   selector cross-check does not skip).

Anything less exits non-zero and prints the failing command's output. That is why
the same script is safe for CI, for your laptop, and for an AI agent.
