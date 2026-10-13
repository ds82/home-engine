# engine-observability Specification

## Purpose

Makes the engine's behaviour visible to operators and rule authors through structured logs and an HTTP health endpoint. This supports debugging rules and integrating with container orchestration.

## Requirements

### Requirement: Log levels
The engine SHALL support the log levels `trace`, `debug`, `info`, `warn`, `error` and `fatal`. It SHALL emit only messages at or above the configured level.

#### Scenario: Debug suppressed at info
- **WHEN** `LOG_LEVEL=info` and a rule logs a debug message
- **THEN** the message is not emitted

### Requirement: Log formats
The engine SHALL support a human-readable `pretty` format and a `json` format with one object per line. Each JSON entry SHALL contain at least: timestamp (ISO 8601), level, message and source (`engine` or a rule ID), plus structured fields passed by the caller.

#### Scenario: JSON log line
- **WHEN** `LOG_FORMAT=json` and rule `lights#porch` logs `"turned on"` with `{ entity: "light.porch" }`
- **THEN** a single-line JSON object is written containing the timestamp, level `info`, message `turned on`, source `lights#porch` and field `entity`

### Requirement: Per-rule logger
The SDK SHALL provide a logger (`log`) whose output is automatically tagged with the rule ID. Engine-generated messages about a rule (load, unload, errors) SHALL carry the same tag.

#### Scenario: Rule log tagged
- **WHEN** rule `climate#heating` logs `"boost started"`
- **THEN** the emitted line identifies `climate#heating` as its source

### Requirement: Engine activity logging
At `info` level, the engine SHALL log connection state transitions, rule load/unload/reload results, and a startup summary (rules loaded, disabled, failed). At `debug` level, it SHALL log every trigger firing and every outgoing service call with its rule ID.

#### Scenario: Startup summary
- **WHEN** the engine finishes the initial load with 12 rules, 1 disabled and 1 failed
- **THEN** an info line reports `12 loaded, 1 disabled, 1 failed`

#### Scenario: Service call traced at debug
- **WHEN** `LOG_LEVEL=debug` and rule `lights#porch` calls `light.turn_on`
- **THEN** a debug line shows the rule ID, service, target and data

### Requirement: Liveness endpoint
The engine SHALL serve `GET /health/live` on the configured HTTP port. It SHALL return HTTP 200 while the process event loop is responsive, regardless of the Home Assistant connection state.

#### Scenario: Live while disconnected
- **WHEN** Home Assistant is unreachable and the engine is retrying
- **THEN** `GET /health/live` returns 200

### Requirement: Readiness endpoint
The engine SHALL serve `GET /health/ready`. It SHALL return HTTP 200 when connected and authenticated to Home Assistant and the initial rule load has completed, and HTTP 503 otherwise. The JSON body SHALL include the connection state.

#### Scenario: Ready
- **WHEN** the engine is connected and rules are loaded
- **THEN** `GET /health/ready` returns 200 with `{ "connected": true, ... }`

#### Scenario: Not ready during reconnect
- **WHEN** the connection to Home Assistant is lost
- **THEN** `GET /health/ready` returns 503 until the connection and subscriptions are restored

### Requirement: Rule status endpoint
The engine SHALL serve `GET /rules`. It SHALL return a JSON list of all known rules with ID, source file, status (`starting`, `running`, `disabled`, `failed`), last load time, last error message, and the number of active triggers and scheduled timers. Triggers that Home Assistant rejected SHALL be listed with their error, their position in the rule's trigger list and a short description of the trigger, while the rule keeps status `running`.

#### Scenario: Failed rule listed
- **WHEN** a rule failed during setup with `ReferenceError: foo is not defined`
- **THEN** `GET /rules` lists it with status `failed` and that error message

#### Scenario: Rejected trigger identified
- **WHEN** a rule has two `onTrigger` triggers and Home Assistant rejects the second one
- **THEN** `GET /rules` lists the rule as `running` with one trigger error that names position 2 and the trigger's platform, together with Home Assistant's message

### Requirement: HTTP server is read-only and unauthenticated
The HTTP endpoints SHALL be read-only, SHALL NOT expose secrets, entity states or rule source code, and SHALL be disableable by setting `HTTP_PORT=0`.

#### Scenario: HTTP disabled
- **WHEN** `HTTP_PORT=0`
- **THEN** the engine does not open any listening port
