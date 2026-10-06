# Avaira deep audit — 2026-10

Full-repository audit (contracts, backend, cognitive OS kernel, SDKs, services) looking for
vulnerabilities, bugs and errors — and fixing them. Every finding below was **reproduced**
before it was fixed; nothing is listed on the strength of reading alone.

## Method

| Layer | How it was verified |
| --- | --- |
| Solidity | No Foundry in the audit sandbox (release hosts blocked), so the contracts were compiled with the repo's pinned solc 0.8.37 and executed against real bytecode with `@ethereumjs/vm` (Cancun, viaIR, optimizer 200). Findings were proven with an 12-check behavioural harness; regression tests for CI were added in `contracts/test/AvairaAuditRegressions.t.sol`. |
| Backend / kernel | Probe scripts that flip from `VULNERABLE` to `safe` (see below), plus `pytest`: 103 → **143 passing** offline tests in this repo. New suites: `tests/test_audit_security.py` (40 tests), `tests/test_merkle_parity.py` (14 tests). |
| Cross-language claims | The Python SDK's Merkle commitment is now pinned to the same vectors the TypeScript SDK generates and the Foundry suite asserts. |
| CI | `forge test` (Contracts), the Backend job (now including both new suites), the Cognitive OS determinism job and the Quickstart job remain the oracles. |

Reproduction commands:

```bash
# contracts (behavioural proof, post-fix: 12/12)
cd /tmp/audit && node harness.js --strict

# every backend/kernel probe flips VULNERABLE -> safe
.venv/bin/python /tmp/audit/prefix_evidence.py

# the offline test suites
.venv/bin/python -m pytest tests/test_audit_security.py tests/test_merkle_parity.py \
    tests/test_backend_units.py tests/test_v2_core.py tests/test_cognitive_os.py \
    tests/test_e2e_mocked.py tests/test_advanced_modules.py tests/test_intent_logger.py \
    tests/test_sdk_basic.py -q
```

## Summary

| # | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| A2/A3 | **High** | Contracts | A BAN recorded at the identity registry did not make `isEligible()` false and did not close `IntentVault.checkGate` — a permanently banned agent kept passing the pre-execution gate | Fixed |
| B3 | **High** | Contracts | `AvairaCreditMarket.borrow` only refused BAN, so suspended or under-staked agents kept drawing new credit | Fixed |
| 1 | **High** | Backend | `POST /executions/request` was unauthenticated: one anonymous request froze any agent (−20 reputation) — remote freeze/DoS | Fixed |
| 2 | **High** | Backend | `permit.verify_permit` accepted the agent's own address as signer — agents could self-issue the protocol's co-signature | Fixed |
| 3 | **High** | Backend | Witness quorum keys were `sha256(witness_id)` (public) — anyone could forge a unanimous quorum | Fixed |
| 4 | **High** | Backend | `ZKAuditVault.verify_compliance_proof` returned the caller-supplied `verifiable` flag — every proof was valid by construction | Fixed |
| 5 | **High** | Backend | `AgentVault.execute_payment` ignored the card, its limit and the merchant whitelist (hard-coded $10, never called the PSP) | Fixed |
| 6 | **High** | Kernel | Safety certificates / TEE attestations were signed with a repository literal | Fixed |
| 7 | **High** | Backend | Audit-log AES key and agent signing keys defaulted to a repository literal | Fixed |
| 8 | Medium | Backend | `TEEIdentityManager` attestation used a shipped literal as the HMAC key | Fixed |
| 9 | Medium | Backend | `POST /missions/{id}/stake` was unauthenticated and moved underwriter capital (non-atomic read-then-write allowed double-commit) | Fixed |
| 10 | Medium | Backend | `POST /missions/create` accepted anonymous missions for any agent | Fixed |
| 11 | Medium | Backend | OAuth `state` was signed but never single-use and not bound to the browser → login CSRF / replay | Fixed |
| 12 | Medium | Contracts | Collateral had no exit: once deposited it could only leave via liquidation | Fixed |
| 13 | Medium | Backend | `/agent/think`, `/agent/simulate-full-lifecycle`, `/appeal/{slash_id}` were anonymous mutating/AI endpoints | Fixed |
| 14 | Medium | Backend | `validator.verify_outcome` returned `True` unconditionally ("Simplified for now") | Fixed |
| 15 | Medium | Backend | `agent_runtime.validate` ignored `max_spend_usd`, so an envelope could be spent past its own cap | Fixed |
| 16 | Medium | Backend `/validate` | Anonymous endpoint fanning out to a paid model at 30 req/min | Hardened |
| 17 | Low | Contracts | `withdraw()` reverted when the refund push kept failing, permanently locking escrow | Fixed |
| 18 | Low | Contracts | `setEnforcer(address(0))` silently disabled ban propagation | Fixed |
| 19 | Low | Contracts | Unbounded feedback values + truncating `int128(...)` cast corrupted `getSummary` | Fixed |
| 20 | Low | Contracts | `slashAgent` could underflow `accountStake` and revert the punishment | Fixed |
| 21 | Low | Backend | Admin key compared with `!=` instead of constant time | Fixed |
| 22 | Low | Backend | `register_agent` used a bare `except:` (BaseException swallowed, agents attributed to `system`) | Fixed |
| 23 | Low | Backend | `slash_engine` built an Anthropic client at import time | Fixed |
| 24 | Low | Backend | Permits reused a nonce that was never persisted; the nonce index was unique on `agent_id` alone and never queried | Fixed |
| 25 | **High** | Docs/SDK | `sdk/python/avaira/audit.py` documented `tests/test_merkle_parity.py`, which did not exist — Python byte-compatibility was never checked | Fixed (test added) |

Severity is assigned by impact on the protocol's own guarantees (gating, slashing, capital,
audit integrity), not by exploit difficulty.

---

## Detail

### Contracts

**A2/A3 — terminal bans were not terminal.** `AvairaIdentityRegistry.banAgent` (owner or
enforcer) set the ban only in the identity registry, while `AvairaStakeRegistry.isEligible`
and `AvairaIntentVault.checkGate` read the stake registry's mirrored status. Harness before:
`isBanned=true, isEligible=true, checkGate allowed=true`. After: `isEligible=false`,
`checkGate` returns `GateReason.BANNED`, `stake`/`unstake`/`attestOutcome` also refuse.
Fix: `_isIdentityBanned()` staticcall helper in both contracts
(`AvairaIntentVault.sol:193`, `AvairaStakeRegistry.sol:256`).

**B3 — frozen agents could borrow.** `borrow` checked only `BANNED`. A SUSPENDED (slash
ladder level 2) or under-staked agent could still draw debt against a frozen reputation,
contradicting the documented "Borrowing Frozen" state. Fix: `borrow` requires
`AgentStatus.ACTIVE` (`AvairaCreditMarket.sol:155`).

**12 — collateral had no exit.** There was no way to withdraw collateral, so the only exit
was liquidation. Added `withdrawCollateral` (`AvairaCreditMarket.sol:126`) preserving the
borrow invariant (`remaining ≥ debt × tierRatioBps`). Harness E1–E4 prove both directions:
the margin cannot leave while debt is live, the free margin can, and a full round trip is
net-zero.

**17/18 — escrow lock and enforcer footgun.** `withdraw()` now re-escrows when the push
fails instead of reverting (funds stay claimable), and `setEnforcer(0)` is rejected.

**19/20 — reputation arithmetic.** Feedback values were unbounded and `getSummary` narrowed
with `int128(...)`, which *truncates* rather than reverting; one extreme review could poison
every future summary read. Values are now bounded (`1e20`, chosen so the 18-decimal
normalisation stays inside `int128`) and the narrowing cast is clamped. `slashAgent` clamps
`accountStake` instead of underflowing (an underflow reverted the slash — escaping
punishment).

### Backend

**1 — remote freeze via anonymous execution request.** `create_execution_request` had no
authentication. Posting a value outside the envelope froze the agent and docked 20
reputation. Fix: new `require_agent_access` (`server.py:799`) — the agent's
`X-Avaira-API-Key` or the signed-in owner; plus rate limiting. Same rule applied to
`/appeal/{slash_id}`, `/missions/create`; `/agent/think` and
`/agent/simulate-full-lifecycle` now require a session and stamp agent ownership.

**2/24 — permits.** `verify_permit` accepted `{agent, protocol_signer}` as accepted signers:
any agent could self-issue the co-signature. It now requires the protocol signer, binds the
permit to the agent it is presented for, enforces the deadline and rejects malformed input
instead of raising. Replay protection added via `PermitNonceRegistry` (unique
`(agent_id, nonce)` index — the previous index was unique on `agent_id` alone and never
queried), and simulation permits now persist the nonce they were issued with.

**3/4/5/7/8 — shared default secrets.** `AVAIRA_LOG_SECRET`, the witness seed, the ZK secret
and `TEE_SECRET` all fell back to literals in this repository, so audit logs could be
decrypted and agent signatures, witness quorums, ZK verdicts and TEE attestations forged by
anyone who read the source. New `backend/core/secret_store.py`: environment variable →
per-installation file (`~/.avaira`, 0600) → hard error; no shared default. On top of that:
witness keys derive from the installation seed by HMAC; ZK proofs are keyed commitments that
verification *recomputes*; TEE attestations are HMACs with constant-time comparison; the
vault enforces card status, card limit, cumulative spend, merchant whitelist and amount
sanity (`agent_vault.py`). All simulated components now say so (`simulated` flags).

**9/10 — missions and underwriting.** `POST /missions/{id}/stake` moved underwriter capital
with no authentication and a read-then-write balance check (two interleaved requests could
commit the same capacity twice). It now requires the owner, validates a positive amount and
uses a conditional `capital_available >= amount` update. `POST /missions/create` requires
the agent's operator. Underwriters record their owner at registration.

**11 — OAuth login CSRF / replay.** State was signed with the permit secret, never
single-use, and not bound to the browser: a captured callback URL could log a victim into
the attacker's account, and a state could be replayed for 10 minutes. Now: dedicated state
key, a short-lived `oauth_state_<provider>` cookie that must match the state nonce,
single-use consumption backed by a unique index (`db.oauth_states`), and the cookie cleared
on completion (`server.py:481–515`, `640`, `711`).

**14/15 — verification stubs.** `validator.verify_outcome` returned `True` for everything; it
now compares action, target and spend against the intent and envelope. `agent_runtime.validate`
checked `max_tx_value` but not `max_spend_usd`; both caps now bind (the tighter wins).

**16 — paid endpoint budget.** `/validate` keeps its public SDK path but anonymous callers
get 10 req/min and API-key callers 60 req/min.

### Kernel (`avaira_os`)

**6 — safety certificates signed with a repository literal.** `ExecutionGate` and
`AttestationService` defaulted to `"avaira-v5-hardware-root-of-trust"`, so anyone could mint
a valid SAFE certificate and enclave attestation — defeating Pillar D exactly. New
`avaira_os/secrets.py` resolves `AVAIRA_OS_SECRET` → per-installation `os_secret` file (0600,
so the deterministic demos stay byte-identical across runs) → hard error. Tests assert a
certificate signed with the old literal is rejected.

---

## Verified as already sound (kept, with the checks that prove it)

* **Deterministic deterministic firewall fails closed** — `ShieldRules.evaluate` denies when
  OPA is unreachable, and `deep_neural_audit` denies on any exception. No fail-open path.
* **No dangerous primitives in application code** — no `eval`/`exec`/`pickle`/`yaml.load`/
  `shell=True`/`verify=False`, no md5/sha1, no `dangerouslySetInnerHTML` in the frontend.
* **Contract re-entrancy** — every state-changing path that moves value is `nonReentrant`;
  OZ `SafeERC20` for transfers; `MerkleLib` domain-separates leaves (0x00) and nodes (0x01).
* **Merkle reproducibility** — the Foundry suite already pins TypeScript leaves/roots/proofs
  to `MerkleLib`; the new Python suite (`tests/test_merkle_parity.py`) pins the Python SDK to
  the same vectors (leaves, roots, proofs, tamper rejection, odd/even promotion).
* **Session handling** — 48-byte tokens stored hashed, httponly/secure/samesite cookies,
  expiry enforced, logout deletes the session.

## Residual risk / not fixed here (deliberate)

* **Simulations are still simulations.** ZK proving, Nitro attestation, the witness network
  and fiat payments remain simulators. They are now unforgeable-without-the-installation-secret
  and explicitly labelled (`simulated: true`, `proof_type: zk-simulator/hmac-sha256`,
  `processor: "simulated"`), but they are not cryptographic ZK, real hardware attestation or
  real money movement. Do not present them as such.
* **`POST /agents/register` stays open** (agent-first onboarding) and records
  `user_id="system"` for anonymous callers; rate limited to 10/min, and such agents are only
  reachable with their API key.
* **Public read APIs** (`/agents`, `/executions`, leaderboards, treasury stats) remain
  unauthenticated by design.
* **`forge test` was not executed in the audit sandbox** (no network access to Foundry
  binaries). The new Solidity tests compile with the repo's pinned solc against the real
  test tree; CI is the execution oracle.
* **Not exhaustively reviewed** in this pass: `avaira_os/` internals beyond the secret/signing
  path, `services/scorer/src`, most frontend components, and the remaining TypeScript SDK
  modules.
