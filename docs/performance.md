# Performance

## Load test

`scripts/load-test.mjs` runs the built engine against the mock Home Assistant from
`home-engine/testing`, over a real WebSocket, with:

- 5,000 entities (4,990 sensors with attributes, 10 binary sensors),
- 50 rules in 10 files: exact entity IDs, lists, glob patterns, `to` predicates, attribute
  triggers and `for` holds,
- a steady stream of `state_changed` events, half of them for entities a rule watches and half
  for the other ~4,600 sensors, which the engine still receives, caches and matches against
  every trigger.

Latency is measured from the moment the mock sends a change (the time is stamped into the new
state) to the moment the rule body runs. It covers the WebSocket, JSON parsing, the state cache,
trigger matching, change-cause resolution and the rule's run scheduling. The test fails if the
99th percentile reaches 50 ms.

```sh
npm run build
node scripts/load-test.mjs                          # 60 s at 100 changes/s
node scripts/load-test.mjs --seconds 30 --rate 500  # stress
```

## Results

Recorded on 2026-10-11: Node.js v24.21.0, AMD Ryzen 7 5700G (16 threads), 27 GB RAM, Linux.
The mock server runs in the same process as the engine, so both share one event loop.

| Run                   | Changes | Rule runs | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | RSS    |
| --------------------- | ------- | --------- | -------- | -------- | -------- | -------- | ------ |
| 60 s at 100 changes/s | 6,001   | 4,369     | 0.15     | 0.31     | 0.38     | 1.23     | 114 MB |
| 30 s at 500 changes/s | 15,001  | 10,935    | 0.09     | 0.16     | 0.22     | 1.63     | 120 MB |

The target (p99 below 50 ms at 100 changes/s) is met by two orders of magnitude, also at five
times the rate. A few things to keep in mind when reading the numbers:

- The rule bodies are trivial. A body that awaits a service call or history query adds Home
  Assistant's response time to its own run, but not to the latency of other rules.
- The event-loop delay reported by the script (about 11 ms) is the resolution of Node's
  `monitorEventLoopDelay` sampling (10 ms), not time spent blocked.
- A real Home Assistant on another host adds network time to every event; the engine's own
  share stays as measured here.
- Each hot reload keeps the previous version of a bundle in memory (design D3); a restart
  frees it.

The script is not part of CI, because shared CI runners make timings noisy. Run it before a
release or after changes to the state cache, the dispatcher or the trigger sources.
