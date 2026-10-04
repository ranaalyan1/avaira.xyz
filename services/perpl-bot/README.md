# Perpl trading bot (Workstream 3)

Grid market-making agent for the deepest Monad pair (**MON/USDC**) where **every
cycle is gated by `avaira.run()`** — Proof-of-Intent commit → pre-execution gate →
hash-chained audit trail → attested outcome. The bot never places an order the
gate has not allowed.

```
cycle N:  risk checks (halt? kill switch? score?)
          ↓
          envelope = { maxSpendUsd: gas-aware budget,
                       allowedActions: [perpl.quote, perpl.place_order,
                                        perpl.cancel_order, perpl.settle],
                       deadline: cycle end }
          ↓
          avaira.run(agentId, task, execute_fn, { envelope })
            ├─ gate blocked → halt + log (execute_fn NEVER runs)
            └─ gate allowed → quote → cancel stale → place grid → settle
                               (each exchange call append()ed to the audit
                                trail with its spendUsd; Merkle root anchored
                                on-chain via attestOutcome)
          ↓
          persist state.json atomically → GET /status
```

## Modes

| `PERPL_MODE` | Exchange                         | When                              |
| ------------ | -------------------------------- | --------------------------------- |
| `sim` (default) | offline paper book, drifting mid, deterministic pseudo tx hashes | sandboxes, CI, judge laptops |
| `live`       | `PERPL_API_URL` REST endpoint     | production / funded testnet runs  |

The on-chain part (gate, commitIntent, attestOutcome, scoring) is **always real**
against the configured `PERPL_RPC_URL`.

## Quickstart (local anvil, chain 10143)

```bash
# 1. fresh chain + deployment
anvil --chain-id 10143 &
cd contracts && make deploy-monad          # or: forge script script/Deploy.s.sol ...

# 2. provision the trading agent (register + stake + Avaira Score 78)
cd ../services/perpl-bot && npm install
export AVAIRA_DEPLOYMENT=../../deployments/10143.local.json
export AVAIRA_RPC_URL=http://127.0.0.1:8545
npm run provision                          # prints PERPL_AGENT_ID=...

# 3. trade (every cycle gated)
PERPL_AGENT_ID=<id> PERPL_CYCLE_MS=2000 npm start

# 4. telemetry
curl localhost:8401/status | jq
```

For Monad Testnet set `PERPL_RPC_URL=https://testnet-rpc.monad.xyz`,
`CHAIN_ID=10143`, a funded `OPERATOR_PRIVATE_KEY`, and a `PERPL_AGENT_ID`
registered on the testnet deployment (`deployments/10143.json`).

## Recorded scenarios

```bash
npm run demo:block     # drops the agent score below 60 → the on-chain gate
                       # blocks the cycle (SCORE_TOO_LOW) → execute_fn never
                       # runs → score restored; decision persisted to state.json
```

A gate block **halts** the bot. Resume explicitly:

```bash
curl -X POST localhost:8401/admin/reset-halt
curl -X POST localhost:8401/admin/block-next   # arm one intentional block
```

## Risk controls

- **Hard position cap** — no order may push `|inventory|` past `PERPL_MAX_POSITION_QTY`.
- **Max-drawdown kill switch** — equity (capital + realised PnL + inventory mark)
  vs running peak; a breach of `PERPL_MAX_DRAWDOWN_PCT` halts the bot.
- **Min score 60** — checked locally for clear logs and on-chain by the gate.
- **Gas-aware sizing** — `commitIntent` + `attestOutcome` gas (≈250k units at the
  current gas price, converted via `PERPL_MON_USD`) is reserved out of every
  cycle budget before orders are sized.
- **Envelope budget** — order notionals are clipped to `maxSpendUsd`; the audit
  trail records `spendUsd` per `perpl.place_order`.

## Telemetry (`GET /status`)

Positions, equity/peak, realised PnL, open orders, the last 50 gate decisions
(reason, score, intent hash, commit/attest tx hashes), the last 100 tx hashes,
and halt state. `GET /health` for liveness.

## Tests

```bash
npm test           # 19 unit tests: strategy caps, kill switch, gas budget,
                   # sim fills/cancels/round-trips, persistence round-trip
```
