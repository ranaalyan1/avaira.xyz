# Qwen treasury agent (Workstream 4)

An autonomous treasury agent powered by **Qwen 3.8 Max** (DashScope
OpenAI-compatible API) where **every tool call is wrapped in `avaira.run()`**
behind a task-budget RiskEnvelope: commit intent → pre-execution gate →
execute with a hash-chained audit trail → anchor the Merkle root on-chain.
Deviations from the envelope are provable by anyone via `challengeDeviation`
and get slashed.

```
user task → Qwen plan → tool call
            ↓
            avaira.run(agentId, task, execute_fn,
              { envelope: { maxSpendUsd: remaining task budget,
                            allowedActions: [this tool's action],
                            deadline: task window } })
            ├─ gate blocked → record, stop (execute_fn NEVER ran)
            └─ allowed → execute → audit.append(action, spendUsd)
                         → attestOutcome(outcomeHash, merkleRoot)
```

## Running

```bash
cd services/qwen-agent && npm install

# Local anvil chain (see root Makefile: make anvil + make deploy-monad)
export AVAIRA_DEPLOYMENT=../../deployments/10143.local.json
export AVAIRA_RPC_URL=http://127.0.0.1:8545

npm run demo:qwen      # records all three scenarios → transcripts/
npm start -- "Rebalance $100 of MON into USDC"   # one interactive task
npm test               # offline unit tests
```

**Live Qwen**: set `QWEN_API_KEY` (and optionally `QWEN_BASE_URL`,
`QWEN_MODEL`). Without a key the agent runs `QWEN_MOCK=1` — a deterministic
scripted conversation that records byte-stable demo transcripts offline. The
agent loop, gating, envelopes, audit trails and challenges are identical in
both modes; only the assistant turns differ.

## Recorded scenarios (`npm run demo:qwen`)

| # | Scenario | What the transcript shows |
|---|----------|---------------------------|
| a | **Happy path** — $250 swap inside the envelope | plan → balance/quote/swap tool calls, each `GATE ALLOWED` with intent + commit tx, `EXECUTE` with spendUsd, `SETTLE` with Merkle root + attestOutcome tx |
| b | **Overspend** — $2,000 proposal vs $500 budget | proposal `CLAMPED` to the remaining budget; follow-up attempt hits the gate with the score below the floor → `BLOCKED`, execute_fn never runs |
| c | **Forged certificate** — deviation challenged | cert_verify slips past the naive verifier and anchors a trail containing a $900 leaf (> $500 envelope); `CHALLENGE` proves it against the agent's own Merkle root → stake slashed, bounty paid, agent `SUSPENDED` |

Transcripts (JSON + human-readable text) land in `transcripts/` with every
ReasoningTrace step: plan, tool_call, gate decision (reason, score, intent
hash, commit/attest tx hashes), execution spend, settlement root, challenge
outcome.

## Slash math (scenario c)

`challengeDeviation(agentId, intentHash, leaf, proof)` verifies the leaf
against the anchored root, checks `leaf.spendUsd > envelope.maxSpendUsd`,
slashes the agent at SUSPENSION level, refunds the challenger bond and pays
the bounty from the slashed stake — all from the trail the agent itself wrote.
