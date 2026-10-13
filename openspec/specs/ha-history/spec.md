# ha-history Specification

## Purpose

Lets rules query the past: entity history recorded by Home Assistant's recorder and long-term statistics. Rules can answer questions like "what was the average temperature in the last 24 hours" or "when did presence last switch to home today".

## Requirements

### Requirement: Time arguments
Every history function SHALL accept points in time as a `Date`, an ISO 8601 string, or a duration meaning "that long before now" (e.g. `"24h"`, `"7d"`). The end of a range SHALL default to now.

#### Scenario: Duration as start time
- **WHEN** a rule calls `averageSince("sensor.temperature", "24h")` at 12:00
- **THEN** the query covers the period from 12:00 the previous day until now

### Requirement: State history
`history(entity, since, until?)` SHALL return a promise resolving to the entity's recorded state changes in that range, ordered oldest first. Each entry SHALL contain the state value and the time it took effect. The first entry SHALL be the state in effect at `since`, if one is recorded.

#### Scenario: History of a switch
- **WHEN** `switch.pump` was `off` at 08:00, turned `on` at 09:00 and `off` at 09:30, and a rule calls `history("switch.pump", <today 08:30>)`
- **THEN** it receives `[off @ 08:30, on @ 09:00, off @ 09:30]`

### Requirement: State at a point in time
`stateAt(entity, time)` SHALL resolve to the state value that was in effect at the given time, or `undefined` if none is recorded.

#### Scenario: Historic state
- **WHEN** `cover.bath` was at `closed` from 22:00 to 07:00 and a rule calls `stateAt("cover.bath", <today 03:00>)`
- **THEN** it receives `closed`

### Requirement: Last change to a value
`lastChangedTo(entity, value, since?)` SHALL resolve to the most recent time the entity changed to the given value within the range (default: since local midnight), or `undefined` if it did not.

#### Scenario: Arrival time today
- **WHEN** `person.dennis` changed to `home` at 07:10 and again at 17:45 today
- **THEN** `lastChangedTo("person.dennis", "home")` resolves to today 17:45

### Requirement: Numeric aggregates
`averageSince`, `minimumSince` and `maximumSince` (each taking entity, since, until?) SHALL resolve to the aggregate of the entity's numeric states over the range. The average SHALL be time-weighted. Non-numeric states (`unknown`, `unavailable`) SHALL be excluded, and the result SHALL be `undefined` if no numeric state exists in the range.

#### Scenario: Time-weighted average
- **WHEN** a sensor was 10 for 3 hours and 20 for 1 hour within the queried 4-hour range
- **THEN** `averageSince` resolves to 12.5

#### Scenario: Only unavailable states
- **WHEN** a sensor was `unavailable` during the whole range
- **THEN** `averageSince`, `minimumSince` and `maximumSince` resolve to `undefined`

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

### Requirement: Long-term statistics
`statistics(entity, options)` SHALL return Home Assistant's long-term statistics for a statistic ID over a range. The period (`5minute`, `hour`, `day`, `week`, `month`) and the requested types (`mean`, `min`, `max`, `sum`, `state`, `change`) SHALL be selectable. Aggregate functions SHALL fall back to long-term statistics when the range starts before the recorder's retained history.

#### Scenario: Daily statistics
- **WHEN** a rule requests daily `mean` statistics for `sensor.temperature` over the last 30 days
- **THEN** it receives up to 30 entries with start time and mean value

#### Scenario: Range older than recorder retention
- **WHEN** the recorder keeps 10 days of history and a rule calls `averageSince("sensor.temperature", "30d")` on a sensor with long-term statistics
- **THEN** the result is computed from long-term statistics for the part older than the retained history

### Requirement: History unavailable
When Home Assistant's recorder is not available, history functions SHALL reject with an error stating that the recorder is required. For entities excluded from recording, they SHALL resolve to an empty result or `undefined` and log a warning once per entity and rule. A query that is empty only because its range lies before the entity's first record SHALL NOT log this warning.

#### Scenario: Entity excluded from recorder
- **WHEN** `sensor.noisy` is excluded from the recorder and a rule calls `history("sensor.noisy", "1h")`
- **THEN** the promise resolves to an empty array and a warning is logged once

#### Scenario: Range before the first record
- **WHEN** `sensor.new` is recorded since today and a rule calls `stateAt("sensor.new", <yesterday>)`
- **THEN** the promise resolves to `undefined` and no warning is logged
