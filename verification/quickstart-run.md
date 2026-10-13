# Avaira — verification transcript

Captured 2026-10-06 15:59:55 UTC · commit `8af1d49` · python 3.11.2 · pydantic 2.13.5

Reproduce with `./setup.sh` (~7s, no API keys, no wallet, no database).

## Proof artifacts — PASS (212 ms)

```console
$ python -m avaira_os.demos

========================================================================
  PROOF ARTIFACT 1 — SELF-CORRECTION (sandbox catches a bug)
========================================================================
status            : COMPLETED
proof verdict     : SAFE
sandbox confidence: 1.000
plan hash         : 42bd2d5bbcefad7198b9fb4a…
final state       : {'cash_usd': 8.425, 'spend_total_usd': 91.575}

event transcript:
  000 GOAL_SET             {"goal":"deploy the payments service release"}
  001 PLAN_EMITTED         {"iteration":0,"plan_hash":"edba89a905bccf9eb446b68d033c1941281a00f096dff45feedff3ad47738581","steps
  002 PROOF_COMPLETED      {"reason":"step 'deploy' drives 'cash_usd' below_lo its hard rule [0.0, 100.0]","verdict":"UNSAFE"}
  003 CRITIQUE             {"back_edge":"PLAN","origin":"prover","reason":"step 'deploy' drives 'cash_usd' below_lo its hard ru
  004 PLAN_EMITTED         {"iteration":1,"plan_hash":"42bd2d5bbcefad7198b9fb4aac79fa2f313d0d7b7b0403a34f824472d37224e3","steps
  005 PROOF_COMPLETED      {"reason":"all state variables proven inside hard-rule boundaries for the full parameter space","ver
  006 SIMULATION_COMPLETED {"confidence":1.0,"runs":200,"violations":0}
  007 EXECUTED             {"audit_id":"AUD-42BD2D5BBCEF","final_state":{"cash_usd":8.425,"spend_total_usd":91.575}}
  008 MEMORY_WRITTEN       {"belief":"agent/executed_plan/42bd2d5bbcefad71"}
  009 COMPLETED            {"plan_hash":"42bd2d5bbcefad7198b9fb4aac79fa2f313d0d7b7b0403a34f824472d37224e3"}

ledger tamper-evident: True
self-correction demonstrated: True

========================================================================
  PROOF ARTIFACT 2 — AMBIGUITY (suspend at AWAIT_INPUT, resume on answer)
========================================================================
status after run  : AWAIT_INPUT
pending question  : What is the exact payment amount in USD?
suspended at AWAIT_INPUT: True

answer submitted  : amount_usd ∈ [20.00, 30.00]
status after resume: COMPLETED
proof verdict     : SAFE
final state       : {'cash_usd': 75.0, 'spend_total_usd': 25.0}

event transcript:
  000 GOAL_SET             {"goal":"pay the vendor invoice"}
  001 AMBIGUITY_SUSPENDED  {"question":"What is the exact payment amount in USD?","question_id":"amount_usd"}
  002 INPUT_RESUMED        {"bound":[20.0,30.0],"param":"amount_usd"}
  003 PLAN_EMITTED         {"iteration":0,"plan_hash":"0ce6c5f3e42646624b43d752bc9915fae89969a9e997dbfa61aed09a8d7c88ce","steps
  004 PROOF_COMPLETED      {"reason":"all state variables proven inside hard-rule boundaries for the full parameter space","ver
  005 SIMULATION_COMPLETED {"confidence":1.0,"runs":200,"violations":0}
  006 EXECUTED             {"audit_id":"AUD-0CE6C5F3E426","final_state":{"cash_usd":75.0,"spend_total_usd":25.0}}
  007 MEMORY_WRITTEN       {"belief":"agent/executed_plan/0ce6c5f3e4264662"}
  008 COMPLETED            {"plan_hash":"0ce6c5f3e42646624b43d752bc9915fae89969a9e997dbfa61aed09a8d7c88ce"}

ambiguity handling demonstrated: True

========================================================================
  PROOF ARTIFACT 3 — MATH SAFETY (UNSAFE for over-budget, clamp to $95)
========================================================================
status            : COMPLETED
proof verdict     : SAFE
plan iterations   : 1
actual spend      : $95.00 (cap $100.00)

event transcript:
  000 GOAL_SET             {"goal":"pay vendor invoice of $120"}
  001 PLAN_EMITTED         {"iteration":0,"plan_hash":"70eb8d0bebd82ad229061fe3f984f653ac667c966d940e0912006fbe1142b402","steps
  002 PROOF_COMPLETED      {"reason":"step 'pay' drives 'cash_usd' below_lo its hard rule [0.0, 100.0]","verdict":"UNSAFE"}
  003 CRITIQUE             {"back_edge":"PLAN","origin":"prover","reason":"step 'pay' drives 'cash_usd' below_lo its hard rule 
  004 PLAN_EMITTED         {"iteration":1,"plan_hash":"9a7fc0be37ba32ef250aeb0b04ed5fa0421331fc09f09fcf0aea5fcedbd2d03d","steps
  005 PROOF_COMPLETED      {"reason":"all state variables proven inside hard-rule boundaries for the full parameter space","ver
  006 SIMULATION_COMPLETED {"confidence":1.0,"runs":200,"violations":0}
  007 EXECUTED             {"audit_id":"AUD-9A7FC0BE37BA","final_state":{"cash_usd":5.0,"spend_total_usd":95.0}}
  008 MEMORY_WRITTEN       {"belief":"agent/executed_plan/9a7fc0be37ba32ef"}
  009 COMPLETED            {"plan_hash":"9a7fc0be37ba32ef250aeb0b04ed5fa0421331fc09f09fcf0aea5fcedbd2d03d"}

math-safety clamp to $95 demonstrated: True

========================================================================
  PROOF ARTIFACT 4 — SLASH (forced violation, gate refuses, stake burns)
========================================================================
stake before      : $100.00
status            : SLASHED
gate refusals     : invalid_certificate_signature
stake burned      : $25.00
stake remaining   : $75.00

on-chain settlement (dry-run):
  to     : 0x5eb3E0eE3bE9E0964b0F1Eaa3Cd2bE74ba3746C2
  func   : freezeAndSlash(address,uint256,string)
  data   : 0xbd670dc100000000000000000000000011111111…

event transcript:
  000 GOAL_SET             {"forced_violation":true,"goal":"pay vendor invoice of $40"}
  001 PLAN_EMITTED         {"iteration":0,"plan_hash":"ca362c90612accff8700f33371a4ef452a63846905fcc47e460684d4e75a31bf","steps
  002 PROOF_COMPLETED      {"reason":"all state variables proven inside hard-rule boundaries for the full parameter space","ver
  003 SIMULATION_COMPLETED {"confidence":1.0,"runs":200,"violations":0}
  004 GATE_REFUSED         {"refusals":["invalid_certificate_signature"],"tamper_detected":true}
  005 SLASHED              {"amount":25.0,"evidence_hash":"7033963d577cdc6ea9ce453db56ce8a184d910ed4aa6854f099f5e4bb095d626","r

atomic slash demonstrated: True

========================================================================
  SUMMARY
========================================================================
  [PASS] self_correction  — Self-Correction: bug caught -> fixed -> deployed
  [PASS] ambiguity        — Ambiguity: AWAIT_INPUT suspension -> resume
  [PASS] math_safety      — Math Safety: UNSAFE -> clamp to $95
  [PASS] slash            — Slash: gate refusal -> atomic stake burn

all proof artifacts: PASS
```

## Kernel tests — PASS (354 ms)

```console
$ python -m pytest tests/test_cognitive_os.py -q
.....................                                                    [100%]
21 passed in 0.17s
```
