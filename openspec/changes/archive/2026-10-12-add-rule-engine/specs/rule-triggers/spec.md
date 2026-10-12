# Spec Delta

## Purpose

Lets rules react to things happening in Home Assistant: entity state changes, attribute changes, states held for a duration, bus events, native Home Assistant triggers and rule startup. It defines the trigger vocabulary shared by both rule forms, the event objects rules receive, and how overlapping runs are handled.

## ADDED Requirements

### Requirement: Trigger constructors
The SDK SHALL provide trigger constructor functions that return trigger descriptions without side effects. The same descriptions SHALL be usable in the trigger list of a triggered rule and with `listen()` in setup rules.

#### Scenario: Same trigger in both forms
- **WHEN** `onChange("light.kitchen", { to: "on" })` is used once in a triggered rule's list and once with `listen()` in a setup rule
- **THEN** both fire when `light.kitchen` turns on

#### Scenario: Constructor has no effect on its own
- **WHEN** rule code calls `onChange("light.kitchen")` without passing the result to a rule or listener
- **THEN** nothing is subscribed and nothing fires

### Requirement: Triggers fire independently
Each trigger of a triggered rule SHALL be an independent source of firings. When one occurrence matches several triggers of the same rule, each matching trigger SHALL fire, and the rule's concurrency mode SHALL handle the resulting runs. Every event SHALL identify the trigger that fired.

#### Scenario: One change matches two triggers
- **WHEN** a rule triggers on `[onChange("light.*"), onChange("light.kitchen", { to: "on" })]` and `light.kitchen` turns on
- **THEN** the body runs twice, once per trigger, and each event identifies its trigger

### Requirement: State change trigger
`onChange(entities, options?)` SHALL fire on state changes of the given entities. Entities can be exact entity IDs, an array of IDs, or glob patterns (e.g. `light.*`). The event SHALL contain `type: "state"`, the entity ID, the old and new state objects, its cause (see Change cause), and whether it was synthesised after a resync (`resynced`). The creation of an entity SHALL be delivered with an undefined old state, and its removal with an undefined new state.

#### Scenario: Single entity
- **WHEN** a rule triggers on `onChange("binary_sensor.hall_motion")` and the state changes from `off` to `on`
- **THEN** the body runs once with an event for `binary_sensor.hall_motion` with old state `off` and new state `on`

#### Scenario: Glob pattern
- **WHEN** a rule triggers on `onChange("light.*")` and `light.kitchen` turns on
- **THEN** the body runs for `light.kitchen`

#### Scenario: Entity created at runtime
- **WHEN** a rule triggers on `onChange("sensor.new_*")` and an entity `sensor.new_one` is created after the rule started
- **THEN** the body runs once for the creation with an undefined old state, and later state changes of `sensor.new_one` also run the body

#### Scenario: Entity removed at runtime
- **WHEN** a rule triggers on `onChange("sensor.old_one")` and the entity is removed from Home Assistant
- **THEN** the body runs with an undefined new state

### Requirement: State value filters
`onChange` SHALL support optional `from` and `to` filters. Each can be a single value, an array of values, or a predicate function. The trigger SHALL fire only when all given filters match. An undefined state (entity created or removed) SHALL never match a value filter, and predicates SHALL NOT be called with it. Without filters, creation and removal fire like any other change.

#### Scenario: To filter
- **WHEN** a rule triggers on `onChange("binary_sensor.door", { to: "on" })` and the state changes `on` → `off`
- **THEN** the body does not run

#### Scenario: From and to filter
- **WHEN** a rule triggers with `{ from: "home", to: "not_home" }` and the state changes `home` → `not_home`
- **THEN** the body runs

#### Scenario: Predicate filter
- **WHEN** a rule triggers on `onChange("sensor.temperature", { to: (s) => Number(s) > 25 })` and the state changes `24.5` → `25.5`
- **THEN** the body runs

#### Scenario: Removal does not match a to filter
- **WHEN** a rule triggers on `onChange("light.porch", { to: "on" })` and `light.porch` is removed
- **THEN** the body does not run

### Requirement: Ignoring unavailable states
`onChange` SHALL support an `ignoreUnavailable` option (default `false`). With it, transitions into or out of `unavailable` or `unknown` SHALL be treated as no change: they do not fire, do not count as `from`, and do not cancel or restart a hold. A change from `unavailable`/`unknown` back to a value is compared with the last value seen before it.

#### Scenario: Device hiccup ignored
- **WHEN** a rule triggers on `onChange("light.x", { to: "on", ignoreUnavailable: true })` and the state goes `on` → `unavailable` → `on`
- **THEN** the body does not run

#### Scenario: Real change across unavailability
- **WHEN** the same rule sees `off` → `unavailable` → `on`
- **THEN** the body runs once, with old state `off` and new state `on`

#### Scenario: Default delivers unavailability
- **WHEN** a rule triggers on `onChange("light.x", { to: "on" })` without `ignoreUnavailable` and the state goes `on` → `unavailable` → `on`
- **THEN** the body runs for the `unavailable` → `on` change

### Requirement: Attribute change semantics
By default, `onChange` SHALL fire only when the entity's state value changes. With an `attribute` option, it SHALL fire when that attribute's value changes, and filters apply to the attribute value. With `attribute: "*"`, it SHALL fire on any change of state value or attributes.

#### Scenario: Attribute-only change ignored by default
- **WHEN** a rule triggers on `onChange("light.kitchen")` and only `brightness` changes
- **THEN** the body does not run

#### Scenario: Specific attribute
- **WHEN** a rule triggers on `onChange("light.kitchen", { attribute: "brightness" })` and brightness changes from 100 to 200
- **THEN** the body runs with old value 100 and new value 200 available in the event

#### Scenario: Any change
- **WHEN** a rule triggers on `onChange("light.kitchen", { attribute: "*" })` and only the `color_temp` attribute changes
- **THEN** the body runs

### Requirement: Change cause
Every state event SHALL carry `causedBy`, which is `"engine"` when the change was made directly by a write of any rule of this engine and `"external"` otherwise (devices, users, Home Assistant automations, including automations that reacted to an engine write). When the engine knows which rule made the write, the event SHALL also carry `causedByRule` with that rule ID. `causedByRule` SHALL only be present when `causedBy` is `"engine"`. `causedByEngine` SHALL be a boolean shorthand for `causedBy === "engine"`.

#### Scenario: Change caused by another rule
- **WHEN** rule `hall#auto-light` turns on `light.hall` and rule `hall#log-manual` triggers on `onChange("light.hall")`
- **THEN** `hall#log-manual` receives an event with `causedBy: "engine"`, `causedByEngine: true` and `causedByRule: "hall#auto-light"`

#### Scenario: Manual change
- **WHEN** someone presses the wall switch of `light.hall`
- **THEN** the event has `causedBy: "external"` and no `causedByRule`

#### Scenario: Home Assistant automation reacting to an engine write
- **WHEN** a rule turns on `switch.x` and a Home Assistant automation reacts by turning on `light.y`
- **THEN** the event for `light.y` has `causedBy: "external"` and no `causedByRule`

### Requirement: Synthetic events after resync
After a reconnect (not after the first connect), the engine SHALL compare the state cache before and after resynchronisation. For each entity whose state or attributes differ, it SHALL deliver one state event from the old to the new state to matching triggers and listeners, with `resynced: true` and `causedBy: "external"`. Entities that appeared or disappeared SHALL be delivered with an undefined old or new state. A hold started by a resynced event SHALL count from the new state's `last_changed` (or `last_updated` for attribute triggers), not from the time of the resync. Unlike hold restoration, this applies to holds with a `from` filter too, because the resync knows the old state.

#### Scenario: Door opened during a Home Assistant restart
- **WHEN** a rule triggers on `onChange("binary_sensor.front_door", { to: "on" })` and the door opened while the engine was disconnected
- **THEN** after reconnecting, the body runs once with an event from `off` to `on` marked `resynced: true`

#### Scenario: Unchanged entity
- **WHEN** an entity changed and changed back while the engine was disconnected
- **THEN** no event is delivered for it

#### Scenario: Hold started during disconnect
- **WHEN** a rule triggers on `onChange("switch.pump", { to: "on", for: "10m" })`, the pump turned on 4 minutes before the reconnect, and the resync delivers `off` → `on`
- **THEN** the body runs 6 minutes after the reconnect

### Requirement: Holds during a disconnect
Pending holds SHALL keep running while the engine is disconnected from Home Assistant. A hold that runs out while disconnected SHALL NOT fire then. After the resync, the engine SHALL check it against the fresh state: if the entity still matches the trigger's filters and has not changed since the hold started, the hold fires; otherwise it is dropped.

#### Scenario: Hold runs out while disconnected, state unchanged
- **WHEN** a hold of `onChange("switch.lawn_watering", { to: "on", for: "20m" })` runs out while disconnected and the switch is still `on` with the same `last_changed` after resync
- **THEN** the body runs once right after the resync

#### Scenario: Hold runs out while disconnected, state changed
- **WHEN** the same hold runs out while disconnected and the switch turned `off` during the outage
- **THEN** the body does not run

### Requirement: Hold-for-duration
`onChange` SHALL support a `for` duration (milliseconds or a human-readable duration such as `"5m"`). It SHALL fire only after the entity has kept a matching value for that duration. Every change (per the attribute semantics) SHALL restart the hold if the new value matches the filters and cancel it if not; a change from one matching value to another matching value also restarts it. With several entities, each entity is tracked independently by default. With `holdAs: "group"`, the listed entities share one hold: every change of any of them restarts the shared hold if that entity's new value matches and cancels it if not, and the firing carries the event of the last change.

#### Scenario: Condition held
- **WHEN** a rule triggers on `onChange("switch.lawn_watering", { to: "on", for: "20m" })` and the switch stays on for 20 minutes
- **THEN** the body runs once, 20 minutes after the switch turned on

#### Scenario: Condition interrupted
- **WHEN** the switch turns on, then off again after 3 minutes
- **THEN** the body does not run

#### Scenario: Matching value to matching value restarts the hold
- **WHEN** a rule triggers on `onChange("sensor.temperature", { to: (s) => Number(s) > 25, for: "10m" })` and the state changes `24` → `26`, then 4 minutes later `26` → `27`
- **THEN** the body runs 10 minutes after the change to `27`

#### Scenario: Debouncing a flapping sensor
- **WHEN** a rule triggers on `onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], { for: "30s" })` and one of the sensors flaps three times within 10 seconds, then stays stable
- **THEN** the body runs once, 30 seconds after the last change

#### Scenario: Independent holds per entity
- **WHEN** the same rule sees `binary_sensor.bath_window_tilt` change, and `binary_sensor.bath_window_open` change 5 seconds later
- **THEN** the body runs twice: 30 seconds after each sensor's change

#### Scenario: Group hold
- **WHEN** a rule triggers on `onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], { for: "30s", holdAs: "group" })`, the tilt sensor changes, and the open sensor changes 5 seconds later
- **THEN** the body runs once, 30 seconds after the open sensor's change, with that change's event

#### Scenario: Engine starts while condition already true
- **WHEN** the rule starts while the switch has already been `on` for 2 minutes
- **THEN** the hold is restored (see Hold restoration on rule start) and the body runs after the remaining 18 minutes

### Requirement: Hold restoration on rule start
When a rule starts (engine start, hot reload, re-enable), the engine SHALL restore pending holds of its `onChange` triggers that have a `for` duration and no `from` filter. This covers the triggers of a triggered rule and the listeners a setup rule registers while its setup function runs. Listeners registered later (for example inside a listener callback) start without a restored hold. For each matching entity whose current cached state matches the trigger's filters, the engine SHALL compute the time already held from the state's `last_changed` (or `last_updated` for attribute triggers) and schedule the firing for the remaining time. For a group hold, the entity with the latest `last_changed` decides. If the full duration has already passed, it SHALL fire immediately after the rule starts, unless that hold already fired. The resulting event SHALL carry `restored: true`. Holds with a `from` filter SHALL NOT be restored, because the previous state cannot be verified from the cache.

To avoid firing the same hold twice, the engine SHALL remember every hold that fired, across reloads and engine restarts, keyed by rule ID, trigger identity, entity and the `last_changed` (or `last_updated`) the hold counted from. The trigger identity SHALL consist of the trigger's position (in the rule's trigger list, or in the order of `listen()` calls during setup) and its description, so an edited trigger counts as a new one. A listener registered with an explicit `id` (see Listeners in setup rules) SHALL use that ID instead of its position. This record SHALL be engine-internal state, persisted in the engine's data directory separately from rule storage and not visible through `store` or `shared`. An entry SHALL be dropped once the entity's `last_changed` (or `last_updated`) moves on, or once its rule ID no longer exists after a full load.

A restored hold SHALL count from `last_changed` (or `last_updated`) even with `ignoreUnavailable`, so a brief unavailability before the rule started makes the restored hold fire later than it would have live, never earlier.

#### Scenario: Reload during a hold
- **WHEN** a rule triggers on `onChange("light.hall", { to: "on", for: "10m" })`, the light turned on 6 minutes ago, and the rule's file is edited and reloaded
- **THEN** the body runs 4 minutes after the reload with an event marked `restored: true`

#### Scenario: Hold already elapsed during downtime
- **WHEN** the same light turned on 25 minutes ago and the engine was stopped for the last 20 minutes
- **THEN** the body runs once right after the rule starts, with `restored: true`

#### Scenario: Hold already fired before reload
- **WHEN** a rule triggers on `onChange("binary_sensor.garage_door", { to: "on", for: "5m" })`, the door has been open for 3 days, the hold fired 5 minutes after it opened, and the rule's file is reloaded
- **THEN** the body does not run again

#### Scenario: Edited trigger
- **WHEN** the trigger of that rule is changed to `for: "10m"` and the file is reloaded while the door is still open
- **THEN** the edited trigger counts as new, and its body runs once right after the reload with `restored: true`

#### Scenario: Hold with from filter
- **WHEN** a rule triggers on `onChange("lock.door", { from: "locked", to: "unlocked", for: "5m" })` and the rule starts while the lock is `unlocked`
- **THEN** no hold is restored and the body runs only after a new matching transition

#### Scenario: Fired-holds record is not user storage
- **WHEN** a rule whose hold already fired lists its `store.keys()`
- **THEN** no fired-holds entry appears

#### Scenario: Restored hold after a brief unavailability
- **WHEN** a rule triggers on `onChange("light.hall", { to: "on", for: "10m", ignoreUnavailable: true })`, the light turned on 8 minutes ago, was `unavailable` for 5 seconds 3 minutes ago, and the file is reloaded
- **THEN** the restored hold counts from the end of the unavailability, and the body runs 7 minutes after the reload

### Requirement: Immediate evaluation option
`onChange` SHALL support an `immediate` option. With it, the trigger fires once when the rule starts if the current cached value matches the `to` filter (or, without `to`, if the entity exists). For a listener registered after its setup function has finished, the trigger is evaluated when `listen()` is called. `immediate` SHALL NOT be combined with `for` (hold restoration already covers held states) or with `from` (there is no previous state to check). The constructor SHALL throw for these combinations.

#### Scenario: Immediate with matching state
- **WHEN** a rule triggers on `onChange("light.porch", { to: "on", immediate: true })` and the light is currently `on` when the rule starts
- **THEN** the body runs once right after the rule starts

#### Scenario: Immediate combined with for or from
- **WHEN** rule code calls `onChange("light.porch", { to: "on", for: "5m", immediate: true })` or `onChange("light.porch", { from: "off", to: "on", immediate: true })`
- **THEN** the constructor throws an error explaining that `immediate` cannot be combined with `for` or `from`

#### Scenario: Immediate in a late listener
- **WHEN** a setup rule's listener callback calls `listen(onChange("light.porch", { to: "on", immediate: true }), cb)` while the light is `on`
- **THEN** `cb` runs once right after the `listen()` call

### Requirement: Event trigger
`onEvent(eventType, dataFilter?)` SHALL fire on Home Assistant bus events of that type. The optional data filter is a predicate or a partial object matched recursively: nested objects match partially, and each leaf can be a literal, an array of allowed values, or a predicate. The event SHALL contain `type: "event"`, the event type, data, origin and time fired.

#### Scenario: Event with data filter
- **WHEN** a rule triggers on `onEvent("zha_event", { device_ieee: "00:11", command: "on" })` and a matching event is fired
- **THEN** the body runs with the event data

#### Scenario: Non-matching event data
- **WHEN** a `zha_event` with `command: "off"` is fired
- **THEN** the body does not run

#### Scenario: Nested partial match with array leaf
- **WHEN** a rule triggers on `onEvent("zha_event", { args: { button: [1, 2] } })` and an event with `args: { button: 2, duration: 300 }` is fired
- **THEN** the body runs

### Requirement: Native Home Assistant trigger
`onTrigger(config)` SHALL subscribe to any native Home Assistant trigger configuration (as used in YAML automations, e.g. `numeric_state`, `zone`, `template`, device triggers). The event SHALL contain `type: "ha-trigger"` and the trigger variables Home Assistant provides. When Home Assistant rejects the configuration, whether on first subscribe or on resubscribe after a reconnect, the rule SHALL keep its status `running`. The error SHALL be logged as an error, recorded as the rule's last error, and shown on that trigger in the rule status output. The rule's other triggers SHALL stay armed.

#### Scenario: Numeric state trigger delegated to HA
- **WHEN** a rule triggers on `onTrigger({ platform: "numeric_state", entity_id: "sensor.humidity", above: 70 })` and humidity rises above 70
- **THEN** the body runs with the trigger variables from Home Assistant

#### Scenario: Invalid trigger config
- **WHEN** Home Assistant rejects the trigger configuration
- **THEN** the rule stays `running`, the error is logged, recorded as the rule's last error and shown on that trigger in the status output, and the rule's other triggers stay armed

### Requirement: Startup trigger
`onStartup()` SHALL fire once each time the rule starts (engine start, hot reload, re-enable), with `type: "startup"`. It SHALL NOT fire on reconnects to Home Assistant. In a setup rule, `listen(onStartup(), cb)` called during the setup function SHALL run `cb` once after the setup function has finished. Called later, `listen()` SHALL throw an error stating that `onStartup()` can only be used during setup.

#### Scenario: Initialise state on start
- **WHEN** a rule has triggers `[onStartup(), onChange("sun.sun")]` and its file is reloaded
- **THEN** the body runs once right after the reload with a `startup` event

#### Scenario: Startup listener in a setup rule
- **WHEN** a setup function calls `listen(onStartup(), cb)` and then awaits other work
- **THEN** `cb` runs once after the setup function's promise resolves

#### Scenario: Startup listener registered late
- **WHEN** a listener callback calls `listen(onStartup(), cb)`
- **THEN** the call throws an error stating that `onStartup()` can only be used during setup

### Requirement: Await a state
The SDK SHALL provide `waitFor(entity, filter, options?)`, a promise that resolves with the matching state when an entity matches a filter (optionally held for a duration). On a configurable timeout it SHALL resolve with `undefined`. It SHALL reject only when the rule is unloaded or its run is aborted.

#### Scenario: Waiting for a light to go off
- **WHEN** a rule awaits `waitFor("light.garage", { to: "off" }, { timeout: "10m" })` and the light turns off after 2 minutes
- **THEN** the promise resolves after 2 minutes with the new state

#### Scenario: Timeout
- **WHEN** the entity does not match within the timeout
- **THEN** the promise resolves with `undefined`

#### Scenario: Already matching
- **WHEN** the entity already matches the filter when awaited and no `for` duration is given
- **THEN** the promise resolves immediately

### Requirement: Concurrency modes
Each triggered rule SHALL have a `mode` controlling overlapping runs of its async body. Listeners of setup rules SHALL always run in parallel and SHALL NOT accept a mode. The modes are `parallel` (default), `single` (drop new firings while running), `queued` (run one at a time in arrival order) and `restart` (abort the running one and start anew). A `max` option SHALL limit the number of runs that are in progress or waiting in the queue, for `queued` (default 10) and `parallel` (default unlimited). Firings beyond `max` SHALL be dropped and logged as a warning. Every run of a body or listener SHALL receive an `AbortSignal` in its event.

#### Scenario: Single mode drops overlapping firing
- **WHEN** a rule with `mode: "single"` fires while its previous run is still in progress
- **THEN** the new firing is dropped and a debug log line is written

#### Scenario: Restart mode aborts previous run
- **WHEN** a rule with `mode: "restart"` fires while its previous run is awaiting `sleep("20m")`
- **THEN** the previous run's abort signal is triggered, its pending sleep rejects with an abort error that the engine does not log as a rule error, and a new run starts

#### Scenario: Queued mode preserves order
- **WHEN** three firings arrive while a `queued` rule's run is in progress
- **THEN** the body runs three more times, in arrival order, one at a time

#### Scenario: Queue full
- **WHEN** a `queued` rule with the default `max` has one run in progress and 9 queued, and another firing arrives
- **THEN** the new firing is dropped and a warning is logged naming the rule

### Requirement: Listeners in setup rules
The SDK SHALL provide a free function `listen(trigger | triggers, callback, options?)` that registers a listener for the calling setup rule. The optional `id` option gives the listener a stable identity for hold restoration, which is needed when setup registers listeners conditionally. It SHALL be unique within the rule; a duplicate SHALL make `listen()` throw. It SHALL be callable from the setup function and from code running on behalf of the same setup rule (listener callbacks, timers). Called anywhere else (file top level, a triggered rule's body), it SHALL throw an error stating that `listen()` is only available in setup rules. It SHALL return a handle that can cancel that single listener before the rule is unloaded. All listeners are released when the rule is unloaded.

#### Scenario: Listen in a triggered rule
- **WHEN** a triggered rule's body calls `listen(onChange("light.hall"), cb)`
- **THEN** the call throws an error stating that `listen()` is only available in setup rules, and the error is logged for that run

#### Scenario: Conditional listener with stable ID
- **WHEN** a setup function registers `listen(onChange("light.a", { to: "on", for: "10m" }), cb, { id: "a-on" })` only when some condition holds, and the file is reloaded while that hold is pending
- **THEN** the hold is restored under the ID `a-on`, regardless of how many listeners were registered before it

#### Scenario: Cancel a single listener
- **WHEN** a setup rule cancels one listener handle
- **THEN** that callback is no longer invoked while the rule's other listeners stay active
