# Tasks

## 1. Time schedules after a suspend (rule-scheduler)

Group 1 is merged to `main` on its own once CI is green, before the other groups (see the design's rollout).

- [x] 1.1 Add failing tests with a fake clock that jumps 3 days ahead past pending timers. With `daily("07:00")`, `cron`, `every("1m")` and `sun("sunset")`, the body does not run for the missed times, the skip is logged at `debug`, and the next run is the first one after the jump. With `every("1m")` there is no stack overflow. A run 20 s late still fires. Verify the tests fail on the current code for the right reason.
- [x] 1.2 Re-arm from `clock.now()` and skip runs more than `LATE_LIMIT_MS` (60 s) late in `core/scheduling.ts` (calendar and `every` sources) and `core/sun.ts` (design decision 1). Verify the 1.1 tests and the existing scheduler, sun, calendar and next-run tests pass.
- [x] 1.3 Document in `docs/rules/scheduling.md` that runs missed during a suspend are skipped while `after()`/`sleep()` still run. Verify `node scripts/check-docs.mjs` passes.

## 2. File evaluation attribution (rule-files, rule-lifecycle)

- [x] 2.1 Spike: a test checks that an AsyncLocalStorage store set around a dynamic `import()` of a bundled rule file is visible in the file's top-level code, after a top-level `await`, and in timers created there. Verify it passes. If it fails, switch to the fallback in design decision 2 and note that in the design.
- [x] 2.2 Replace the module-level registration slot in `core/registration.ts` with an AsyncLocalStorage registry that is marked `closed` on timeout or failure (design decision 2). Verify new tests: `rule()` from a trigger callback while another file is evaluated throws, and nothing is added to either file. A timed-out file's late `rule()` throws.
- [x] 2.3 Make a disposed rule scope cancel resources registered on it afterwards (`core/rule-scope.ts`). Verify a test where a timed-out file starts a timer after the timeout and the timer never fires.
- [x] 2.4 Log the evaluation timeout at `warn` (`core/loader.ts`). Verify a loader test that checks the level and the file name in the message.

## 3. Rule identity and hot reload (rule-files, rule-lifecycle)

- [x] 3.1 Treat an explicit ID collision as a failed load: log at `error` naming both files, mark the file failed, and do not log "Loaded" (`core/loader.ts`, `core/rule-registry.ts`). Verify a loader test for the collision scenario.
- [x] 3.2 Split the hot-reload batch into an unload phase and a load phase, and add whole conflict groups to the affected set (`core/hot-reload.ts`, design decision 3). Verify hot-reload tests:
  - moving `rooms/kitchen.ts` with an explicit ID to `a/kitchen.ts` keeps the rule running and its stored values readable;
  - adding `hallway.js` next to a loaded `hallway.ts` logs the conflict and unloads `hallway.ts`;
  - removing one of the two loads the other again.
- [x] 3.3 Document in `docs/rules/files.md` that a move whose addition and deletion arrive more than 200 ms apart can collide, and that saving the moved file once more loads it (design decision 3). Verify the docs check passes.
- [x] 3.4 Add a test for the corrected duplicate-name scenario: an uncaught duplicate fails the whole file with the error logged with the file path, and a caught duplicate keeps the first rule. Verify it passes without code changes, or fix the code if it doesn't.

## 4. Rule status and engine messages (rule-lifecycle, engine-observability)

- [x] 4.1 Add status `starting` to `RuleInfo`, set while an async setup promise is pending (`core/rule-runner.ts`, `core/rule-registry.ts`). Verify a test that reads `info()` before and after the setup promise resolves, a test that a listener registered before the `await` fires while the rule is `starting`, and HTTP tests that `/rules` shows `starting` and `/ready` is unaffected.
- [x] 4.2 Add a `describeError` helper and use it for rule and file `lastError` (design decision 7). Verify that a real `ReferenceError` thrown in setup shows as `ReferenceError: foo is not defined` in `info()` and in `/rules`, without a hand-built RuleInfo.
- [x] 4.3 Pass the trigger's 1-based position and short description along with a rejected native trigger, and expose `triggerErrors: [{ position, trigger, message }]`. Verify an event-trigger test with two `onTrigger` triggers where the second is rejected, and the `/rules` output.
- [x] 4.4 Log `Rule started`, `Rule stopped`, setup failures and setup timeouts through the rule's child logger at the levels in design decision 8. Verify a logger test that these lines carry `source: <rule ID>` and the file lines still carry `source: engine`.
- [ ] 4.5 Update the `/rules` description in the docs (status values, `triggerErrors` fields). Verify the docs check passes.

## 5. Listeners (rule-triggers)

- [ ] 5.1 Make `listen()` throw for an `id` already used in the same rule, naming the ID (`core/rule-runner.ts`). Verify a test where the second call throws and the first listener still fires.
- [ ] 5.2 Add the missing trigger tests:
  - one trigger object used as a triggered rule's trigger and with `listen()`, where both fire;
  - after a hold has fired, `store.keys()` does not contain the fired-holds record.

  Verify they pass.
- [ ] 5.3 Mention the uniqueness of listener IDs in `docs/rules/triggers.md`. Verify the docs check passes.

## 6. Writes and dry-run (ha-actions)

- [ ] 6.1 Wrap the switching helpers (`on`, `off`, `forceOn`, `forceOff`, `toggle`, `up`, `down`) in `trackWrite` with the service and entity as description (design decision 6). Verify a safety-net test that an unawaited `forceOn("light.missing")` rejected by the mock logs `Write failed (not awaited): light.turn_on → light.missing: …` once, attributed to the rule.
- [ ] 6.2 Add the read-only allowlist for `ws.command` in dry-run mode (design decision 11). Verify dry-run tests: `config/entity_registry/list` reaches the mock, and `config/entity_registry/update` does not, logs `[dry-run]` with the rule ID and resolves `undefined`.
- [ ] 6.3 Document the dry-run behaviour of `ws.command` in `docs/rules/actions.md`. Verify the docs check passes.

## 7. History (ha-history)

- [ ] 7.1 Check Home Assistant's reset detection for `total_increasing` (the 10 % threshold and the handling of smaller dips) in its recorder code, and correct the "Small dip" scenario and design decision 9 if they differ. Verify by citing the source lines in the commit message.
- [ ] 7.2 Compute `changeSince` from state history within the recorder's retention (start state included, `unavailable`/`unknown` skipped, resets detected as in 7.1, `total` `last_reset` changes as resets), and fall back to statistics before it (design decision 9). Verify tests for:
  - a range starting at 12:34;
  - a 10-minute range;
  - a reset within the range;
  - a small dip that is not a reset;
  - a `total` sensor with a changed `last_reset`;
  - a range before the retention window that still uses statistics.
- [ ] 7.3 Probe once whether an entity is recorded before logging the "no recorded history" warning (design decision 10). Verify tests: `stateAt` before the first record logs nothing, and an excluded entity still warns once.
- [ ] 7.4 Update `docs/rules/history.md` for `changeSince` (exact ranges within retention, hourly resolution before it). Verify the docs check passes.

## 8. Storage (rule-storage)

- [ ] 8.1 On a failed flush, mark the namespace dirty again and retry with backoff, with a final attempt on shutdown (design decision 12). Verify a test with an injected write failure that later succeeds and keeps the value.
- [ ] 8.2 `fsync` the storage directory after the rename, ignoring unsupported file systems. Verify the storage tests pass and a test spies on the directory sync.
- [ ] 8.3 Handle each storage file inside its own `try` when loading, and skip unexpected names and corrupt files that cannot be moved aside. Verify tests where a file named `%E0%A4%A.json` and a corrupt file with a failing rename do not stop startup.
- [ ] 8.4 Add the orphaned-data test: delete a rule file, check the stored file stays, restore the rule file, and read the old values again. Verify it passes.

## 9. Tests for behaviour that is already correct

- [ ] 9.1 Engine-level tests:
  - with several rules loaded, the mock sees exactly one connection (`connectionCount`);
  - `TIME_ZONE` overrides the zone Home Assistant reports, and without it, Home Assistant's zone reaches the scheduler.

  Verify they pass.
- [ ] 9.2 Rule tests:
  - a rule with `[daily(…), sun(…)]` receives `trigger` and `type` that identify which one fired;
  - when one `setup` in a file throws, the file's other rules still start;
  - after a failed `npm install`, the engine still loads rule files, and a file with an unresolvable import fails on its own with a clear error.

  Verify they pass.
- [ ] 9.3 Assert the debug line `Resync after reconnect: N entities differed` in the reconnect test. Verify it passes.

## 10. Container checks (container-image)

- [ ] 10.1 Make the Compose example's image configurable (`${HOME_ENGINE_IMAGE:-…}`) and add `stop_grace_period: 15s`. Verify `docker compose -f examples/docker-compose.yml config` shows both.
- [ ] 10.2 Extend `scripts/container-smoke.sh` (design decision 13) with:
  - the unhealthy health-check case;
  - the zombie check;
  - the quick start through `docker compose` against the mock Home Assistant.

  Verify the script passes locally and the `container` CI job passes.
- [ ] 10.3 Update `examples/README.md` with the image variable. Verify the quick start steps still work as written.

## 11. Integration

- [ ] 11.1 Run lint, format check, build, typecheck, the full test suite, the docs check, `scripts/container-smoke.sh` and `scripts/e2e-ha.sh`. Verify all pass and the `check`, `container` and `e2e` CI jobs are green for the final commit.
- [ ] 11.2 Re-run the spec audit for the seven modified capabilities, and confirm that every scenario in the delta specs is implemented and covered by a test.
