# rule-storage Specification

## Purpose

Gives each rule a small persistent key/value store, so rules can remember values (counters, last-run timestamps, learned settings) across rule reloads and engine restarts.

## Requirements

### Requirement: Per-rule key/value store
The SDK SHALL provide a per-rule key/value store (`store`) with `get`, `set`, `delete` and `keys` operations. Values SHALL be JSON-serialisable. Each rule's keys SHALL be namespaced by its rule ID, so rules cannot read or overwrite each other's values.

#### Scenario: Values isolated between rules
- **WHEN** rule `a#one` sets key `count` to 1 and rule `b#two` reads key `count`
- **THEN** rule `b#two` receives `undefined`

#### Scenario: Non-serialisable value rejected
- **WHEN** a rule sets a value containing a function or a circular reference
- **THEN** `set` throws an error and the previously stored value is unchanged

### Requirement: Shared store
The SDK SHALL additionally provide a shared key/value store (`shared`) that all rules can read and write, for intentional cross-rule coordination.

#### Scenario: Cross-rule flag
- **WHEN** rule `a#one` sets shared key `vacation` to `true`
- **THEN** rule `b#two` reads `true` from shared key `vacation`

### Requirement: Persistence across restarts and reloads
Stored values SHALL be persisted in the configured data directory. They SHALL survive rule reloads, engine restarts and container re-creation as long as the data volume is kept.

#### Scenario: Value survives restart
- **WHEN** a rule sets `lastRun` and the container is restarted
- **THEN** after restart, the rule reads the same `lastRun` value

#### Scenario: Value survives hot reload
- **WHEN** a rule's file is edited and the rule is reloaded
- **THEN** the rule reads the values it stored before the reload

### Requirement: Crash-safe writes
Writes SHALL be durable and atomic. A crash or power loss during a write SHALL NOT corrupt previously persisted data. Writes MAY be batched but SHALL be flushed within 1 second and on graceful shutdown.

#### Scenario: Shutdown flushes pending writes
- **WHEN** a rule sets a value and the engine receives SIGTERM 100 ms later
- **THEN** the value is persisted before the process exits

#### Scenario: Corrupted store file
- **WHEN** the storage file cannot be parsed at startup
- **THEN** the engine logs an error, moves the corrupted file aside with a timestamp suffix, and starts with an empty store

### Requirement: Orphaned data retention
Data of rules that no longer exist SHALL NOT be deleted automatically, so renaming or temporarily removing a rule does not lose its data.

#### Scenario: Rule temporarily removed
- **WHEN** a rule file is deleted and later restored with the same rule ID
- **THEN** the restored rule reads its previously stored values
