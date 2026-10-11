# Tasks

## 1. Repository scaffolding

- [x] 1.1 Set up npm workspaces monorepo (`packages/engine` published as `home-engine`, `packages/sdk` as `@home-engine/sdk`, `packages/typegen`, `examples/rules`) with strict `tsconfig` base, ESLint, Prettier, Node LTS `engines` field, `.nvmrc`, MIT `LICENSE` file and `"license": "MIT"` in every `package.json`; verify `npm install` and `npm run build` succeed on an empty skeleton
- [x] 1.2 Create `packages/engine/src/core` and `src/adapters/home-assistant` with an ESLint `no-restricted-imports` rule forbidding core → adapter imports; verify lint fails on a deliberate violating import
- [x] 1.3 Add vitest with a workspace config and a CI workflow (lint, typecheck, test on Node LTS); verify a placeholder test passes locally and in CI
- [x] 1.4 Build a reusable mock Home Assistant WebSocket server for tests (auth flow, `get_states`, `get_config`, `subscribe_events`, `subscribe_trigger`, `call_service`, `fire_event`, `ping`, `history/history_during_period`, `recorder/statistics_during_period`, plus a hook to push events and drop connections); verify with a self-test that a raw WebSocket client can authenticate and call a service

## 2. Configuration (engine-config)

- [x] 2.1 Implement config loading from env with defaults, `_FILE` secret variants, Supervisor detection and aggregated validation errors; verify unit tests for every scenario in `specs/engine-config/spec.md`
- [x] 2.2 Implement redacted effective-config startup logging; verify a test asserting the token never appears in output
- [x] 2.3 Document all environment variables in `README.md` (table with default and description); verify the table matches the config schema via a test that compares documented names with the schema keys

## 3. Logging (engine-observability, part 1)

- [x] 3.1 Implement pino-based logger with levels, `pretty`/`json` formats, token redaction and child loggers per rule ID; verify unit tests for JSON fields, level filtering and `source` tagging

## 4. Home Assistant connection (ha-connection)

- [x] 4.1 Define the `BackendAdapter` interface in core (config, start/stop, status, site info, `createRuleApi(scope)`) and an in-memory fake adapter for core tests; verify typecheck passes with the fake adapter implementing the interface
- [x] 4.2 Implement URL derivation (http→ws, https→wss, Supervisor URL) and the auth handshake; verify tests for `auth_ok`, `auth_invalid` at startup (non-zero exit) and token redaction
- [x] 4.3 Implement request/response correlation with per-request timeouts and rejection of pending requests on disconnect; verify with mock-server tests
- [x] 4.4 Implement reconnect with exponential backoff + jitter, startup wait-for-HA, and auth-invalid-on-reconnect behaviour; verify with tests that drop/refuse connections on the mock server (fake timers)
- [x] 4.5 Implement ping/pong keep-alive and dead-connection detection; verify a test where the mock stops answering pings triggers reconnect
- [x] 4.6 Implement the engine-level subscription registry (shared `state_changed`, ref-counted event types, per-registration `subscribe_trigger`) with replay after reconnect; verify the "event subscription restored" scenario
- [x] 4.7 Implement the state cache (`get_states` on every connect, atomic swap, updates from `state_changed`) and the resync diff (synthetic `resynced` state events after reconnect, none on first connect); verify the cache scenarios and the door-opened-during-restart scenario
- [x] 4.8 Fetch `get_config` and `auth/current_user` after each connect and expose connection status plus connected/disconnected notifications; verify tests for status changes and notification delivery

## 5. SDK surface and rule runtime core (rule-files, rule-lifecycle)

- [x] 5.1 Define the public SDK types in `packages/sdk`: `rule()` and `setup()` (setup options without `mode`, optional `id`), trigger descriptor types, the typed event union (`state`, `event`, `ha-trigger`, `startup`, `time`, `sun`) with `signal` and, on state events, `causedBy`/`causedByEngine`/`causedByRule`/`resynced`/`restored`, rule options, `listen()`, state objects, handles, and empty `HassEntities`/`HassServices` augmentation interfaces; verify type tests that `event.type` narrows correctly, unaugmented IDs are `string` and augmented IDs are narrowed
- [x] 5.2 Implement the registration context (sequential file evaluation slot, per-file rule registry, duplicate-name and outside-evaluation errors, atomic commit after evaluation incl. top-level await and the 30 s evaluation timeout); verify tests for multi-rule files, factory-generated rules, throw-after-register and registration from a callback
- [x] 5.3 Implement the `AsyncLocalStorage` run scope and `RuleScope` (AbortController, per-run child signals, disposer list, LIFO teardowns via `onDispose` or returned function) plus the `invoke` wrapper (error attribution, AbortError swallowing, status updates); verify tests for cleanup, teardown error containment, body error isolation and attribution across `await` chains
- [x] 5.4 Implement rule start (arm triggers for triggered rules, async setup with 30 s timeout for setup rules, free `listen(trigger | triggers, cb)` returning handles and throwing outside setup rules, listeners always parallel) and concurrency modes (`parallel`, `single`, `queued`, `restart`, with `max`: default 10 for `queued`, unlimited for `parallel`, drop + warning when full) in core, tested against fake trigger sources; verify a test per mode and per setup scenario
- [x] 5.5 Implement rule status tracking (`running`/`disabled`/`failed`, last load, last run, last error, per-file status), the `enabled` option and `DISABLED_RULES` glob matching; verify unit tests
- [x] 5.6 Install the process-level `unhandledRejection`/`uncaughtException` safety net and the internal `.catch` for unawaited write promises (log with rule attribution, never exit); verify a test where a rule's floating promise rejects and the engine keeps running

## 6. Rule files and loading (rule-files, rule-lifecycle)

- [x] 6.1 Add the docs type-check script (extracts ```ts blocks from `docs/**/*.md` and `README.md` and compiles them against the SDK types from 5.1); verify it fails on a deliberately broken sample
- [x] 6.2 Implement rule directory discovery with exclusion rules and rule-ID derivation (`<path>#<rule name>`), including the `.ts`/`.js` collision error and the "no rules found" warning for an empty rules directory (engine-config: Empty rules directory); verify tests for all discovery scenarios
- [x] 6.3 Implement the esbuild bundling pipeline (inline local imports, external packages, SDK import rewrite, inline source maps, content-hashed output in `/data/.build`, metafile dependency graph); verify tests that load a TS rule file with enums/interfaces and that a stack trace points at the original `.ts` line, and that a rule reads a custom environment variable via `process.env` (engine-config: Rules can read environment)
- [x] 6.4 Implement the scoped native timer shim injected via esbuild (`setTimeout`/`setInterval`/`clear*` tracked per run scope or file scope); verify tests that a raw `setTimeout` from an old file version never fires after reload and that module-level `clearTimeout` still works
- [x] 6.5 Implement syntax-error reporting (file, line, column) without aborting other files; verify a test with one broken and one valid file
- [x] 6.6 Implement user dependency installation into `/data` (copy manifest, `npm ci`/`npm install --omit=dev`, hash-based skip, read-only `/rules` support, failure tolerance); verify integration tests with a local tarball dependency (no network) and the skip-when-unchanged scenario
- [x] 6.7 Document rule files, `rule()` in both forms, rule IDs (default and explicit `id`), factories/loops, helper modules, timer scoping and user dependencies in `docs/rules/files.md`; verify code samples compile via the docs type-check script

## 7. Hot reload (rule-lifecycle)

- [x] 7.1 Implement the chokidar watcher with debounce, mapping changed files to affected rule files via the metafile graph, and unload → rebuild → load per file; verify tests for edit, delete, add, helper-change and burst-of-saves scenarios
- [x] 7.2 Implement `WATCH_POLL` (`auto` fallback to polling on native watch errors with a warning, forced polling, fallback disabled) and report the active mode in startup log and `/rules`; verify tests that simulate an `ENOSPC` watch error and assert a change is detected within 2 s via polling
- [x] 7.3 Implement the `HOT_RELOAD=false` switch and broken-edit behaviour (unload, log, recover on fix); verify the corresponding scenarios

## 8. State and event triggers (rule-triggers)

- [x] 8.1 Implement trigger constructors as frozen, eagerly validated descriptors (`onChange`, `onEvent`, `onTrigger`, `onStartup`); verify unit tests that constructors subscribe nothing and reject invalid arguments
- [x] 8.2 Implement `onChange` arming with exact IDs, arrays, globs (incl. entities created later), live creation/removal events (undefined old/new state, never matching value filters), `from`/`to` value/array/predicate filters, `ignoreUnavailable` and attribute semantics (`attribute`, `"*"`); each matching trigger fires independently; verify tests for every state-trigger scenario
- [x] 8.3 Implement `for` hold-duration (every change restarts or cancels; per entity or `holdAs: "group"`) and the `immediate` option (evaluated at `listen()` time for late listeners; throws with `for`/`from`); plus hold restoration on rule start from `last_changed`/`last_updated` (skipped with `from`) with a persisted engine-internal fired-holds record keyed by rule ID, trigger identity (position + descriptor, or `listen()` `id`), entity and `last_changed`, pruned when `last_changed` moves on or the rule is gone; plus resync behaviour (resynced holds count from `last_changed`, holds running out while disconnected are re-checked after resync); verify held, interrupted, matching-to-matching restart, flapping-debounce, group, reload-during-hold, elapsed-during-downtime, already-fired, edited-trigger, conditional-listener-id, store-isolation, unavailability-restore, from-filter, disconnect and immediate scenarios with fake timers
- [x] 8.4 Implement `onEvent` with recursive partial data filters (literal/array/predicate leaves), `onTrigger` (native HA triggers; a rejected config keeps the rule `running`, records the error on the trigger and as last error) and `onStartup` (fires on start/reload/re-enable, not on reconnect; in `listen()` only during setup); verify with mock-server tests
- [x] 8.5 Implement `waitFor` (filter, optional `for`, resolves `undefined` on timeout, rejects only on unload/run abort); verify resolve, timeout, already-matching and unload scenarios
- [x] 8.6 Implement `causedBy`/`causedByEngine` (engine user ID) and `causedByRule` (context-ID map from call results, direct context ID only, no `parent_id`, bounded hold of engine-user events with unknown context); verify the feedback-loop, other-rule and manual-change scenarios, including a mock server that sends `state_changed` before the call result
- [x] 8.7 Document triggers, typed events (incl. change cause, resynced and restored events), hold restoration, `listen()` in setup rules, `waitFor` and concurrency modes in `docs/rules/triggers.md`; verify code samples compile via the docs type-check script

## 9. Scheduler (rule-scheduler)

- [x] 9.1 Implement the absolute-time timer primitive (≤ 60 s re-arm, clock-jump and >24.8-day support) and duration parser (exists since 8.1 in `core/duration.ts`; reuse it); verify unit tests with fake clock jumps and a 30-day delay
- [x] 9.2 Implement `sleep` (abort-aware, tied to the run signal), `after` with handles, `randomInt` helper, and the `every` trigger; verify the delay/interval/random-delay scenarios incl. cancellation on unload and on `restart`
- [x] 9.3 Implement the `daily` (with weekdays) and `cron` triggers via croner in the HA/override time zone, with invalid-expression errors; verify DST spring-forward/fall-back tests for `Europe/Berlin` and a time-zone mismatch test
- [x] 9.4 Implement the `sun` trigger (sunrise/sunset/dawn/dusk with offsets, polar-day handling, recompute on site change) and `isSunUp`/`isAfterSunset`/`isBeforeSunrise`/`nextSun`; verify tests with fixed coordinates and dates
- [x] 9.5 Implement next-run reporting (handles and rule status) and the no-replay-of-missed-schedules behaviour; verify the corresponding scenarios
- [x] 9.6 Document scheduling (durations, daily/cron, sun, time zone, DST behaviour) in `docs/rules/scheduling.md`; verify code samples compile via the docs type-check script

## 10. State helpers and actions (ha-actions)

- [ ] 10.1 Implement state reads (`getState`, `getEntity`, `getEntities`, `members`, `getNumber`) and predicates (`is`, `isOn`, `isOff`, `isOpen`, `isClosed` incl. binary_sensor mapping and unavailable handling); verify unit tests for every scenario
- [ ] 10.2 Implement `call` with target support, response data, error mapping and immediate rejection while disconnected; verify mock-server tests for each scenario
- [ ] 10.3 Implement `on`/`off` (skip when already in target state, debug log), `forceOn`/`forceOff`/`toggle` with `homeassistant.*` fallback, and `up`/`down` threshold positioning; verify tests asserting exactly which service calls reach the mock server
- [ ] 10.4 Implement `fire` and the raw WebSocket escape hatch; verify mock-server tests
- [ ] 10.5 Implement REST `setState` (incl. Supervisor base URL), virtual-entity tracking per rule and republish after reconnect; verify tests with a mock REST endpoint
- [ ] 10.6 Implement dry-run interception for calls, events and state writes with rule attribution; verify a test asserting no outgoing message and a `[dry-run] <rule-id> <service>` info log
- [ ] 10.7 Document state helpers, `on` vs `forceOn`, `up`/`down` (incl. HA position semantics vs. openHAB), virtual-entity limitations (incl. the `onStartup` + `store` pattern for values at boot) and dry-run in `docs/rules/actions.md`; verify code samples compile via the docs type-check script

## 11. History (ha-history)

- [ ] 11.1 Implement time-argument parsing (Date, ISO, duration-ago) and `history`, `stateAt`, `lastChangedTo` on `history/history_during_period`; verify mock-server tests for the switch-history, historic-state and arrival-time scenarios
- [ ] 11.2 Implement time-weighted `averageSince`, `minimumSince`, `maximumSince` with exclusion of non-numeric states and statistics fallback for ranges older than retained history; verify the 10/20 → 12.5 scenario, the all-unavailable scenario and the retention-fallback scenario
- [ ] 11.3 Implement `changeSince` and `statistics` on `recorder/statistics_during_period`, plus recorder-missing errors and once-per-entity warnings for unrecorded entities; verify mock-server tests
- [ ] 11.4 Document history queries in `docs/rules/history.md`; verify code samples compile via the docs type-check script

## 12. Storage (rule-storage)

- [ ] 12.1 Implement per-rule and shared key/value stores with JSON-serialisability checks, debounced atomic flush (tmp + fsync + rename), flush on shutdown and corrupted-file quarantine; verify unit tests for isolation, persistence across a simulated restart, reload survival and corruption handling
- [ ] 12.2 Document storage in `docs/rules/storage.md`; verify code samples compile via the docs type-check script

## 13. HTTP endpoints (engine-observability, part 2)

- [ ] 13.1 Implement `node:http` server with `/health/live` (incl. event-loop-lag check), `/health/ready` and `/rules` (including engine metadata such as the active watch mode from `HotReloader.mode`), plus `HTTP_PORT=0` disable; verify HTTP tests for each endpoint state
- [ ] 13.2 Implement engine activity logging (connection transitions, load summary, debug trigger/service-call traces); verify log-capture tests for the startup summary and debug traces

## 14. Engine bootstrap and shutdown

- [ ] 14.1 Wire the startup sequence (config → logger → deps install → connect → load rules → watcher → HTTP ready) in `packages/engine` CLI entry, including the fired-holds record (`<DATA_DIR>/fired-holds.json`: load before rules start, pass to the state trigger source, `pruneRules()` after the initial load, flush on shutdown); verify one end-to-end test booting core with the fake adapter (reports ready, loads a rule) and one against the HA mock server loading an example rule that turns on a light
- [ ] 14.2 Implement graceful shutdown on SIGTERM/SIGINT (stop triggers, teardowns, storage flush, close socket, 10 s hard limit naming the blocking rule); verify tests sending signals to a spawned engine process

## 15. Typings generator (rule-files)

- [ ] 15.1 Implement `typegen` CLI (`get_states` + `get_services` → `.d.ts` module augmentation with entity IDs, domains, service fields); verify a snapshot test against mock-server data and a type test where an unknown entity ID fails to compile
- [ ] 15.2 Document typings generation (local `npx` and in-container usage); verify the documented commands run against the mock server

## 16. Container image (container-image)

- [ ] 16.1 Write the multi-stage Dockerfile (slim LTS base, tini entrypoint, non-root `node` user, `/data` volume, OCI labels incl. `licenses=MIT`, `/rules` mount point, node-based HEALTHCHECK, typegen included); verify `docker build` succeeds and `docker run --user 1234` starts with writable mounts
- [ ] 16.2 Verify read-only `/rules` mount with a `package.json`, unwritable `/data` failure message, and `docker stop` graceful exit code 0 via a container smoke-test script run in CI
- [ ] 16.3 Add buildx multi-arch (amd64, arm64) release workflow publishing semver tags + `latest`, with a compressed-size budget check (< 150 MB); verify a dry-run workflow build produces both platform manifests
- [ ] 16.4 Add `docker-compose.yml` example and `examples/rules` (motion light with `for`, sunset cover with `sun`, factory-generated rules, setup counter with storage, history-based average); verify the quick-start scenario manually against a real or containerised Home Assistant and record the result

## 17. Getting-started guide

- [ ] 17.1 Write the top-level `README.md` quick start (compose, token creation, first rule, trusted-code warning) plus openHAB-to-home-engine (incl. `@ds82/openhab` → SDK mapping: `addRule`, `changeStateTrigger`, `timeTrigger`, `setTimeout` patterns, `sumSince`…) and AppDaemon-to-home-engine cheat sheets linking the per-area docs; verify code samples compile via the docs type-check script

## 18. Integration verification

- [ ] 18.1 Run the full end-to-end suite against a containerised Home Assistant (`ghcr.io/home-assistant/home-assistant` with onboarding automated, token created) covering connect, HA restart/reconnect, state trigger, service call, hot reload and shutdown; verify all pass in CI
- [ ] 18.2 Run a load test with 5k entities and 100 state changes/s against the mock server with 50 rules; verify event-processing latency p99 < 50 ms and record results in `docs/performance.md`
