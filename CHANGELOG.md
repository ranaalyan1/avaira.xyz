# CHANGELOG

## [Unreleased]

### Added
- **`setup.sh` — one-command, self-verifying setup.** `./setup.sh` takes a clean
  clone to a *proven* state in ~7s with no keys, no wallet, no database and no
  `sudo`: it creates `.venv`, installs the handful of small core dependencies,
  then asserts `4/4` proof artifacts and `21/21` Cognitive OS tests. Levels:
  `--dev` (SDKs + scorer), `--full` (contracts + frontend), `--with-foundry`,
  plus `--check` (doctor), `--json` (structured result on stdout), `--offline`,
  `--serve`.
- **`AGENTS.md`** — an agent-facing setup contract: permission manifest (what may
  be installed, and the explicit never-needed list), expected outputs, boundaries
  and a failure playbook, so an AI agent can onboard the repo unattended.
- **`SETUP.md`** — the human guide: levels and timings, flags, what gets created
  and how to undo it, the optional control plane, and a troubleshooting table.
- **`tools/quickstart/server.py`** — zero-dependency browser Quickstart Console
  (`./setup.sh --serve`): probes the environment and streams real transcripts of
  the proof artifacts and kernel tests. Binds `0.0.0.0` for sandbox previews; it
  can execute exactly those two fixed commands.
- **`.devcontainer/`** — Codespaces/devcontainer that runs `./setup.sh` on create.
- **`llms.txt`** — machine-readable index of the repository for AI tooling.
- **CI: `quickstart` job** — runs `./setup.sh --yes --json` on Ubuntu and macOS,
  asserts the structured result, then boots the console and hits its endpoints, so
  the onboarding path cannot silently rot.

### Changed
- **`Makefile`** — `make setup` / `setup-dev` / `setup-full` / `setup-check` /
  `console` / `demo` now wrap `setup.sh`; `make test` runs the zero-config core
  suite first and skips (with a hint) any optional suite whose toolchain is
  missing instead of failing. `make gateway` is now an alias for the working
  console, and dead references to the uncommitted `services/gateway`, `demo/`
  and `scripts/` directories were removed.
- **README Quickstart** now leads with the one-command path and the paste-into-
  your-agent prompt; deployment moved to an explicit second step.
- The keccak selector cross-check in `tests/test_cognitive_os.py` no longer
  silently skips when `eth-utils` is present without a hash backend — `setup.sh`
  installs `eth-utils` + `eth-hash[pycryptodome]`, so the full 21 tests run.


## [5.0.0] — Cognitive OS: Hardened Execution Layer

### Added
- **`avaira_os/` package** — a deterministic, offline Cognitive Kernel where
  safety is mathematically proven before execution:
  - Pillar A `kernel.py` / `reasoning.py`: Global Working Memory (7±2 slots,
    activation decay, protected Goal Chunk), priority-based production rules
    (priority ≥ 9 → `InterruptSignal`), System-2 planner requiring a complete
    `ReasoningTrace` (Decomposition → Risk Analysis → Alternatives → Decision).
  - Pillar B `memory_tiers.py`: three-tier hierarchy — L1 working set, L2
    episodic store with TF-IDF retrieval, L3 belief graph. `SelfEditingMemory`
    rejects L3 writes without a verification artifact; belief reversals
    require strictly higher confidence or two independent artifacts.
  - Pillar C `world_model.py`: interval-arithmetic `SymbolicProver` with
    strict `SAFE` / `UNSAFE` (witness counterexample) / `UNKNOWN`
    (fail-closed) verdicts, plus a seeded 200× Monte-Carlo `ShadowSandbox`.
  - Pillar D `execution_gate.py`: strict boolean `ExecutionGate` (hardware
    attestation + signature-valid SAFE certificate + envelope compliance),
    atomic `LocalLedgerSlashing`, and `EVMFreezeSlashAdapter` rendering
    `freezeAndSlash(address,uint256,string)` settlements.
  - Pillar E `agent_os.py` / `events.py`: the PLAN → PROVE → SIMULATE →
    EXECUTE DCG loop with critique back-edges, `AWAIT_INPUT` suspension, and
    a tamper-evident hash-chained Cognitive Ledger.
- **Four deterministic Proof Artifacts** (`python -m avaira_os.demos`):
  self-correction, ambiguity suspension/resume, math-safety clamp to $95,
  and forced-violation slash with atomic stake burn.
- **21 new tests** (`tests/test_cognitive_os.py`) covering all five pillars.
- `docs/cognitive-os-v5.md` — architecture and verification-chain reference.
