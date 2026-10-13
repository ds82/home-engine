# Spec Delta

## MODIFIED Requirements

### Requirement: Clock drift and sleep robustness
Long delays and scheduled times SHALL NOT drift when the host is suspended or the system clock is adjusted. Schedules SHALL be computed against wall-clock target times, not accumulated relative timeouts. A time-trigger run that is more than one minute late (for example after a host suspend) SHALL be skipped like a run missed while the engine was down, and the next run SHALL be computed from the current time.

#### Scenario: System clock corrected by NTP
- **WHEN** the system clock jumps forward by 2 minutes before a `"07:00"` daily schedule
- **THEN** the body runs at 07:00 according to the corrected clock

#### Scenario: Very long delay
- **WHEN** a rule calls `after("30d", fn)` (beyond the runtime's maximum timer duration)
- **THEN** `fn` still runs once after 30 days

#### Scenario: Host suspended over several daily runs
- **WHEN** a rule triggers on `daily("07:00")` and the host is suspended from Monday 06:00 to Thursday 05:00
- **THEN** the body does not run for the missed times, the skipped run is logged at `debug` level, and the body next runs on Thursday at 07:00

#### Scenario: Interval schedule after a long suspend
- **WHEN** a rule triggers on `every("1m")` and the host is suspended for three days
- **THEN** the missed runs are skipped, the engine keeps running, and the body next runs at the first point of the interval's grid after the wake-up time

#### Scenario: Run slightly late
- **WHEN** a busy event loop delays a `daily("07:00")` timer until 07:00:20
- **THEN** the body still runs, because a run less than one minute late is not considered missed
