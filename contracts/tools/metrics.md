
## Avaira measured metrics — in-process EVM harness

Gas price used: 2 gwei · MON reference price: $3 (override with --mon-usd)

| Write path | gas (avg) | gas (max) | MON | USD |
| --- | ---: | ---: | ---: | ---: |
| registerAgent | 154,164 | 154,164 | 0.000308328 MON | $0.000925 |
| commitIntent | 339,434 | 366,787 | 0.000678868 MON | $0.002037 |
| attestOutcome | 113,289 | 113,294 | 0.000226578 MON | $0.000680 |
| giveFeedback (staked reviewer) | 234,743 | 264,311 | 0.000469486 MON | $0.001408 |
| giveFeedbackWithX402Settlement | 372,454 | 396,161 | 0.000744908 MON | $0.002235 |
| recordGateCheck (onchain event) | 55,426 | 55,426 | 0.000110852 MON | $0.000333 |
| challengeDeviation (Merkle proof) | 232,736 | 232,736 | 0.000465472 MON | $0.001396 |

| Gate latency (SDK hot path) | ms |
| --- | ---: |
| checkGate (view, p50) | 16.37 |
| checkGate (view, p95) | 19.69 |
| commitIntent tx (p50, includes block) | 53.89 |
| commit → gate → attest round trip (p50) | 92.34 |
| commit → gate → attest round trip (p95) | 112.95 |
| gate checks per minute (sequential, one client) | 3,864 |
| gate checks per minute (concurrent, 5×250 in flight) | 5,980 |
| checkGate per call under concurrency (p50/p95) | 9.91 / 11.38 |

Source: in-process EVM. Contract-side costs are chain-independent; the latency column is the
lower bound and excludes network round trips — re-run with --rpc on Monad for the published figure.
