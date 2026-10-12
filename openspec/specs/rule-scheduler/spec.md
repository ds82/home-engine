# rule-scheduler Specification

## Purpose

Provides time-based triggers for rules (delays, intervals, daily times, cron schedules and sun events). They are evaluated in Home Assistant's time zone and location so schedules behave as users expect.

## Requirements

### Requirement: Time zone and location from Home Assistant
The scheduler SHALL use the time zone, latitude, longitude and elevation from Home Assistant's core configuration, fetched after each connect. A configured time zone override SHALL take precedence.

#### Scenario: Container in UTC, Home Assistant in Europe/Berlin
- **WHEN** the container's system time zone is UTC and Home Assistant is configured for `Europe/Berlin`
- **THEN** a rule triggered by `daily("07:00")` runs at 07:00 Berlin local time

### Requirement: Time trigger constructors
The SDK SHALL provide time-based trigger constructors usable wherever triggers are accepted: `cron(expression)`, `daily(time, options?)`, `every(interval, options?)` and `sun(event, options?)`. Their events SHALL carry `type: "time"` (or `type: "sun"` with the sun event name) and the scheduled time.

#### Scenario: Mixing time and state triggers
- **WHEN** a rule is registered with `[daily("07:12"), sun("sunrise")]`
- **THEN** the body runs at 07:12 local time and at sunrise every day, with an event telling which trigger fired

### Requirement: Durations
Wherever a duration is accepted, the engine SHALL accept milliseconds as a number or a human-readable string (`"500ms"`, `"30s"`, `"5m"`, `"1h30m"`, `"1d"`). Malformed strings SHALL throw at the call site.

#### Scenario: Malformed duration
- **WHEN** rule code calls `sleep("5 minutes")`
- **THEN** the call throws an error naming the invalid duration

### Requirement: Delay
The SDK SHALL provide `sleep(duration)`, a promise that resolves after the duration and rejects when the rule is unloaded or the current run is aborted. It SHALL also provide `after(duration, callback)`, which runs a callback once after the duration and returns a cancellable handle.

#### Scenario: Run once after delay
- **WHEN** a rule calls `after("10m", fn)`
- **THEN** `fn` runs once, 10 minutes later

#### Scenario: Awaitable delay is cancelled on unload
- **WHEN** a rule awaits `sleep("1h")` and is unloaded after 5 minutes
- **THEN** the awaiting code does not continue past the sleep

#### Scenario: Random delay
- **WHEN** a rule awaits `sleep(`${randomInt(1, 30)}m`)`
- **THEN** execution continues after the computed number of minutes

### Requirement: Interval
The `every(interval)` trigger SHALL fire repeatedly at a fixed interval after the rule starts, optionally aligned to a given start time or firing immediately on start.

#### Scenario: Every 15 minutes
- **WHEN** a rule triggers on `every("15m")`
- **THEN** the body runs every 15 minutes until the rule is unloaded

### Requirement: Daily time
The `daily(time)` trigger SHALL fire every day at a local wall-clock time (`"HH:MM"` or `"HH:MM:SS"`), optionally limited to specific weekdays.

#### Scenario: Weekdays only
- **WHEN** a rule triggers on `daily("06:30", { weekdays: ["mon", "tue", "wed", "thu", "fri"] })`
- **THEN** the body runs at 06:30 local time on weekdays and not on weekends

#### Scenario: DST spring-forward
- **WHEN** a rule triggers on `daily("02:30")` and that time does not exist on the DST transition day
- **THEN** the body runs once at the first valid instant after the gap on that day

#### Scenario: DST fall-back
- **WHEN** a rule triggers on `daily("02:30")` and that time occurs twice on the DST transition day
- **THEN** the body runs only once on that day

### Requirement: Cron expressions
The `cron(expression)` trigger SHALL accept a standard 5-field cron expression or a 6-field one (with seconds), evaluated in the scheduler time zone. Invalid expressions SHALL make the constructor throw.

#### Scenario: Valid cron
- **WHEN** a rule triggers on `cron("0 */2 * * *")`
- **THEN** the body runs at minute 0 of every second hour

#### Scenario: Invalid cron
- **WHEN** a rule file calls `cron("61 * * * *")`
- **THEN** the call throws an error describing the invalid field, and the error is attributed to the file or rule

### Requirement: Sun events
The `sun(event, { offset? })` trigger SHALL fire daily at `sunrise`, `sunset`, `dawn` or `dusk`, with an optional positive or negative offset. Sun times SHALL be computed from Home Assistant's location.

#### Scenario: Sunset with offset
- **WHEN** a rule triggers on `sun("sunset", { offset: "-30m" })`
- **THEN** the body runs every day 30 minutes before the computed local sunset

#### Scenario: No sunset (polar regions)
- **WHEN** the configured location has no sunset on a given day
- **THEN** the body does not run that day and the scheduler logs this at debug level

### Requirement: Sun state helpers
The SDK SHALL provide `isSunUp()`, `isAfterSunset()`, `isBeforeSunrise()` and `nextSun(event)` helpers, computed for the current local day.

#### Scenario: Night check
- **WHEN** rule code calls `isSunUp()` at 23:00 local time in a temperate location
- **THEN** it returns `false`

### Requirement: Next run reporting and cleanup
The engine SHALL know the next run time of every armed time trigger and report it in the rule status output. Handles returned by `after` and by time listeners of setup rules SHALL be cancellable and report their next run time. All schedules SHALL be cancelled automatically on rule unload.

#### Scenario: Next run reported
- **WHEN** a rule triggered by `daily("07:00")` is inspected through the rule status endpoint at 06:00
- **THEN** today's 07:00 local time is reported as its next run

### Requirement: Clock drift and sleep robustness
Long delays and scheduled times SHALL NOT drift when the host is suspended or the system clock is adjusted. Schedules SHALL be computed against wall-clock target times, not accumulated relative timeouts.

#### Scenario: System clock corrected by NTP
- **WHEN** the system clock jumps forward by 2 minutes before a `"07:00"` daily schedule
- **THEN** the body runs at 07:00 according to the corrected clock

#### Scenario: Very long delay
- **WHEN** a rule calls `after("30d", fn)` (beyond the runtime's maximum timer duration)
- **THEN** `fn` still runs once after 30 days

### Requirement: Missed schedules are not replayed
Schedules whose run time passed while the engine was not running SHALL NOT be executed retroactively at startup. This applies to time triggers only; holds of state triggers in progress are restored (see rule-triggers: Hold restoration on rule start).

#### Scenario: Engine down at 07:00
- **WHEN** the engine is stopped from 06:55 to 07:05 and a rule triggers on `daily("07:00")`
- **THEN** the body does not run at 07:05 and next runs at 07:00 the following day
