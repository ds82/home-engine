# Proposal

## Why

An audit of the 11 main specs against the code after `add-rule-engine` was archived found one missing requirement, about a dozen behaviours that differ from the specs, and a number of scenarios without a test. The worst one breaks real installations: after the host wakes from suspend, `daily` and `cron` schedules replay every missed run, and `every("1m")` crashes with a stack overflow. This change fixes the code to match the specs and adds tests for each finding. A few specs are corrected where they contradict each other or leave a case open.

## What Changes

**Bugs: the code does something the spec forbids**
- Time schedules (`daily`, `cron`, `every`, `sun`) compute the next run from now, not from the previous planned time. A run more than one minute late, for example after a suspend, is skipped and logged at `debug`, like a run missed while the engine was down.
- `listen()` throws when a rule passes an `id` it already used.
- Explicit rule ID collisions are logged naming both files, and the second file's load is reported as failed, not "Loaded".
- Hot reload processes deletions and moves before additions, so a file moved to a path that sorts earlier keeps its rules and their stored values.
- Hot reload enforces the `.ts`/`.js` conflict rule like startup does: neither file runs.
- File evaluation is attributed to the right file, even when a timed-out file or a running rule calls `rule()`/`setup()` while another file is being evaluated. Calls from outside any evaluation throw.
- The evaluation timeout is logged as a warning, as specified.
- The switching helpers (`on`, `off`, `forceOn`, `forceOff`, `toggle`, `up`, `down`) report unawaited failures through the same path as `call`, with the "Write failed (not awaited)" message.

**Smaller deviations**
- A setup rule whose async setup has not resolved yet reports status `starting`, not `running`.
- The status output names the trigger a native trigger error belongs to.
- `lastError` includes the error name (`ReferenceError: foo is not defined`).
- Engine messages about a single rule (started, stopped, failed) carry the rule ID as their source.
- `changeSince` covers the exact range, including partial hours at either end and ranges shorter than an hour.
- In dry-run mode, `ws.command` sends only known read-only commands and logs the others instead of sending them.
- The "no recorded history" warning is not logged for a query that is simply before the entity's first record.
- Storage: a failed write is retried, the directory is synced after the rename, and unexpected files in the storage directory no longer stop startup.

**Missing tests:** every scenario the audit marked as untested gets an automated test. That includes the shared connection, the `TIME_ZONE` override, mixed `daily` and `sun` triggers, the container reporting `unhealthy` when the engine hangs, tini reaping the installer's child processes, and the example Compose quick start.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `rule-scheduler`: the clock-drift requirement gets a host-suspend scenario that states missed runs are skipped.
- `rule-files`: the "Duplicate name in one file" scenario contradicts atomic file evaluation and is corrected. New scenarios cover rule IDs and extension conflicts during hot reload, and `rule()` called from a running rule while another file loads.
- `rule-lifecycle`: the evaluation timeout states that the timed-out file's later registrations are rejected. Async setup gets the `starting` status, and error messages keep the error name.
- `rule-triggers`: a scenario for a duplicate listener `id`.
- `ha-actions`: dry-run covers raw WebSocket commands.
- `ha-history`: `changeSince` gets scenarios for partial-hour and sub-hour ranges, and the history warning is limited to entities without any record.
- `engine-observability`: the `/rules` output identifies the failing trigger.

## Impact

- **Code:** `packages/engine/src/core` (scheduling, sun, timer, registration, loader, hot-reload, rule-registry, rule-runner, storage, logger) and `packages/engine/src/adapters/home-assistant` (writes, history, dry-run).
- **API:** `RuleInfo` gains the status `starting`, and `triggerErrors` entries gain the trigger's position and description. These are additive changes to the `/rules` JSON.
- **Tests and CI:** new unit tests, plus additions to `scripts/container-smoke.sh` for the health check, process reaping and the quick start.
- **Not in scope:**
  - Starting the arm64 image in CI. That needs binfmt emulation registered on the runner host, which the project avoids.
  - Choosing the image registry. The Compose example's default image depends on that decision.
