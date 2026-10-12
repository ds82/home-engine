# Proposal

## Why

Home Assistant users who want to write automations as real code can use AppDaemon, but it is Python-only. Many people who write automations are TypeScript/JavaScript developers. They want type-safe, editor-assisted rules without YAML automations or Node-RED flows. This project, **home-engine**, provides an AppDaemon-like rule engine for TypeScript/JavaScript. It ships as a Docker image and runs the user's own rule files against Home Assistant.

## What Changes

- New standalone rule engine process (Node.js LTS runtime, see design.md for the Node vs. Bun decision). It connects to Home Assistant over the WebSocket API and authenticates with a long-lived access token.
- Rule file format: users drop `.ts` / `.js` / `.mts` / `.mjs` files into a rules directory. TypeScript is transpiled by the engine, so users need no build step.
- Rule DSL, modelled on the maintainer's existing openHAB DSL (`@ds82/openhab`) and its proven `addRule(name, body, triggers)` pattern:
  - **Registration:** `rule(name, triggers, body, options?)` called at the top level of a file. A file holds any number of rules, and loops/factory functions can generate rules dynamically. A second kind, `setup(name, fn)`, supports rules with local state that register listeners imperatively. An optional `id` gives a rule a stable ID that survives moving its file.
  - **Triggers** as composable values: `onChange` (with `from` / `to` / attribute filters and a `for` hold duration that survives reloads and restarts), `onEvent`, native Home Assistant triggers, `onStartup`, `cron`, `daily`, `every`, `sun` (with offsets). Any trigger in a rule's list fires it, and the body receives a typed event.
  - **Free helper functions** from a single SDK import: state reads and predicates (`getState`, `isOn`, `isOpen`, …); idempotent `on`/`off` (only send when the state differs) versus `forceOn`/`forceOff` (always send); threshold-based `up`/`down` for covers; `call`, `fire`, `setState`; `listen` (setup rules only); `sleep`, `after`, `waitFor`; `log`, `store`, `shared`. The engine attributes every call to the running rule automatically.
  - **History queries:** state history, state at a point in time, last change to a value, time-weighted average/min/max, change of cumulative meters, and long-term statistics.
  - Concurrency modes per rule (`parallel`, `single`, `queued`, `restart`) and automatic cleanup of every listener and timer, including plain `setTimeout`/`setInterval`, when a rule is unloaded.
- An SDK/types package so rule authors get autocompletion and type checking in their editor. An optional command generates entity-ID/service typings from a live Home Assistant instance.
- Hot reload: when files in the rules directory are added, changed or removed, the engine reloads only the affected rules, without restarting the engine. It uses native file watching (inotify), falls back to polling automatically when that is unavailable, and polling can be forced with `WATCH_POLL=true`.
- Fault isolation: a throwing rule (at load time or inside a callback) is logged and does not crash the engine or other rules.
- Robust connection handling: reconnect with backoff, re-subscribe, refresh the state cache, deliver changes missed during a disconnect as synthetic events, and expose connection status to rules.
- User npm dependencies: a `package.json` in the rules directory is installed at startup, so rules can import third-party packages.
- Configuration through environment variables, with Docker-secrets support (`*_FILE` variants) for the token.
- Observability: structured logging (pretty or JSON) with a configurable level, plus an HTTP health/readiness endpoint used by the Docker `HEALTHCHECK`.
- Dry-run mode that logs service calls instead of executing them, for safe testing against a production Home Assistant.
- Multi-arch (amd64, arm64) Docker image that runs as a non-root user, with `/rules` and `/data` volumes and graceful shutdown on SIGTERM.
- Internal split into a backend-neutral core and a Home Assistant backend adapter, so other smart-home systems can be supported later. Only Home Assistant is in scope for this change.
- Auto-detection of Home Assistant add-on (Supervisor) mode: if `SUPERVISOR_TOKEN` is present, the engine connects without a manually created token.

## Capabilities

### New Capabilities

- `ha-connection`: WebSocket connection to Home Assistant: authentication (long-lived token, Supervisor token), reconnect/backoff, re-subscription, state cache and connection status.
- `rule-files`: How rule files are discovered, transpiled and loaded; rule registration with `rule()` (triggered rules) and `setup()` (setup rules); rule identity (file + rule name, or an explicit ID); the single-import SDK with free functions; typed events; user npm dependencies; generated typings.
- `rule-lifecycle`: Atomic file evaluation, rule start and teardown, automatic resource cleanup (including native timers), hot reload and watch modes, enable/disable, and error isolation between rules.
- `rule-triggers`: Trigger constructors for state changes (filters, attributes, hold-for-duration with restoration on start), bus events, native Home Assistant triggers and startup; change cause (`causedBy`, `causedByRule`); synthetic events after resync; `waitFor`; concurrency modes.
- `rule-scheduler`: Time-based triggers (cron, daily, interval, sun with offsets), `sleep`/`after`, durations, sun helpers, and time zone/DST handling.
- `ha-actions`: State reads and predicates, `on`/`off` versus `forceOn`/`forceOff`, `up`/`down` for covers, service calls (incl. response data), events, virtual entity state, dry-run.
- `ha-history`: Queries against Home Assistant's recorder and long-term statistics: history, state at a time, last change to a value, numeric aggregates, cumulative change.
- `rule-storage`: Per-rule persistent key/value storage that survives restarts and reloads.
- `engine-config`: Engine configuration via environment variables and secret files, validation, and fail-fast behaviour.
- `engine-observability`: Logging (levels, formats, per-rule logger names) and the HTTP health/readiness endpoint.
- `container-image`: Docker image contract: supported architectures, volumes, non-root user, health check, signal handling and graceful shutdown.

### Modified Capabilities

None. This is a greenfield project.

## Impact

- License: MIT.
- Naming: npm packages `@home-engine/engine` (command `home-engine`), `@home-engine/sdk` and `@home-engine/typegen`, container image `ghcr.io/home-engine/home-engine`.
- New repository content: engine source (TypeScript, split into backend-neutral core and Home Assistant adapter), SDK/types package, Dockerfile, CI for multi-arch image builds, example rules and documentation.
- External dependencies: Home Assistant WebSocket API (and the REST API for setting virtual entity state), plus a small set of npm libraries (WebSocket client if not native, transpiler, cron parser, sun calculation, file watcher, logger). Final choices are in design.md.
- Users must provide a reachable Home Assistant URL and a long-lived access token (unless running as an add-on), plus mounted rules and data directories.
