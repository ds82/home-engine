# History

Rules can query the past that Home Assistant's recorder keeps: how an entity changed, what it
was at some time, averages and extremes, how much a meter rose, and long-term statistics.

| Function                               | Resolves to                                                 |
| -------------------------------------- | ----------------------------------------------------------- |
| `history(entity, since, until?)`       | the state changes in the range, oldest first                |
| `stateAt(entity, time)`                | the state in effect at `time`, or `undefined`               |
| `lastChangedTo(entity, value, since?)` | the last time the entity changed to `value`, or `undefined` |
| `averageSince(entity, since, until?)`  | the time-weighted average of the numeric states             |
| `minimumSince` / `maximumSince`        | the lowest / highest numeric state                          |
| `changeSince(entity, since, until?)`   | how much a cumulative sensor (energy, water, …) rose        |
| `statistics(id, options)`              | Home Assistant's long-term statistics per period            |

All of them ask Home Assistant on every call; nothing is cached. If a rule needs an aggregate
very often, keep a running value in the rule instead.

## Points in time

Wherever a time is expected you can pass:

- a `Date`,
- an ISO 8601 string such as `"2026-10-11T08:00:00+02:00"`,
- a duration meaning "that long ago": `"30m"`, `"24h"`, `"7d"`.

The end of a range defaults to now. Plain numbers are rejected, because "milliseconds ago" and
"milliseconds since 1970" are too easy to mix up; write `"5m"` or `new Date(ms)`.

## State history

```ts
import { daily, history, lastChangedTo, rule, stateAt } from "@home-engine/sdk";

rule("pump report", daily("20:00"), async () => {
  for (const { state, at } of await history("switch.pump", "12h")) {
    console.log(`${at.toLocaleTimeString()}: ${state}`);
  }

  const lastNight = await stateAt("cover.bath", new Date(Date.now() - 18 * 3_600_000));
  const arrived = await lastChangedTo("person.dennis", "home");
  console.log(lastNight, arrived?.toLocaleTimeString() ?? "not home yet today");
});
```

The first `history` entry is the state that was already in effect at the start of the range,
dated at the start: for a pump that was off at 08:00, switched on at 09:00 and off at 09:30,
`history("switch.pump", <08:30>)` gives `off @ 08:30, on @ 09:00, off @ 09:30`. Updates that
only change attributes are left out.

`lastChangedTo` looks back to local midnight (in Home Assistant's time zone) unless you pass
`since`. A state that was already in effect at the start does not count as a change: someone
home since yesterday has not changed to `home` today.

## Averages, minimum and maximum

```ts
import { averageSince, maximumSince, minimumSince, onChange, rule } from "@home-engine/sdk";

rule("temperature summary", onChange("binary_sensor.window", { to: "off" }), async () => {
  const average = await averageSince("sensor.living_room_temperature", "24h");
  const low = await minimumSince("sensor.living_room_temperature", "24h");
  const high = await maximumSince("sensor.living_room_temperature", "24h");
  if (average !== undefined) {
    console.log(`24 h: Ø ${average.toFixed(1)} (${low}–${high})`);
  }
});
```

The average is weighted by time: a sensor at 10 for three hours and at 20 for one hour averages
12.5 over those four hours, however often it reported. `unknown` and `unavailable` periods are
left out entirely. If there is no numeric state in the range at all, the result is
`undefined`.

When the range starts before the oldest history the recorder keeps (10 days by default), the
older part is filled in from Home Assistant's hourly long-term statistics. That only works for
sensors with a `state_class`.

## Meters: `changeSince`

```ts
import { changeSince, daily, rule } from "@home-engine/sdk";

rule("energy today", daily("23:59"), async () => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const kWh = await changeSince("sensor.house_energy", midnight);
  console.log(`Used ${kWh?.toFixed(1) ?? "?"} kWh today`);
});
```

`changeSince` works for sensors with state class `total` or `total_increasing` and uses Home
Assistant's statistics, which handle meter resets. Statistics are compiled per hour, so it
counts from the first full hour after `since`: start at a full hour (such as midnight) for an
exact result. When the range ends now, the current hour is added from the live reading. It
resolves to `undefined` for sensors without statistics.

## Long-term statistics

```ts
import { rule, onStartup, statistics } from "@home-engine/sdk";

rule("monthly means", onStartup(), async () => {
  const days = await statistics("sensor.living_room_temperature", {
    since: "30d",
    period: "day",
    types: ["mean", "min", "max"],
  });
  for (const day of days) {
    console.log(day.start.toDateString(), day.mean, day.min, day.max);
  }
});
```

`period` is `5minute`, `hour` (default), `day`, `week` or `month`. `types` are any of `mean`,
`min`, `max` (default), `sum`, `state` and `change`; each entry carries `start`, `end` and the
requested values Home Assistant has for it. The ID is usually the entity ID; statistics
imported by integrations use IDs like `"tibber:energy_consumption"`.

## When there is no data

- Without Home Assistant's `recorder` integration (it is part of `default_config:`) every
  history function rejects with an error saying so.
- Entities excluded from the recorder, or without statistics, give an empty array or
  `undefined`, and a warning is logged once per entity and rule.
- While the engine is not connected to Home Assistant, history functions reject at once.
