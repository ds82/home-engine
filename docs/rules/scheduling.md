# Scheduling

Time-based triggers start rules at clock times, intervals or sun events. Delays (`sleep`,
`after`) pause or postpone work inside a rule. All of them use Home Assistant's time zone and
location, not the container's.

| Trigger                 | Fires                                                     | Event `type` |
| ----------------------- | --------------------------------------------------------- | ------------ |
| `daily(time, opts)`     | every day at a local time, optionally on some weekdays    | `"time"`     |
| `cron(expression)`      | on a cron schedule                                        | `"time"`     |
| `every(interval, opts)` | repeatedly at a fixed interval after the rule starts      | `"time"`     |
| `sun(event, opts)`      | daily at sunrise, sunset, dawn or dusk, optionally offset | `"sun"`      |

Time events carry `scheduledAt`, the time the run was due. Sun events also carry the `event`
name.

## Durations

Wherever a duration is expected, use milliseconds or a string made of numbers and units:
`"500ms"`, `"30s"`, `"5m"`, `"1h30m"`, `"1d"`. Anything else (`"5 minutes"`) throws where you
wrote it.

## Daily times: `daily`

```ts
import { daily, rule } from "@home-engine/sdk";

rule("workday alarm", daily("06:30", { weekdays: ["mon", "tue", "wed", "thu", "fri"] }), () => {
  // open the blinds
});
```

The time is `"HH:MM"` or `"HH:MM:SS"` in Home Assistant's local time. Weekdays are `mon`, `tue`,
`wed`, `thu`, `fri`, `sat` and `sun`.

## Cron expressions: `cron`

```ts
import { cron, rule } from "@home-engine/sdk";

rule("every second hour", cron("0 */2 * * *"), () => {});
rule("at 22:13:30", cron("30 13 22 * * *"), () => {});
```

Standard 5-field expressions (minute, hour, day of month, month, day of week) and 6-field ones
with seconds in front are accepted. An invalid expression such as `cron("61 * * * *")` throws an
error naming the invalid field, so the rule file fails to load instead of never firing.

## Intervals: `every`

```ts
import { every, rule } from "@home-engine/sdk";

rule("poll the weather station", every("15m", { immediate: true }), () => {});
rule("quarter hours", every("15m", { alignTo: "00:00" }), () => {});
```

`every` fires repeatedly after the rule starts, at a fixed pace that does not drift with how
long your body takes. `immediate: true` also fires right after the rule starts. `alignTo` lines
the interval up with a local time, so `every("15m", { alignTo: "00:00" })` fires at :00, :15,
:30 and :45.

## Sun events: `sun`

```ts
import { rule, sun } from "@home-engine/sdk";

rule("porch light on before sunset", sun("sunset", { offset: "-30m" }), () => {});
rule("blinds up at dawn", sun("dawn"), () => {});
```

Events are `sunrise`, `sunset`, `dawn` (civil dawn) and `dusk`. The offset can be negative
(`"-30m"`) or positive (`"+15m"`). Sun times are computed from the location configured in Home
Assistant. Near the poles, a day may have no sunset or sunrise at all; on such days the trigger
does not fire, and the engine notes this in the debug log.

### Sun helpers

For decisions inside a rule, use the sun helpers. They work for the current local day:

```ts
import { isAfterSunset, isBeforeSunrise, isSunUp, nextSun, onChange, rule } from "@home-engine/sdk";

rule("light only in the dark", onChange("binary_sensor.hall_motion", { to: "on" }), () => {
  if (isSunUp()) return;
  if (isAfterSunset() || isBeforeSunrise()) {
    // switch the light on
  }
  console.log(`next sunrise: ${nextSun("sunrise")?.toISOString()}`);
});
```

## Waiting inside a rule: `sleep` and `after`

`sleep` pauses a rule body. It is tied to the run: if the rule is reloaded or a `restart` rule
fires again, the code after the `sleep` never runs.

```ts
import { cron, randomInt, rule, sleep } from "@home-engine/sdk";

rule("close shutters at a random time after 22:13", cron("13 22 * * *"), async () => {
  await sleep(`${randomInt(1, 30)}m`);
  // close the shutters
});
```

`randomInt(min, max)` returns a whole number between `min` and `max`, both included.

`after` runs a callback once later without blocking the body. Its handle can cancel it and tells
when it will run; it is cancelled automatically together with its run and when the rule is
unloaded:

```ts
import { after, onChange, rule } from "@home-engine/sdk";

rule("garden light for 10 minutes", onChange("binary_sensor.garden_motion", { to: "on" }), () => {
  const off = after("10m", () => {
    // switch the light off
  });
  console.log(`switching off at ${off.nextRun?.toISOString()}`);
});
```

Prefer `onChange(…, { for })` over `sleep` for "has been on for 10 minutes" logic: a hold
survives reloads and restarts, a `sleep` does not. See [triggers](triggers.md).

## Time zone and daylight saving time

All schedules use Home Assistant's time zone, or `TIME_ZONE` if you set it. The container's
own time zone does not matter: with Home Assistant set to `Europe/Berlin`, `daily("07:00")`
runs at 07:00 Berlin time even in a container that runs on UTC. If you change the time zone or
location in Home Assistant, pending schedules are recomputed.

On the days the clocks change:

- **Spring forward:** a time that does not exist (02:30 when clocks jump from 02:00 to 03:00)
  runs once at the first valid moment after the gap, 03:00.
- **Fall back:** a time that happens twice (02:30 when clocks go back from 03:00 to 02:00) runs
  only once.

`cron` expressions follow the cron library's rules on those days; use `daily` for times in the
02:00–03:00 window if the behaviour above matters to you.

## Reliability

- **No drift:** waits target a clock time and re-check the clock at least once a minute, so
  they are correct after NTP corrections and after the host was suspended, and delays longer
  than 24 days work.
- **No catch-up:** a schedule that was due while the engine was not running is not run late. If
  the engine is down at 07:00, `daily("07:00")` next runs tomorrow at 07:00. (Held states of
  `onChange(…, { for })` are different: those are restored; see [triggers](triggers.md).)
- **Next run:** the rule status shows when each time trigger fires next. Handles returned by
  `after` and by `listen()` for time triggers expose `nextRun` as well.
