# Design

## Context

See proposal.md for why. The findings come from an audit of the 11 main specs. Most of the code is sound. The fixes are local to a few modules, and nearly all of them are code that falls short of a spec that is already right. Where this design names files, they are under `packages/engine/src/`.

The design of `add-rule-engine` (archived in `openspec/changes/archive/2026-10-12-add-rule-engine/design.md`) still applies. This change keeps its decisions, notably D4 for run attribution with AsyncLocalStorage and D6 for schedules computed against wall-clock times.

## Goals / Non-Goals

**Goals:**
- Every finding of the audit gets a test that fails before the fix and passes after it.
- No change to the rule API, except that `listen()` now throws for a duplicate `id`, as the spec always required.

**Non-Goals:**
- Running the arm64 image in CI. That needs binfmt emulation registered on the runner host.
- Choosing the image registry. Only the Compose example becomes configurable, so the quick start can be tested.
- Making the shutdown limit configurable. The race between the engine's 10 s limit and Docker's 10 s stop timeout is recorded as a known risk below.

## Decisions

### 1. Time schedules re-arm from now and skip late runs

`core/scheduling.ts` (`daily`/`cron`/`every`) and `core/sun.ts` re-arm from the planned time `at`. After a suspend, `at` is far in the past, the next target is also in the past, and `hostClock` runs past targets synchronously. That causes the replays, and the stack overflow for `every`.

The timer callback now:
- takes `now = clock.now()`;
- fires only if `now - at <= LATE_LIMIT_MS` (60 s), so a run exactly one minute late still runs, as the spec says only a run *more* than a minute late is missed;
- otherwise logs `Skipped <trigger> run planned for <at>: <n> late` at `debug` through the rule's logger;
- in both cases re-arms with `arm(now)` or `armNext(now)`.

`nextDaily`, `Cron.nextRun` and the `every` grid return a time strictly after their argument, so re-arming from `now` can never produce a past target. `after()` and `sleep()` are one-shot delays, not time triggers, and still run late after a suspend, as the spec's "Very long delay" scenario requires.

*Alternative:* run once on wake-up for the most recent missed time. Rejected: the spec already says missed runs are not replayed when the engine was down, and a suspend is the same situation from the rule's point of view.

### 2. File registration uses its own AsyncLocalStorage

The module-level `current` slot in `core/registration.ts` becomes an `AsyncLocalStorage<FileRegistry>`:
- `evaluateFile` runs `evaluate()` inside `fileStorage.run(registry, …)`.
- `rule()`/`setup()` read `fileStorage.getStore()` and throw unless a registry is present and not `closed`.
- On timeout or failure, the registry is marked `closed`, and its file scope is disposed.

A file that keeps running after a timeout still sees its own, closed registry, so its late `rule()` calls throw instead of landing in another file. Trigger callbacks run under the rule's run context, without a file registry, so they throw as before, even while another file is loading.

`currentFileScope()` reads the same store. Timers that a timed-out file creates later attach to its disposed scope. A disposed scope already runs a cleanup registered on it immediately, so such a timer is cleared before it can fire; `core/rule-scope.ts` needs no change.

The "one file at a time" guard stays, because the loader evaluates sequentially.

*Risk:* the context has to follow a dynamic `import()` into module evaluation and top-level `await`. Node's AsyncLocalStorage does that for promise continuations. The first task checks it with a test before anything else is built on it. *Fallback* if it does not hold: keep the slot, but have `rule()` also refuse when a rule's run context is active, and drop late calls from a timed-out file by checking its registry's `closed` flag through a closure the bundle receives.

### 3. Hot reload: whole conflict groups, unloads before loads

In `core/hot-reload.ts`, the batch now:
1. adds every file of a conflict group that touches the affected set to that set, so an already-loaded `hallway.ts` is unloaded when `hallway.js` appears;
2. unloads all affected files that are no longer valid;
3. loads the valid ones in sorted order.

A moved file is a deletion plus an addition in the same batch, so the old file's rule IDs are free before the new file loads.

*Edge, accepted:* a move whose two events land in different debounce batches (more than 200 ms apart). The addition can come first and collide. The collision is then logged as an error naming both files (Decision 4), and saving the moved file once more loads it. Editors and `mv` produce one batch in practice, so the engine does not track which file blocked which. The workaround is documented in `docs/rules/files.md`.

### 4. Explicit ID collision is a load failure

`rule-registry.ts` already detects the collision. `loader.loadFile` now treats it like any other file failure:
- it logs at `error` with both file paths;
- it marks the file as failed;
- it returns `false` instead of logging "Loaded".

### 5. Duplicate names: spec corrected, code kept

The old scenario ("first kept, second throws, logged") contradicts atomic evaluation, so the spec delta resolves it. The current code already does what the corrected scenario says. Only a test is missing.

### 6. Unawaited switching writes

`switchTo`, `position` and `toggle` in `adapters/home-assistant/writes.ts` are `async` wrappers. The promise they return is not the one passed to `trackWrite`. Each public function now returns `trackWrite(inner(...), description)`, with the same description format as `call` (`light.turn_on → light.missing`). The inner `call` promise is awaited by the wrapper, so it is never reported twice.

### 7. Rule status `starting`, error names, trigger errors

- `RuleInfo.status` gains `starting` (see **Rule status** in `CONTEXT.md`). The status is set while an async setup promise is pending and becomes `running` when it resolves. Only setup rules can be `starting`. Listeners registered before the setup's `await` already fire, and `/ready` ignores rule statuses: readiness is about the connection to Home Assistant.
- `lastError` is built by one helper, `describeError`: `${name}: ${message}` for `Error`s (skipping the prefix when the message already starts with the name), `String(x)` otherwise. It is used for rule and file errors.
- `triggerErrors` entries become `{ position, trigger, message }`:
  - `position` is 1-based in the rule's trigger list, or in the listener's list for a setup rule.
  - `trigger` is a short description such as `ha-trigger numeric_state`.

  Both are known where the trigger is armed and are passed with the rejection.

### 8. Per-rule engine messages

Rule-specific engine messages (`Rule started`, `Rule stopped`, setup failure, setup timeout) go through the rule's child logger, so they carry `source: <rule ID>`. Messages about the whole file (`Loaded lights.ts (3 rules)`, `Unloaded lights.ts`) stay engine messages with the file path. Per-rule start and stop lines are `debug`, so the `info` output stays one line per file.

### 9. `changeSince` from recorder history

Within the recorder's retention, `changeSince` now uses state history instead of hourly statistics:
- It fetches the numeric states over `[since, until]`, including the state at `since`.
- It skips `unavailable` and `unknown` states.
- It sums the increases between consecutive values.

Resets follow Home Assistant's statistics exactly, so `changeSince` agrees with the Energy dashboard:
- For `total_increasing`, only a drop of more than 10 % starts a new cycle, and the new value then counts as the increase from 0. A smaller dip is not a reset and is counted as Home Assistant counts it.
- For `total`, a change of the `last_reset` attribute starts a new cycle.

The 10 % threshold and the handling of small dips are taken from Home Assistant's recorder code (`homeassistant/components/sensor/recorder.py`) and verified there during implementation. If Home Assistant's handling differs from the "Small dip" scenario, the scenario is corrected to match Home Assistant.

Before the retention window, it falls back to hourly `change` statistics as today, with the partial-hour limitation documented. That is the same split `averageSince` already uses.

*Alternative:* hourly statistics plus history for the partial hours at both ends. Rejected: it needs both sources for every call and is harder to get right at the joins.

### 10. History warning only for unrecorded entities

When a history query comes back empty, `history.ts` makes one probe: the entity's history over the last minute, including the start state. Home Assistant always returns the current state for a recorded entity, so an empty probe means the entity is not recorded, and the warning is logged as before. A non-empty probe means the range was simply before the first record, so nothing is logged. The probe runs at most once per entity and rule, because the warning is deduplicated anyway and the result is cached alongside it.

### 11. Raw WebSocket commands in dry-run

`ws.command` checks the command `type` against an allowlist of read-only queries. Anything else is logged as `[dry-run] <rule> ws <type>` with the payload and resolves with `undefined`. The list is:
- `get_states`, `get_config`, `get_services`, `get_panels`;
- `auth/current_user`;
- any `*/list` or `*/get` under `config/`;
- `history/history_during_period`;
- `recorder/statistics_during_period`, `recorder/list_statistic_ids`, `recorder/get_statistics_metadata`;
- `search/related`.

An allowlist rather than a blocklist, because an unknown command must not reach Home Assistant in dry-run.

### 12. Storage robustness

In `core/storage.ts`:
- **Failed flush:** the namespace is marked dirty again, and a retry is scheduled with exponential backoff (0.5 s doubling, capped at 30 s). Each failure is logged, and shutdown makes a final attempt.
- **Directory sync:** after `rename`, the directory is opened and `fsync`ed. `EISDIR`, `EINVAL` and `EPERM` are ignored, for file systems that don't support it.
- **Loading:** each entry in the storage directory is handled inside its own `try`. Unexpected names are skipped with a warning instead of aborting startup. A corrupt file that cannot be renamed aside is skipped with an error, and its namespace starts empty in memory without overwriting the file until the first `set`.

### 13. Container checks

`scripts/container-smoke.sh` gets three additions:
- **Health:** start the image with `--health-interval=2s --health-retries=2` and a rule whose `onStartup` blocks the event loop. Expect `docker inspect` to report `unhealthy` within 30 s.
- **Process reaping:** `docker exec` a shell that leaves an orphaned child behind. Then scan `/proc/*/stat` in the container for state `Z` and expect none. tini is PID 1, and the image has no `ps`.
- **Quick start:**
  - `examples/docker-compose.yml` takes its image from `${HOME_ENGINE_IMAGE:-ghcr.io/home-engine/home-engine:latest}`.
  - The script runs `docker compose` with that variable set to the locally built image. An override file points `HA_URL` at the mock Home Assistant container the smoke test already uses.
  - It expects the `hello.ts` greeting in the log.

The CI image `docker:27-cli` ships the Compose plugin.

## Risks / Trade-offs

- **[A schedule falsely skipped]** A `daily` run delayed more than a minute by a blocked event loop would be skipped. → A blocked loop that long already makes the container unhealthy. The skip is logged at `debug`, and the threshold is a named constant.
- **[AsyncLocalStorage across `import()`]** If the context does not follow module evaluation, Decision 2 fails. → It is checked first; the fallback is described above.
- **[`changeSince` cost]** A history query over a long range returns more rows than hourly statistics. → Use `minimal_response` and `no_attributes`, except for `total` sensors, which need `last_reset`. Ranges beyond the retention window still use statistics.
- **[Allowlist too narrow]** In dry-run, a legitimate read command missing from the list is blocked. → It is logged with its type, so the gap is visible and the list is easy to extend.
- **[Shutdown race, not addressed]** The engine's 10 s limit equals Docker's default stop timeout, so on a hanging teardown Docker may kill the process before the "blocked by" line. → Document `stop_grace_period: 15s` in the Compose example.

## Migration Plan

**Rollout:** one OpenSpec change, several merges. Group 1 (the schedule fix after a suspend) is implemented first and merged to `main` on its own as soon as CI is green. The remaining groups follow in two or three batches, each merged when green.

No data migration. `/rules` consumers see a new status value and extra fields in `triggerErrors`, which is additive. Rules that call `listen()` twice with the same `id` now fail at setup with a clear error. Any such rule already had a latent bug. Rollback is a revert of the commits.
