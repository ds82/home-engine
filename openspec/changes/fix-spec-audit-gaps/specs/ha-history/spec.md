# Spec Delta

## MODIFIED Requirements

### Requirement: Change of cumulative sensors
`changeSince(entity, since, until?)` SHALL resolve to how much a cumulative sensor (e.g. an energy meter with state class `total` or `total_increasing`) increased over the range. It SHALL account for meter resets, as Home Assistant's statistics do.

#### Scenario: Energy consumed today
- **WHEN** `sensor.house_energy` read 1200.0 kWh at midnight and reads 1213.5 kWh now
- **THEN** `changeSince("sensor.house_energy", <local midnight>)` resolves to 13.5

#### Scenario: Range starting within an hour
- **WHEN** `sensor.house_energy` read 1200.0 kWh at 12:34 and reads 1203.0 kWh at 15:00
- **THEN** `changeSince("sensor.house_energy", <12:34>)` at 15:00 resolves to 3.0, including the part of the hour before 13:00

#### Scenario: Range shorter than an hour
- **WHEN** `sensor.house_energy` read 1200.0 kWh ten minutes ago and reads 1200.4 kWh now
- **THEN** `changeSince("sensor.house_energy", "10m")` resolves to 0.4 and no warning is logged

#### Scenario: Meter reset within the range
- **WHEN** a `total_increasing` meter goes 50.0 → 52.0 → 0.0 (reset) → 1.5 within the range
- **THEN** `changeSince` resolves to 3.5

#### Scenario: Small dip is not a reset
- **WHEN** a `total_increasing` meter goes 1000.0 → 999.9 → 1000.2 within the range
- **THEN** `changeSince` treats the dip as Home Assistant's statistics do (no reset) and resolves to 0.2

### Requirement: History unavailable
When Home Assistant's recorder is not available, history functions SHALL reject with an error stating that the recorder is required. For entities excluded from recording, they SHALL resolve to an empty result or `undefined` and log a warning once per entity and rule. A query that is empty only because its range lies before the entity's first record SHALL NOT log this warning.

#### Scenario: Entity excluded from recorder
- **WHEN** `sensor.noisy` is excluded from the recorder and a rule calls `history("sensor.noisy", "1h")`
- **THEN** the promise resolves to an empty array and a warning is logged once

#### Scenario: Range before the first record
- **WHEN** `sensor.new` is recorded since today and a rule calls `stateAt("sensor.new", <yesterday>)`
- **THEN** the promise resolves to `undefined` and no warning is logged
