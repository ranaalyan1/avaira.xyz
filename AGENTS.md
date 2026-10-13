# AGENTS.md — how an AI coding agent sets up Avaira

You are pointed at the Avaira repository. **You can set it up yourself.** It takes
about 7 seconds, needs no credentials, and ends with a self-verifying proof run.
Read this file, run the commands, report the result. Do not invent extra steps.

---

## 1. The one command

```bash
./setup.sh --yes --json
```

`--yes` means "do not prompt me". `--json` prints a machine-readable result on
**stdout** while all human progress goes to **stderr**, so you can capture and
parse it:

```json
{"status":"ok","mode":"fast","elapsedSeconds":7,"python":".venv (Python 3.11.2)",
 "venv":".../avaira.xyz/.venv/bin/python","port":8402,
 "steps":[{"name":"python","status":"ok","detail":".venv (Python 3.11.2)"},
          {"name":"deps","status":"ok","detail":"pydantic + pytest + eth-utils"},
          {"name":"proof-artifacts","status":"ok","detail":"4/4 PASS"},
          {"name":"kernel-tests","status":"ok","detail":"21 passed in 0.15s"}]}
```

**Success = exit code 0 and `"status":"ok"`.** Anything else: go to §6.

## 2. What you are allowed to do (permission manifest)

| Allowed without asking | Notes |
| :--- | :--- |
| Create `.venv/` in the repo root and pip-install into it | pydantic, pytest, eth-utils, and in `--dev` the SDK's own deps |
| `npm install` in `sdk/typescript`, `services/scorer`, `frontend` | only with `--dev` / `--full` |
| Run the local test suites and the proof artifacts | pure CPU, offline-capable, no external calls |
| Write `contracts/.env` **as a copy of** `contracts/.env.example` | `--full` only; never overwrite an existing one |
| Start the local console on port 8402 via `./setup.sh --serve` | binds `0.0.0.0`, safe behind sandbox proxies |

| Never required, never ask the user for it | |
| :--- | :--- |
| API keys of any kind (OpenAI, Anthropic, Kimi, Privy, Monadscan) | the verified path uses none |
| A wallet, private key, seed phrase or faucet funds | deploying to Monad is a separate, explicitly-requested step |
| `sudo`, root, or system-wide installs | everything lands in the repo or `$HOME/.foundry` |
| A database, Mongo, Redis, Docker, or a running backend | the core is offline and dependency-light |

Network is used **only** for `pip`/`npm` package downloads (and, when you pass
`--with-foundry`, the Foundry installer). With `--offline`, nothing is fetched
and pre-installed dependencies are reused.

## 3. Levels — pick the smallest one that answers the user's request

| Command | Time (cold) | What it proves |
| :--- | ---: | :--- |
| `./setup.sh --yes` | ~7s | Cognitive OS runs: 4/4 proof artifacts, 21/21 kernel tests |
| `./setup.sh --dev --yes` | ~11s | + TypeScript SDK tests, scorer tests, Python SDK tests |
| `./setup.sh --full --yes` | 1–4 min | + `contracts/.env` scaffold, `forge test` (Foundry suite), frontend deps |
| `./setup.sh --full --with-foundry --yes` | 2–6 min | same, and installs Foundry first if `forge` is missing |
| `./setup.sh --check` | <1s | doctor only: environment report, changes nothing |

Do not run `--full` unless the user asked for contracts or the frontend — it is
minutes and hundreds of MB.

## 4. Verify, then report

After `./setup.sh --yes`, confirm both lines appear (they are the acceptance
criteria, and the script already fails with exit 1 if they do not):

```
✓ proof artifacts: 4/4 PASS (self-correction, ambiguity, math-safety clamp, slash)
✓ kernel tests: 21 passed
```

If the user wants to *see* it, run `./setup.sh --serve` and tell them the
console is live on port 8402. It runs the same two checks from the browser and
streams the real transcripts. In a sandbox preview, expose port 8402.

## 5. Boundaries

- Never commit `.env`, `.venv/`, `node_modules/`, or `deployments/*.json` you generated.
- Never run `make deploy-monad`, `forge script ... --broadcast`, or anything that
  signs a transaction unless the user explicitly asked to deploy and supplied a
  funded key.
- Never edit `contracts/.env.example` or write real secrets into a committed file.
- The `backend/` control plane is deliberately out of the fast path: it needs
  MongoDB plus model-provider keys. Skip it unless the user asks; `SETUP.md`
  documents it.
- Prefer `./setup.sh` over hand-rolled `pip install`/`npm install` sequences —
  it is idempotent, fast on re-runs, and reports structured results.

## 6. If it fails

| Symptom | Fix |
| :--- | :--- |
| `No Python >= 3.10 found` | install one (`apt install python3-venv` / `brew install python@3.12`), re-run |
| venv creation fails (no `ensurepip`) | re-run — the script falls back to the system interpreter, or install `python3-venv` |
| pip/npm download errors | re-run; if the network is closed, use `--offline` with pre-warmed deps |
| `ModuleNotFoundError: avaira_os` | run from the repo root (`cd` to where `setup.sh` lives) |
| proof artifacts do not all PASS | `./setup.sh --json` for the failing step, then `/tmp/avaira-setup.*` tail printed by the script |
| Foundry tests want funds | they do not — `forge test` is local-only. Only `make deploy-monad` needs MON |

Expand the failing step verbatim and paste the last 20 lines of output rather
than paraphrasing it.

## 7. What is in this repo (orientation)

- `avaira_os/` — Cognitive OS v5.0 kernel: PLAN → PROVE → SIMULATE → EXECUTE. **No deps beyond pydantic.**
- `contracts/` — 6 Solidity contracts for Monad + ERC-8004 (Foundry).
- `sdk/typescript`, `sdk/python`, `services/scorer` — client SDKs and the 0–100 Avaira Score engine.
- `tools/quickstart/server.py` — the stdlib Quickstart Console used by `--serve`.
- `SETUP.md` — the same information written for humans, plus the advanced paths.
