# Design

## Context

This is a greenfield repository (see proposal.md for motivation). The project is named **home-engine**. The name is deliberately not tied to Home Assistant or to a language, because other smart-home backends may be supported later (see D13). The reference point is AppDaemon, a Python app runtime for Home Assistant. The checkout at `../app-appdaemon` is the Home Assistant add-on wrapper for AppDaemon, not AppDaemon itself. It shows two patterns we adopt: Supervisor-token auto-configuration (no manual URL/token in add-on mode), and user-installable extra packages at startup. The specs under `specs/` define the required behaviour. This document covers how to build it.

Constraints:
- Rule files are user-provided and trusted code. They run with the engine's privileges.
- Rules must be authored in TypeScript without a user build step, and edited live (hot reload).
- The engine runs 24/7 on small hardware (Raspberry Pi class, arm64) as well as amd64 servers.

## Goals / Non-Goals

**Goals:**
- A small, dependable engine core: one process, one Home Assistant connection, and a per-rule resource scope with guaranteed cleanup.
- A backend-neutral core with Home Assistant as the first and only backend adapter, so other smart-home systems (openHAB, ioBroker, …) can be added later without restructuring the engine (D13).
- An ergonomic, strongly typed rule API that feels native to TypeScript developers (async/await, AbortSignal, handles).
- Fast edit-save-run loop through hot reload.
- A container image that works with plain `docker run`, Compose, Kubernetes and (via Supervisor detection) as an add-on.

**Non-Goals (this change):**
- Web UI / dashboard (AppDaemon's HADashboard equivalent).
- Sandboxing untrusted rule code. Rules are trusted; the engine isolates *errors*, not *privileges*.
- Hard isolation against CPU-bound infinite loops in rules (see Risks).
- Multiple Home Assistant instances / namespaces, MQTT or other plugins.
- Any backend other than Home Assistant, and a backend-neutral rule API. The adapter seam (D13) is an internal structure only; no specified behaviour promises multi-backend support.
- AppDaemon API compatibility or YAML-configured app instances with `args`. In TypeScript, users write a factory function instead (see the example).
- A rule unit-testing harness with a mocked Home Assistant. Planned as a follow-up change; the internal mock server built for our own tests is designed so it can become that harness.
- The Home Assistant add-on repository manifest (`config.yaml`, add-on store packaging). Supervisor mode is supported at runtime; packaging comes in a follow-up change.

## Decisions

### D1: Runtime: Node.js (Active LTS) over Bun

**Decision:** Target the current Node.js Active LTS (24.x now, 26.x once it reaches LTS). Keep the code free of Node-only APIs where cheap, so Bun stays a possible later option, but test and ship Node only.

**Why:**
- **24/7 stability:** Node's long-running-process behaviour, memory profile and `ws`/`http` stack have years of production use. Bun is fast, but its Node-compat layer still has edge cases (worker threads, `fs.watch`, signal handling as PID 1). These are exactly the parts a daemon depends on.
- **Bun's main advantage, native TS execution, does not matter here:** we transpile with esbuild anyway (see D3), because we need bundling for hot reload and dependency-graph tracking. Bun's runtime would not remove that need.
- **Ecosystem and tooling:** debugging (`--inspect`), heap snapshots, official multi-arch images, and long LTS windows with predictable security updates.
- **Native WebSocket client and `fetch`** are built into Node ≥ 22, so the dependency count stays low.

**Alternatives considered:**
- *Bun:* faster startup and simpler TS story, smaller dev-time toolchain. Rejected for now due to compat risk in watch/worker/signal paths and a shorter support track record. Startup time is irrelevant for a daemon.
- *Node native type stripping (`--experimental-strip-types`):* no enums/namespaces/parameter properties, requires explicit `.ts` import extensions, and offers no help with hot reload. esbuild covers all TS syntax.

### D2: Package layout: npm workspaces monorepo

```
packages/
  engine/                      # the daemon (npm: home-engine, also the image's entrypoint)
    src/core/                  # backend-neutral: config, logging, loader, hot reload, rule scope,
                               #   scheduler, storage, http, bootstrap/shutdown
    src/adapters/home-assistant/  # HA connection, state cache, triggers, writes, typegen data source
  sdk/                         # @home-engine/sdk: public types + free-function API; runtime impl lives in engine
  typegen/                     # CLI: connect to HA, emit .d.ts that augments sdk types (also shipped in the image)
examples/rules/
docker/                        # Dockerfile, compose example
```

Tooling: TypeScript strict, `tsup` (esbuild) for building packages, `vitest` for tests, ESLint + Prettier, GitHub Actions with `docker buildx` for multi-arch.

License: **MIT** for all packages and the image (`LICENSE` at the repository root, `license` field in every `package.json`, `org.opencontainers.image.licenses=MIT` label).

Names: npm packages `home-engine` (engine/CLI) and `@home-engine/sdk`; GitHub organisation `home-engine` (repository `home-engine/home-engine`); container image `ghcr.io/home-engine/home-engine`. The core/adapter split lives in directories inside `packages/engine` rather than separate packages. That keeps versioning and the release simple, and an ESLint `no-restricted-imports` rule enforces the boundary (D13).

### D3: Rule loading: per-file esbuild bundle + content-hashed dynamic import

Node's ESM loader cannot evict modules, so plain `import()` cannot reload a changed file. For each rule file, the loader:
1. Bundles it with esbuild (`format: esm`, `platform: node`, `bundle: true`, `packages: external`, `sourcemap: inline`). Local imports (helpers such as `_lib/*.ts`) are inlined. Bare package imports stay external.
2. Rewrites the SDK import (`@home-engine/sdk`) to the engine's own SDK runtime entry with an esbuild plugin. All rules then share the engine's singleton implementation, and users never need the SDK installed in the container.
3. Writes the output to `/data/.build/<relative-path>.<contenthash>.mjs` and loads it with `import()`. A new hash gives a new module URL, so the reload picks up fresh code.
4. Uses esbuild's `metafile` to record which source files each bundle includes. A change to any source file triggers a rebuild of exactly the rule files whose bundles contain it (this covers the "helper module edited" scenario).

Bare imports resolve by walking up from `/data/.build/…`, so user dependencies installed at `/data/node_modules` (D9) resolve naturally. A `node_modules` in `/rules` is ignored.

Inline source maps plus `process.setSourceMapsEnabled(true)` make stack traces point at the user's original `.ts` lines.

**Trade-off:** old module instances stay in memory after a reload (a small leak per reload). Rule bundles are small, and reloads are a development-time activity. We document it and may revisit with D3-alt.

**Alternatives considered:**
- *Query-string cache busting without bundling:* changed helpers are not picked up (transitive modules stay cached). Rejected.
- *D3-alt: one `worker_thread` per rule file:* true unloading and CPU isolation. But every worker needs a replica of the state cache for synchronous reads, plus message passing for every call. Much more complex; kept as a future option behind the same rule-context interface.
- *`tsx` / `ts-node` loaders:* still bound by the ESM cache limitation.

### D4: Rule DSL: registration-style `rule()`, trigger values, free functions

The DSL follows the maintainer's existing openHAB DSL (`@ds82/openhab`, ~85 rules in production). Its `addRule(name, body, triggers)` pattern, its free helper functions and its `on`/`forceOn` distinction have proven themselves. What changes: TypeScript types, triggers listed *before* the body (so they stay visible above long bodies), options objects instead of positional `from`/`to`, and built-in replacements for hand-written `setTimeout` patterns.

```ts
import { rule, setup, listen, onChange, onStartup, cron, daily, sun, isOn, isClosed, on, forceOn, forceOff,
         down, sleep, randomInt, getNumber, averageSince, call, log } from "@home-engine/sdk";

rule("Apple Lampe zusammen mit Monitoren schalten",
  onChange("switch.kg_az_computer_links_peripherie"),
  () => isOn("switch.kg_az_computer_links_peripherie") ? forceOn("light.kg_apple") : forceOff("light.kg_apple"));

// was: module-level timer + clearTimeout + setTimeout
rule("Rasenbewässerung nach 20 min aus",
  onChange("switch.lawn_watering", { to: "on", for: "20m" }),
  () => forceOff("switch.lawn_watering"));

// was: setTimeout + re-check; now cancelled automatically on reload
rule("rollershutter-down-nighttime-if-absent", cron("13 22 * * *"), async () => {
  if (!isClosed("binary_sensor.presence_any")) return;
  await sleep(`${randomInt(1, 30)}m`);
  if (isClosed("binary_sensor.presence_any")) await on("input_boolean.at_sleep");
});

// several triggers, typed event
rule("rollershutter-bath", [onStartup(), onChange(["binary_sensor.bath_tilt", "binary_sensor.bath_open"], { for: "30s" })],
  (event) => { if (event.type === "state") log.info(`${event.entityId} -> ${event.to.state}`); /* ... */ down("cover.bath", 0); },
  { mode: "restart" });

// factories / loops (unchanged from openHAB style)
for (const [who, entity] of [["Dennis", "person.dennis"], ["Lydia", "person.lydia"]] as const) {
  rule(`presence-${who}-notification`, onChange(entity, { to: "home" }),
    () => call("notify.telegram_group", { message: `${who} ist Zuhause!` }));
}

// setup rule for local state
setup("doorbell burst counter", () => {
  let presses = 0;
  listen(onChange("binary_sensor.doorbell", { to: "on" }), () => { presses++; });
  listen(daily("00:00"), () => { presses = 0; });
});
```

**Trigger values.** `onChange(...)`, `cron(...)` and the other constructors return plain, frozen descriptor objects (`{ kind: "state", entities, from, to, for, … }`). They validate their arguments eagerly (bad cron → throws at the call site) but subscribe nothing. Arming happens only when the engine starts the rule, so the same vocabulary serves `rule()` and `listen()`, and the descriptors are trivially unit-testable.

**Registration context.** The loader evaluates rule files **sequentially**. While a file is evaluated (including top-level `await`), a module-level "current file" slot in the SDK runtime points at that file's registry. `rule()` and `setup()` read this slot and throw when it is empty. We deliberately do not rely on `AsyncLocalStorage` propagation into dynamic `import()` evaluation, because that behaviour is not guaranteed. After evaluation the registry is committed atomically (spec: file evaluation is atomic).

**Run attribution with `AsyncLocalStorage`.** Every rule body, setup function and listener callback runs inside `als.run(runScope, fn)`. The context propagates through `await`, promises, `setTimeout` and event emitters created inside, so free functions (`on`, `sleep`, `log`, `store`, …) look up `als.getStore()` to find the calling rule. This attributes logs, dry-run output and errors, registers disposers in the right `RuleScope`, and links `sleep`/`waitFor` to the current run's `AbortSignal`. If a function that creates resources (`sleep`, `after`, `waitFor`) is called with no scope (e.g. from a third-party library callback that loses async context), it throws a clear error. Pure reads (`getState`, `isOn`) work without a scope.

**Per-rule resource scope.** Each started rule has a `RuleScope`, which owns an `AbortController` plus a disposer list. Each run of a body gets a child `AbortController` (used by `restart` mode). Unloading runs user teardowns (LIFO) → aborts the signal → runs disposers. All bodies go through one `invoke(scope, fn)` wrapper. It applies the concurrency mode, catches sync throws and async rejections, swallows `AbortError`s caused by the engine's own aborts, and updates rule status. A process-level `unhandledRejection` handler logs rejections (attributed via the ALS store where present) and never exits. Unawaited write promises get an internal `.catch` that logs with rule attribution.

**Scoped native timers.** The esbuild step (D3) injects a shim module (`inject` option). It replaces the free identifiers `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval` in rule files and inlined local modules with versions that record the timer in the current scope (ALS run scope, or the file scope during evaluation) and clear it on unload. This makes migrated openHAB code with raw `setTimeout` reload-safe. Third-party packages in `node_modules` are external and keep the real globals. That is documented.

**Rule kinds and concurrency.** Only triggered rules have a `mode`, because one body is the natural unit for "don't overlap". Listeners registered with `listen()` in a setup rule always run in parallel. Authors who need ordering between listeners use a triggered rule, or coordinate explicitly inside the closure.

**Stable IDs.** The default ID `<path>#<name>` needs no ceremony, but moving a file changes it, which orphans stored values and breaks `DISABLED_RULES` patterns. The optional `id` option replaces the default ID. It must be globally unique and contain no `#`, so the two forms can't collide. Uniqueness is checked at file commit time against all loaded files.

**Hold restoration.** `for` holds are timers, so a reload or restart would silently drop "on for 10 minutes → off" logic, the most common pattern in the migrated openHAB rules. On rule start the engine rebuilds them from the cached `last_changed` (`last_updated` for attribute triggers) and schedules the remaining time. Holds with a `from` filter are skipped, because the cache can't prove which state came before. A hold whose duration already passed would fire again on every reload (a door open for days would re-notify on each edit of the file), so the engine persists a small "fired holds" record keyed by rule ID, trigger identity (position + descriptor hash), entity and the `last_changed` it counted from, and skips holds already in it. Editing a trigger changes its identity, so it counts as new. Entries are pruned once the entity's `last_changed` moves on. The record is engine-internal (its own file in the data directory, not part of `store`/`shared`). Conditionally registered listeners can pass `listen(…, { id })` for a stable identity. Known limitation: with `ignoreUnavailable`, a restored hold counts from HA's `last_changed`, i.e. from the end of the last unavailability, so it can fire late after a reload; a history query on every restore was judged not worth it. `immediate` is rejected together with `for` or `from`: restoration already covers held states, and there is no old state to check a `from` against. Time triggers (`daily`, `cron`) are still not replayed: a missed 07:00 run is a different decision from a hold that was already in progress.

**`on` vs `forceOn`.** `on`/`off` decide from the local state cache, so a command sent a few milliseconds earlier and not yet reflected in the cache can lead to a duplicate. This is harmless, because Home Assistant's services are idempotent. `forceOn`/`forceOff` exist for "set attributes regardless" and for devices whose reported state may be stale.

**Alternatives considered:**
- *Exported functions as rules (previous draft):* rejected. Rules can't be generated in loops or factories without awkward named exports, and it diverges from the proven openHAB DSL.
- *Only a context parameter (`ctx.isOn(...)`) and no free functions:* explicit, but noisy in every line. ALS gives the same attribution invisibly. There is no `ctx` at all: setup rules register listeners with the free function `listen()`, which finds its rule through the ALS run scope. A `ctx.on()` was rejected because it clashes with the switching function `on()`.
- *One overloaded `rule()` for both kinds (previous draft):* the two forms differed only by the type of the second argument, which is easy to misread, and error messages for invalid options had to explain the overload. A separate `setup()` makes the kind visible and lets its options type omit `mode`. "Rule" stays the umbrella term: both kinds share IDs, status, storage and `DISABLED_RULES`.
- *Fluent builder (`when(...).changes().then(...)`):* more API surface and harder to type for multi-trigger rules than plain arrays of trigger values.

### D5: Home Assistant client: own thin client on Node's native WebSocket

We use a purpose-built client (~500 LOC) instead of `home-assistant-js-websocket`. The library targets browsers, gives up permanently on `auth_invalid` during reconnect, and does not let us control the ping/pong and re-subscription ordering the specs require. We may still reuse its *type definitions*.

- Message ID allocation and a pending-request map with per-request timeout. All pending requests are rejected on disconnect.
- Subscription registry that is *engine-level*, not rule-level. All rules share one `subscribe_events(state_changed)` subscription, demultiplexed locally against the rule matchers. `onEvent` subscriptions are reference-counted per event type. `subscribe_trigger` is one HA subscription per registration. After a reconnect the registry replays all subscriptions, then calls `get_states` and swaps the cache atomically, and only then reports ready.
- We use `subscribe_events` on `state_changed` (full old/new objects) rather than `subscribe_entities` (compressed diffs): simpler, and HA computes the diff anyway.
- Ping every 30 s, with a 10 s pong timeout.
- `auth/current_user` after auth gives the engine's user ID. A state change whose `context.user_id` is the engine user has `causedBy: "engine"`.
- `causedByRule`: every `call_service` result returns the context HA created for the call. The client keeps a short-lived map (context ID → rule ID, ~10 s TTL), filled by the write layer. A state change whose `context.id` is in the map gets that rule ID. `context.parent_id` is deliberately ignored: a Home Assistant automation reacting to an engine write is `external`, so "engine" always means "this engine wrote exactly this" (what loop prevention needs), and `causedByRule` never appears on an external event. Because HA can deliver the resulting `state_changed` before the call's result message, a state event from the engine user with an unknown context ID is held until in-flight writes have resolved (at most 1 s), then dispatched with or without `causedByRule`. Only engine-caused events see this delay.
- Resync after reconnect: before swapping the cache, the client diffs old and new snapshots (state and attributes) and passes the differences to the dispatcher as synthetic `state` events with `resynced: true`. This is skipped on the first connect, where `onStartup` and `immediate` cover the initial state. Holds started by resynced events count from the new state's `last_changed`. Hold timers that run out while disconnected are deferred and re-checked against the fresh cache after the resync (fire if the state still matches with the same `last_changed`, otherwise drop).
- `get_config` gives time zone, lat/lon/elevation for the scheduler, and the HA version for logs.
- `setState` uses the REST API (`POST /api/states/<id>`; in Supervisor mode `http://supervisor/core/api`), because WebSocket has no state-write command. The engine keeps a map of virtual entities per rule for republishing after an HA restart, and drops entries when the rule unloads.

### D15: History queries

History functions map to Home Assistant's WebSocket API: `history/history_during_period` (with `minimal_response`, `no_attributes` and the entity filter) for `history`, `stateAt` and `lastChangedTo`, and `recorder/statistics_during_period` for `statistics` and `changeSince`. Time-weighted average/min/max are computed locally from the history response, which is exact and consistent with the spec's 10/20 → 12.5 example. When the requested start lies before the oldest retained history (determined from the first returned row / recorder info), the part before is filled from hourly long-term statistics. `changeSince` uses the statistics `change` type, which already handles meter resets. Results are not cached. Rules that need frequent aggregates should keep their own state.

### D6: Scheduler

- **Cron and daily times:** `croner` (zero-dependency, time-zone aware, handles DST correctly, supports 5/6-field). Daily times with weekdays compile to cron expressions, so DST behaviour comes from one implementation.
- **Sun events:** `suncalc`, using HA's lat/lon. Each day's next event is computed after the previous one fires, and recomputed when HA config changes (`core_config_updated` event).
- **Timer primitive:** every timed wait targets an absolute epoch time and arms `setTimeout(min(remaining, 60 s))`, re-checking `Date.now()` on each wake. This covers clock jumps, host suspend, and the 24.8-day `setTimeout` limit in one place.
- **Duration parsing:** a small own parser (`"1h30m"`, `"45s"`, `"500ms"`, plain numbers = ms) with strict validation.

### D7: Logging: pino

`pino` for structured JSON (fast, low allocation). `pino-pretty` is used in-process when `LOG_FORMAT=pretty`. The per-rule logger is a pino child with `{ rule: id }`. A redaction list covers token fields.

### D8: Storage: one JSON file per namespace, atomic writes

`/data/storage/<encoded-rule-id>.json` plus `/data/storage/_shared.json`, kept in memory. Writes mark a namespace dirty. A flush (debounced, ≤ 1 s, and on shutdown) writes `tmp` → `fsync` → `rename`. No native dependencies, inspectable by humans, and enough for small key/value data. `node:sqlite` was considered, but it is still marked experimental / release-candidate and would be overkill.

### D9: User dependencies under /data

At startup, if `/rules/package.json` exists: copy `package.json` (+ lockfile) to `/data/deps/`. Then run `npm ci --omit=dev` (or `npm install --omit=dev` without a lockfile) there, with `node_modules` at `/data/node_modules` via a symlinked prefix layout. A SHA-256 of `package.json` + lockfile is stored in `/data/deps/.installed-hash`, and installation is skipped when it is unchanged. Keeping this out of `/rules` allows a read-only rules mount and avoids host-architecture `node_modules` leaking in. Changes to `package.json` at runtime log a hint that a restart is needed. Dependency hot-install is out of scope.

### D10: HTTP: node:http

Three GET routes, no framework. Liveness also checks event-loop lag (via `perf_hooks.monitorEventLoopDelay`). If lag exceeds 5 s, liveness returns 503, so Docker can restart a container stuck in a rule's infinite loop.

### D14: File watching: chokidar with polling fallback

`chokidar` (v4) watches `RULES_DIR` with native `fs.watch` (inotify on Linux). With `WATCH_POLL=auto` (default), an error while setting up or running native watching (`ENOSPC` = inotify watch limit, `ENOSYS`/`EPERM`/`EMFILE`, unsupported file system) tears down the native watcher. A new watcher is then started with `usePolling: true` and a 1 s interval, and a warning is logged with the reason. `WATCH_POLL=true` starts in polling mode directly. `WATCH_POLL=false` treats a native failure as "hot reload unavailable" (error log, rules keep running). All modes feed the same debounced change pipeline (D3 dependency graph). The active mode is reported in the `/rules` endpoint's engine metadata and in the startup log.

### D11: Container

- Multi-stage Dockerfile: build stage (`node:<lts>-bookworm`) → runtime stage `node:<lts>-bookworm-slim`. We use `-slim` rather than Alpine: user npm packages with prebuilt binaries more often target glibc.
- `tini` as the entrypoint for signal forwarding and zombie reaping. The image runs as the `node` user (UID 1000), works with arbitrary `--user`, and keeps `/data` group-writable.
- `HEALTHCHECK CMD node /app/healthcheck.js` (no curl in the image).
- `VOLUME ["/data"]`. `/rules` is expected to be bind-mounted.
- The `typegen` CLI is included, so it can run as `docker run --rm -e HA_URL -e HA_TOKEN image typegen > ha-types.d.ts`.
- Buildx for `linux/amd64,linux/arm64`, published to GHCR on tags. A CI step checks the compressed size budget.

### D12: Typed entities via module augmentation

The SDK declares an empty `interface HassEntities {}` and `interface HassServices {}`. When they are empty, entity-ID parameters are `string`. When augmented, they are `keyof HassEntities`. `typegen` emits `declare module "@home-engine/sdk" { interface HassEntities { "light.kitchen": LightState; … } }`, including service field names from `get_services`. Users commit or regenerate the file. The runtime does not depend on it.

### D13: Backend adapter seam (Home Assistant as the first adapter)

**Decision:** Split the engine internally into a backend-neutral **core** and **backend adapters**. Ship exactly one adapter, Home Assistant. The core never imports adapter code. The adapter depends only on the core's adapter interface.

**Core vocabulary.** The core uses neutral terms that every smart-home backend can map onto: **Entity** (something with an ID, a state and attributes; an openHAB Item maps onto it), **Service call** (a command sent to the backend), **Event** (a message on the backend's event bus) and **Site** (the location context the backend provides: time zone, coordinates, units). The term "action" is avoided because it means different things in Home Assistant and openHAB. `CONTEXT.md` holds the glossary.

**Core owns** (no backend knowledge): config loading, logging, rule discovery/bundling/hot reload, `RuleScope` and error isolation, concurrency modes, the scheduler (timers, cron, sun math), storage, HTTP endpoints, bootstrap and graceful shutdown.

**An adapter implements** a small interface, roughly:

```ts
interface BackendAdapter {
  readonly id: string;                              // "home-assistant"
  readConfig(env: Env): AdapterConfig | ConfigError[];   // its own env vars, validated with core's fail-fast reporting
  start(signal: AbortSignal): Promise<void>;        // connect; resolves after first successful connect + initial sync
  stop(): Promise<void>;
  status(): { connected: boolean; details: Record<string, unknown> };  // feeds /health/ready
  onStatusChange(cb: (connected: boolean) => void): Disposable;
  site(): SiteInfo | undefined;                     // the Site: time zone, lat/lon/elevation, units → core scheduler & sun
  onSiteChange(cb: () => void): Disposable;
  createRuleApi(scope: RuleScope): object;          // backend-specific SDK functions for this scope
}
```

- `createRuleApi` receives the rule's scope, so every subscription the adapter creates registers its disposer there. Automatic cleanup, `restart`-mode aborts and error attribution then work identically for any adapter. The adapter routes callbacks through the core's `invoke` wrapper and never calls user code directly.
- Dry-run is enforced inside the adapter's write layer, because only the adapter knows what an outgoing write is. The core provides the flag and the `[dry-run]` logging helper.
- `typegen` takes its entity/service data through an adapter-specific source. Only Home Assistant exists now.

**SDK shape:** the SDK's free functions come from two sources. Core provides `rule`, `setup`, `listen`, `onStartup`, `cron`, `daily`, `every`, `sun`, sun helpers, `sleep`, `after`, `log`, `store`, `shared` and `onDispose`. The Home Assistant adapter provides `onChange`, `onEvent`, `onTrigger`, `waitFor`, state reads and predicates, `on`/`off`/`forceOn`/`forceOff`/`toggle`/`up`/`down`, `call`, `fire`, `setState`, history functions, `ws` and `connection`. At runtime each adapter function resolves its adapter through the ALS run scope. All are exported **flat** from `@home-engine/sdk`, because with a single backend a namespace is pure noise. If a second backend ever arrives, its functions would live in a subpath export (`@home-engine/sdk/openhab`), and `@home-engine/sdk/home-assistant` would become an alias of today's flat exports. That is additive, with no breaking change for existing rules. Its design comes from the real backend's needs at that time.

**Why now:** the seam costs little (one interface, a directory boundary, a lint rule) and improves testability. The core can be tested against a fake adapter, without the HA mock server. Retrofitting it later would touch every module.

**Alternatives considered:**
- *A backend-neutral rule API now* (generic "items/devices" instead of entities/services): rejected. It would be a lowest common denominator, lose Home Assistant's typed entity/service model, and guess at requirements of backends nobody has asked for yet.
- *No seam (HA everywhere):* simplest today, but makes a later second backend a rewrite and couples core tests to HA.
- *Separate npm packages per adapter now:* more release overhead with no consumer yet. A directory plus lint rule gives the same boundary, and it can be split into packages when a second adapter exists.

## Risks / Trade-offs

- [A CPU-bound infinite loop in a rule blocks the whole engine] → Event-loop-lag-aware liveness (D10) makes Docker restart the container. This is documented. Worker isolation (D3-alt) remains a future option.
- [Memory growth from repeated hot reloads (ESM cache)] → Bundles are small. We log the reload count and document that a restart reclaims memory. We can revisit with workers.
- [`state_changed` subscription on large installations (thousands of entities, chatty sensors) creates CPU load] → Local matching uses an exact-ID map first and glob patterns second (compiled once). We benchmark with 5k entities / 100 events per second in tests.
- [File watching on Docker Desktop / network mounts silently misses events] → Native watch failures can be detected and trigger the automatic polling fallback, but silently lost events cannot (`/rules` may be read-only, so a write probe is impossible). For those mounts, the docs tell users to set `WATCH_POLL=true`.
- [Trusted code assumption misunderstood by users] → The README states that rules have full process and network access, like AppDaemon apps.
- [The REST `setState` entity is not a real HA entity (no unique_id, cannot be customised in the UI, lost on HA restart)] → We document it, republish after reconnect, and point to a future MQTT-discovery or custom-integration approach for real entities.
- [The adapter interface is shaped by a single backend and may not fit the second one] → It is internal and unversioned, so it can change freely when a second adapter is designed. No public API depends on it.
- [`npm ci` at startup needs network and slows startup] → The hash-based skip makes the cost a one-time install. Failures do not block rules that don't need the packages.

## Migration Plan

Not applicable (greenfield). Release plan: `0.x` releases while the rule API stabilises. We publish an API stability promise with `1.0.0`. Rollback for users means pinning the previous image tag. Storage files carry a `version` field to allow future migrations.

## Open Questions

