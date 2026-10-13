# Spec Delta

## MODIFIED Requirements

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
