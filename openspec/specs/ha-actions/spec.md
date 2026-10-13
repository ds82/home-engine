# ha-actions Specification

## Purpose

Defines how rules read Home Assistant state and act on it: state helpers, idempotent and forced switching, cover positioning, service calls, events, virtual entity state, and a dry-run mode for safe testing. All of these are free SDK functions attributed to the calling rule.

## Requirements

### Requirement: Synchronous state reads
`getState(entity)` SHALL return the entity's current state value and `getEntity(entity)` the full state object (state, attributes, `last_changed`, `last_updated`, context). Both SHALL read synchronously from the local state cache, and both SHALL return `undefined` for unknown entities instead of throwing.

#### Scenario: Read known entity
- **WHEN** rule code calls `getEntity("sun.sun")`
- **THEN** it receives the current state object including its attributes

#### Scenario: Read unknown entity
- **WHEN** rule code calls `getState("sensor.unknown_entity")`
- **THEN** it receives `undefined`

#### Scenario: Query entities by pattern
- **WHEN** rule code calls `getEntities("light.*")`
- **THEN** it receives the state objects of all cached light entities

#### Scenario: Group members
- **WHEN** rule code calls `members("group.rollershutters")`
- **THEN** it receives the entity IDs listed in that group's `entity_id` attribute, or an empty array if the group does not exist

### Requirement: Numeric state helper
`getNumber(entity, attribute?)` SHALL return an entity's state (or an attribute) as a number. It SHALL return `undefined` when the value is `unknown`, `unavailable` or not numeric.

#### Scenario: Unavailable sensor
- **WHEN** rule code calls `getNumber("sensor.temperature")` while its state is `unavailable`
- **THEN** it returns `undefined`

### Requirement: State predicates
The SDK SHALL provide `is(entity, value)`, `isOn(entity)`, `isOff(entity)`, `isOpen(entity)` and `isClosed(entity)`. They return `false` for unknown or unavailable entities. `isOpen` SHALL be true for state `open`, or `on` on a `binary_sensor`. `isClosed` SHALL be true for state `closed`, or `off` on a `binary_sensor`.

#### Scenario: Door contact
- **WHEN** `binary_sensor.front_door` (device class `door`) has state `on`
- **THEN** `isOpen("binary_sensor.front_door")` returns `true` and `isClosed("binary_sensor.front_door")` returns `false`

#### Scenario: Unavailable entity
- **WHEN** `switch.fan` is `unavailable`
- **THEN** both `isOn("switch.fan")` and `isOff("switch.fan")` return `false`

### Requirement: Idempotent switching with on/off
`on(entity, data?)` SHALL call the entity domain's `turn_on` service only if the entity is not currently `on`. `off(entity, data?)` SHALL call `turn_off` only if it is not currently `off`. When the call is skipped, they SHALL resolve without contacting Home Assistant and log the skip at debug level.

#### Scenario: Already on
- **WHEN** `light.kitchen` is `on` and a rule calls `on("light.kitchen", { brightness_pct: 30 })`
- **THEN** no service call is sent, and the brightness stays unchanged

#### Scenario: Off to on
- **WHEN** `switch.fan` is `off` and a rule calls `on("switch.fan")`
- **THEN** Home Assistant receives `switch.turn_on` with target `switch.fan`

#### Scenario: Unavailable entity
- **WHEN** `switch.fan` is `unavailable` and a rule calls `off("switch.fan")`
- **THEN** Home Assistant receives `switch.turn_off`, because the entity is not known to be `off`

### Requirement: Forced switching with forceOn/forceOff
`forceOn(entity, data?)` and `forceOff(entity, data?)` SHALL always call the domain's `turn_on` / `turn_off` service regardless of the current state. `toggle(entity)` SHALL always call `toggle`. When a domain has no such service, they SHALL fall back to `homeassistant.turn_on` / `turn_off` / `toggle`.

#### Scenario: Forced on while already on
- **WHEN** `light.kitchen` is `on` and a rule calls `forceOn("light.kitchen", { brightness_pct: 30 })`
- **THEN** Home Assistant receives `light.turn_on` with that data

#### Scenario: Domain without own service
- **WHEN** a rule calls `toggle` on an entity whose domain has no `toggle` service
- **THEN** Home Assistant receives `homeassistant.toggle` with that entity as target

### Requirement: Threshold cover positioning with up/down
`up(cover, position = 100)` SHALL set a cover's position only if its current position is below `position`. `down(cover, position = 0)` SHALL set the position only if it is above `position`. Positions follow Home Assistant (0 = closed, 100 = open). Both SHALL use `cover.set_cover_position`.

#### Scenario: Partially open cover moved down
- **WHEN** `cover.bath` is at position 60 and a rule calls `down("cover.bath", 0)`
- **THEN** Home Assistant receives `cover.set_cover_position` with position 0

#### Scenario: Already lower than requested
- **WHEN** `cover.bath` is at position 20 and a rule calls `down("cover.bath", 40)`
- **THEN** no service call is sent

### Requirement: Call services
`call(service, data?, target?)` SHALL call any Home Assistant service, given as `"domain.service"`, with service data and an optional target (entity IDs, device IDs, area IDs, label IDs). It SHALL return a promise that resolves when Home Assistant acknowledges the call and rejects with Home Assistant's error otherwise.

#### Scenario: Turn on a light
- **WHEN** a rule calls `call("light.turn_on", { brightness_pct: 50 }, { entity_id: "light.kitchen" })`
- **THEN** Home Assistant receives the service call and the promise resolves

#### Scenario: Unknown service
- **WHEN** a rule calls `call("light.does_not_exist")`
- **THEN** the promise rejects with an error containing Home Assistant's error code and message

#### Scenario: Call while disconnected
- **WHEN** a rule calls a service while the connection to Home Assistant is down
- **THEN** the promise rejects promptly with a "not connected" error instead of queueing the call

### Requirement: Unawaited write errors are reported
Write functions (`on`, `off`, `forceOn`, `forceOff`, `toggle`, `up`, `down`, `call`, `fire`, `setState`) MAY be called without `await`. When an unawaited write fails, the engine SHALL log the failure attributed to the calling rule instead of raising an unhandled rejection.

#### Scenario: Fire-and-forget call fails
- **WHEN** a rule calls `forceOn("light.missing")` without awaiting and Home Assistant rejects the call
- **THEN** an error naming the rule, the service and Home Assistant's message is logged, and the engine keeps running

### Requirement: Service response data
`call` SHALL support requesting response data from services that support it (e.g. `weather.get_forecasts`, `calendar.get_events`). The promise SHALL resolve with the returned data.

#### Scenario: Forecast retrieved
- **WHEN** a rule calls `weather.get_forecasts` with `type: "daily"` and requests the response
- **THEN** the promise resolves with the forecast data returned by Home Assistant

### Requirement: Fire events
`fire(eventType, data?)` SHALL fire a custom event on the Home Assistant event bus with arbitrary JSON-serialisable data.

#### Scenario: Custom event fired
- **WHEN** a rule calls `fire("home_engine_alert", { level: "high" })`
- **THEN** Home Assistant automations listening to `home_engine_alert` receive the event with that data

### Requirement: Set virtual entity state
`setState(entity, state, attributes?)` SHALL create or update an entity in Home Assistant's state machine (e.g. `sensor.home_engine_last_motion`). The engine SHALL document that such entities are not persisted by Home Assistant across its restarts, and SHALL re-publish their last value after reconnect. The engine SHALL NOT persist virtual entity values across its own restarts; rules that need a value at boot set it from `onStartup` (typically from `store`), and the documentation SHALL show this pattern.

#### Scenario: Virtual sensor created
- **WHEN** a rule calls `setState("sensor.living_room_comfort", "good", { friendly_name: "Comfort" })`
- **THEN** the entity appears in Home Assistant with that state and attributes

#### Scenario: Engine restart does not restore virtual state
- **WHEN** a rule set `sensor.living_room_comfort` and the engine restarts
- **THEN** the engine does not publish a value for it until a rule calls `setState` again

#### Scenario: Republished after Home Assistant restart
- **WHEN** Home Assistant restarts and the engine reconnects
- **THEN** the engine re-publishes the last state of every virtual entity a currently loaded rule has set

### Requirement: Context attribution
Service calls and state writes made by the engine SHALL be identifiable in Home Assistant as originating from the engine user. The engine SHALL remember the Home Assistant context ID of every write together with the rule that made it, so state-change events can report the cause and the causing rule (see rule-triggers: Change cause) and rules can avoid feedback loops.

#### Scenario: Ignoring self-caused changes
- **WHEN** a rule turns on `light.kitchen` and also triggers on `onChange("light.kitchen")`
- **THEN** the resulting event has `causedByEngine: true` and `causedByRule` set to that rule's ID

### Requirement: Raw WebSocket access
The SDK SHALL provide an escape hatch to send arbitrary WebSocket commands (e.g. registry queries) and receive their results, for features the engine does not wrap.

#### Scenario: Query entity registry
- **WHEN** a rule sends `{ type: "config/entity_registry/list" }`
- **THEN** it receives Home Assistant's entity registry list

### Requirement: Dry-run mode
When dry-run mode is enabled, the engine SHALL log every outgoing service call, event firing and state write with its full payload and rule ID at `info` level instead of sending it, and resolve the corresponding promise with an empty result. Reads, history queries, subscriptions and triggers SHALL work normally. Raw WebSocket commands SHALL be sent only when the engine knows them to be read-only queries; any other raw command SHALL be logged and resolved with an empty result instead.

#### Scenario: Service call in dry run
- **WHEN** dry-run is enabled and rule `lights#porch` calls `forceOn("light.porch")`
- **THEN** Home Assistant receives no service call and the engine logs `[dry-run] lights#porch light.turn_on` with target and data

#### Scenario: Raw read command in dry run
- **WHEN** dry-run is enabled and a rule sends the raw command `config/entity_registry/list`
- **THEN** Home Assistant receives it and the rule gets the entity registry list

#### Scenario: Raw write command in dry run
- **WHEN** dry-run is enabled and a rule sends the raw command `config/entity_registry/update`
- **THEN** Home Assistant receives nothing, the engine logs `[dry-run]` with the rule ID and the command, and the promise resolves with an empty result
