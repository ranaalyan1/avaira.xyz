# Specifications (generated)

Every file here is produced by `tools/gen_contract_specs.py` from the compiled build — ABI, selectors,
NatSpec and deployed sizes cannot drift from the code because they *are* the code's output.
Rebuild with `make specs`; CI fails if the committed files are stale (`tools/doctor.py`).

| spec | contents |
| --- | --- |
| [`AvairaCreditMarket.md`](./AvairaCreditMarket.md) | generated from Solidity build |
| [`AvairaIdentityRegistry.md`](./AvairaIdentityRegistry.md) | generated from Solidity build |
| [`AvairaIntentVault.md`](./AvairaIntentVault.md) | generated from Solidity build |
| [`AvairaReputationRegistry.md`](./AvairaReputationRegistry.md) | generated from Solidity build |
| [`AvairaStakeRegistry.md`](./AvairaStakeRegistry.md) | generated from Solidity build |
| [`AvairaValidationRegistry.md`](./AvairaValidationRegistry.md) | generated from Solidity build |
| [`MerkleLib.md`](./MerkleLib.md) | generated from Solidity build |
| [`MockUSDC.md`](./MockUSDC.md) | generated from Solidity build |
| [`RiskEnvelopeLib.md`](./RiskEnvelopeLib.md) | generated from Solidity build |
| [`scorer-service.md`](./scorer-service.md) | hand-maintained cross-layer |
| [`sdk-surface.md`](./sdk-surface.md) | hand-maintained cross-layer |

## Known gap

`sdk/avaira-rust-core` has no spec here: it is pre-v2 and cannot express a v2 intent
(`sha256` over concatenated strings instead of `keccak256(abi.encode(...))`, no `AuditTrail`,
no deadline in its envelope). See [AV-014](../../FINDINGS.md#av-014) — the parity harness
reports it as `skipped`, never as passing.

