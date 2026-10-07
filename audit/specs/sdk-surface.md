# SDK surface — `@avaira/sdk` (TypeScript) and `avaira` (Python)

> The SDKs are part of the audit target because they *compute consensus-relevant bytes*: the
> canonical intent JSON, the intent hash, the deviation leaf, and the gate call the vault re-checks.

## Primitives that must agree (and are checked to agree)

| primitive | TypeScript | Python | cross-check |
| --- | --- | --- | --- |
| canonical intent JSON | `canonicalJson` (`src/canonical.ts`) | `json.dumps(sort_keys=True, separators=(",", ":"))` in `client.py` | `tools/parity/compare.py`, 42 vectors |
| `intentHash` | `Avaira.hashIntent(agentId, task, envelopeHash, nonce)` | `Avaira.hash_intent(...)` | same corpus, 10 intent vectors |
| `envelopeHash` | `envelopeHash(envelope)` | `hash_envelope(envelope)` | same, 10 vectors |
| deviation leaf | `AuditTrail.leafFor(agentId, intentHash, action, spendUsd, nonce)` | `AuditTrail.leaf_for(...)` | 13 adversarial leaves |
| Merkle root / proof | `merkleRoot`, `verifyProof` | `merkle_root`, `merkle_proof` | 9 trees incl. single-leaf and odd counts |

Shared formula, both languages, byte for byte:

```
intentHash  = keccak256(abi.encode("Avaira.Intent.v1", agentId, taskId, canonicalJson(task), envelopeHash, nonce))
envelopeHash= keccak256(abi.encode("RiskEnvelope(uint256,bytes32,uint64)", maxSpendUsd,
                                    keccak256(abi.encode("string[]", allowedActions)), deadline))
leaf        = keccak256(abi.encode(agentId, intentHash, action, spendUsd, nonce))   # then sorted-pair Merkle
```

Rules the canonical encoder pins (AV-013 was found because these were not pinned): keys sorted at
**every** depth **by code point** (not UTF-16 unit), `,`/`:` separators, non-ASCII escaped `\uXXXX`
with lowercase hex including surrogate pairs, `-0` → `0`, `undefined` members dropped, and
`bigint`/`NaN`/`Infinity`/`Date`/`Map`/class instances **rejected** rather than mangled; depth
capped at 64.

## API surface

```ts
const avaira = new Avaira({ /* config from deployment manifest */ })
await avaira.commit(taskId, envelope)                    // commitIntent
await avaira.run(taskId, plan, envelope, execute)        // hashIntent → commit → execute → attest, one leaf per action
avaira.hashIntent(agentId, task, envelopeHash, nonce)     // the commitment, standalone
await avaira.prove(taskId)                                // audit-trail proof for one intent
```

```python
client = AvairaClient.from_deployment(chain_id=143)      # or load_manifest(...)
client.hash_intent(agent_id, task, envelope_hash, nonce)
client.commit_intent(agent_id, intent_hash, envelope)
client.check_gate_for_intent(agent_id, intent_hash, envelope_hash)
client.attest_outcome(agent_id, intent_hash, outcome_hash, merkle_root)
client.record_gate_decision(...)                         # telemetry the scorer later reads
```

## Out of scope for parity

`sdk/avaira-rust-core` is pre-v2 (SHA-256 over concatenated strings, float money, no deadline, no
`AuditTrail`) and is reported as `skipped` by `tools/parity/compare.py` — see FINDINGS.md AV-014.
