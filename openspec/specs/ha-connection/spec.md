# ha-connection Specification

## Purpose

Maintains the engine's single, long-lived connection to the Home Assistant WebSocket API. Covers authentication, resilience against disconnects, and an up-to-date local state cache that rules rely on.

## Requirements

### Requirement: Connect via WebSocket API
The engine SHALL connect to the Home Assistant WebSocket endpoint derived from the configured base URL (`http(s)://host:port` → `ws(s)://host:port/api/websocket`). It SHALL use a single shared connection for all rules.

#### Scenario: HTTP base URL is converted
- **WHEN** the configured URL is `http://homeassistant.local:8123`
- **THEN** the engine opens a WebSocket to `ws://homeassistant.local:8123/api/websocket`

#### Scenario: HTTPS base URL is converted
- **WHEN** the configured URL is `https://ha.example.com`
- **THEN** the engine opens a WebSocket to `wss://ha.example.com/api/websocket`

#### Scenario: All rules share one connection
- **WHEN** ten rules are loaded and each subscribes to state changes
- **THEN** exactly one WebSocket connection to Home Assistant exists

### Requirement: Authenticate with long-lived access token
The engine SHALL authenticate with the configured long-lived access token as soon as Home Assistant sends `auth_required`. It SHALL NOT write the token to logs.

#### Scenario: Successful authentication
- **WHEN** Home Assistant responds with `auth_ok`
- **THEN** the engine logs the connected Home Assistant version and proceeds to initialise subscriptions and load rules

#### Scenario: Invalid token on first connect
- **WHEN** Home Assistant responds with `auth_invalid` during the initial startup
- **THEN** the engine logs an authentication error without the token value and exits with a non-zero exit code

#### Scenario: Token never appears in logs
- **WHEN** the engine runs at any log level, including `trace`
- **THEN** no log line contains the access token

### Requirement: Supervisor add-on mode
When the environment variable `SUPERVISOR_TOKEN` is present and no explicit URL/token is configured, the engine SHALL connect to `ws://supervisor/core/websocket` using the Supervisor token.

#### Scenario: Running as Home Assistant add-on
- **WHEN** `SUPERVISOR_TOKEN` is set and `HA_URL` / `HA_TOKEN` are unset
- **THEN** the engine connects to `ws://supervisor/core/websocket` and authenticates with the Supervisor token

#### Scenario: Explicit configuration wins
- **WHEN** `SUPERVISOR_TOKEN`, `HA_URL` and `HA_TOKEN` are all set
- **THEN** the engine uses `HA_URL` and `HA_TOKEN`

### Requirement: Automatic reconnect with backoff
After losing an established connection, the engine SHALL reconnect indefinitely. It SHALL wait with exponential backoff (starting at 1 s, capped at 60 s, with jitter) and reset the backoff after a successful connection.

#### Scenario: Home Assistant restarts
- **WHEN** the WebSocket closes because Home Assistant restarts
- **THEN** the engine retries with increasing delays and reconnects once Home Assistant is reachable again, without restarting the process

#### Scenario: Rules survive a reconnect
- **WHEN** the connection is re-established
- **THEN** all loaded rules stay loaded, their triggers are active again, and no rule setup function is re-executed

#### Scenario: Auth becomes invalid later
- **WHEN** a reconnect attempt receives `auth_invalid` (e.g. the token was revoked)
- **THEN** the engine logs an error and continues retrying with the maximum backoff delay

### Requirement: Re-subscription after reconnect
After reconnecting, the engine SHALL restore every active Home Assistant subscription that rules depend on (state changes, event types, triggers) before it reports itself ready.

#### Scenario: Event subscription restored
- **WHEN** a rule listens to event type `zha_event` and the connection drops and comes back
- **THEN** the rule receives `zha_event` events fired after the reconnect

### Requirement: Local state cache
The engine SHALL keep an in-memory cache of all entity states. It SHALL initialise the cache from Home Assistant's full state list on every (re)connect and keep it current from state-change messages.

#### Scenario: Cache populated at startup
- **WHEN** the engine finishes connecting
- **THEN** synchronous state reads return the current state of every entity known to Home Assistant

#### Scenario: Cache refreshed after reconnect
- **WHEN** an entity changed state while the engine was disconnected
- **THEN** after reconnecting, state reads return the new state

#### Scenario: State changes missed during a disconnect
- **WHEN** an entity changed state while the engine was disconnected
- **THEN** the engine delivers a synthetic state event for that change (see rule-triggers: Synthetic events after resync) and logs at debug level how many entities differed

### Requirement: Connection status exposed to rules
The engine SHALL let rules query the current connection status and subscribe to `connected` / `disconnected` notifications.

#### Scenario: Rule notified on disconnect
- **WHEN** a rule subscribed to connection notifications and the connection drops
- **THEN** the rule's disconnect callback is invoked once

### Requirement: Keep-alive and dead connection detection
The engine SHALL send periodic WebSocket `ping` messages. It SHALL treat the connection as dead and reconnect when no `pong` arrives within a timeout.

#### Scenario: Half-open connection
- **WHEN** the network silently drops and no `pong` arrives within the timeout
- **THEN** the engine closes the socket and starts the reconnect procedure

### Requirement: Startup waits for Home Assistant
If Home Assistant is unreachable during startup (network error, not an auth error), the engine SHALL keep retrying with backoff instead of exiting. It SHALL load rules only after the first successful connection.

#### Scenario: Engine starts before Home Assistant
- **WHEN** the container starts while Home Assistant is still booting
- **THEN** the engine retries until Home Assistant is reachable, then loads rules
