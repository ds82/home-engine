# Triggers

A trigger describes what starts a run of a rule: a state change, a bus event, a native Home
Assistant trigger, the rule's start, or a time (see [scheduling](scheduling.md)). Triggers are
plain values. Creating one does nothing until you pass it to `rule()` or `listen()`, so you
can build them in helpers and reuse them.

| Trigger                       | Fires when                                                     | Event `type`   |
| ----------------------------- | -------------------------------------------------------------- | -------------- |
| `onChange(entities, options)` | entity states (or attributes) change                           | `"state"`      |
| `onEvent(type, filter)`       | a Home Assistant bus event of that type arrives                | `"event"`      |
| `onTrigger(config)`           | a native Home Assistant trigger fires (as in YAML automations) | `"ha-trigger"` |
| `onStartup()`                 | the rule starts: engine start, reload, re-enable               | `"startup"`    |

Arguments are checked when the trigger is created, so a typo such as `{ too: "on" }` makes the
file fail to load with a clear error instead of silently never firing.

## State changes: `onChange`

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("hall motion", onChange("binary_sensor.hall_motion", { to: "on" }), (event) => {
  console.log(`${event.entityId}: ${event.from?.state} → ${event.to?.state}`);
});
```

`entities` is one entity ID, a list, or a glob such as `light.*` or `sensor.*_temperature`.
Globs also match entities created later. Creating an entity fires with `event.from`
undefined, removing one with `event.to` undefined.

### Filters

`from` and `to` take a value, a list of values or a predicate. The trigger fires only when all
given filters match. A created or removed entity never matches a value filter.

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("left home", onChange("person.dennis", { from: "home", to: "not_home" }), () => {});

rule("heating modes", onChange("climate.living", { to: ["heat", "auto"] }), () => {});

rule("too warm", onChange("sensor.temperature", { to: (value) => Number(value) > 25 }), () => {});
```

### Unavailable devices

When a device drops off the network, its state goes `unavailable` (or `unknown`) and comes
back later. By default these transitions are delivered like any other change, so
`{ to: "on" }` fires again when an `on` light becomes available again. With
`ignoreUnavailable: true` such transitions count as no change: `on → unavailable → on` does not
fire, while `off → unavailable → on` fires once, as `off → on`.

### Attributes

By default, only changes of the state value count; a light changing its brightness does not
fire `onChange("light.kitchen")`. Watch one attribute with `attribute`, or every attribute
with `attribute: "*"`:

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("brightness changed", onChange("light.kitchen", { attribute: "brightness" }), (event) => {
  console.log(`brightness ${String(event.oldValue)} → ${String(event.newValue)}`);
});
```

With `attribute`, the filters apply to the attribute's value.

## Holding a state: `for`

With `for`, the trigger fires only after the entity has kept a matching value for that long:

```ts
import { onChange, rule } from "@home-engine/sdk";

rule(
  "lawn watering off after 20 minutes",
  onChange("switch.lawn_watering", { to: "on", for: "20m" }),
  () => {
    // turn it off
  },
);
```

Durations are milliseconds or strings such as `"500ms"`, `"30s"`, `"5m"`, `"1h30m"` or `"1d"`.

Every change restarts the hold if the new value matches and cancels it if not. A change from
one matching value to another (26 °C → 27 °C with `to: (v) => Number(v) > 25`) restarts it too.
Without filters, `for` works as a debounce: the trigger fires once the entity stopped changing.

With several entities, each one has its own hold. Use `holdAs: "group"` for one shared hold, for
example "30 seconds after the window settled, whichever sensor moved last":

```ts
import { onChange, rule } from "@home-engine/sdk";

rule(
  "bathroom window settled",
  onChange(["binary_sensor.bath_window_tilt", "binary_sensor.bath_window_open"], {
    for: "30s",
    holdAs: "group",
  }),
  (event) => console.log(`last change: ${event.entityId}`),
);
```

### Holds survive reloads and restarts

A hold is a timer, but saving the file or restarting the engine does not lose it. When a rule
starts, the engine rebuilds pending holds from the entities' `last_changed` time (`last_updated`
for attribute triggers) and fires after the remaining time. If the full duration passed while
the engine was down, the rule fires right after it starts. These events have
`event.restored === true`.

The engine remembers which holds already fired, so a door that has been open for days does not
notify you again on every reload. Changing a trigger (for example `for: "5m"` to `"10m"`) makes
it a new one, which may fire once.

Some holds cannot be restored:

- With a `from` filter, the engine cannot tell from the current state which state came before.
- Listeners registered after a setup function finished (for example inside a callback) start
  without a restored hold.
- With `ignoreUnavailable`, a restored hold counts from the end of the last unavailability, so
  after a reload it may fire later than it would have without the reload, never earlier.

### Holds and connection drops

If the connection to Home Assistant drops while a hold runs out, the engine waits until it is
connected again and fires only if the entity did not change in the meantime. A change that
happened while disconnected counts from its own `last_changed` time.

## Firing for the current state: `immediate`

With `immediate: true`, the trigger also fires once when the rule starts if the entity's current
state already matches `to`:

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("porch light is on", onChange("light.porch", { to: "on", immediate: true }), () => {});
```

`immediate` cannot be combined with `for` (held states are restored anyway) or with `from`
(there is no previous state to check).

## Bus events: `onEvent`

```ts
import { onEvent, rule } from "@home-engine/sdk";

rule(
  "remote button 1 or 2",
  onEvent("zha_event", { device_ieee: "00:11:22", args: { button: [1, 2] } }),
  (event) => console.log(event.eventType, event.data, event.timeFired),
);
```

The data filter matches partially: listed keys must match, others are ignored. Nested objects
match recursively, and each value can be a literal, a list of allowed values or a predicate.
You can also pass one predicate for the whole data: `onEvent("zha_event", (data) => …)`.

## Native Home Assistant triggers: `onTrigger`

Any trigger configuration you would write in a YAML automation works, which gives you
`numeric_state`, `zone`, `template`, device triggers and everything integrations add:

```ts
import { onTrigger, rule } from "@home-engine/sdk";

rule(
  "humid bathroom",
  onTrigger({ platform: "numeric_state", entity_id: "sensor.humidity", above: 70 }),
  (event) => console.log(event.variables),
);
```

If Home Assistant rejects the configuration, the rule keeps running with its other triggers.
The error is logged, shown as the rule's last error and listed on that trigger in the rule
status.

## Startup: `onStartup`

`onStartup()` fires once each time the rule starts: at engine start, after a reload and when
it is enabled again. It does not fire when the engine reconnects to Home Assistant.

## The event

The body receives one event per firing. Every event has `type`, the `trigger` that fired and an
`AbortSignal` in `signal`. Checking `event.type` tells TypeScript which fields exist:

```ts
import { onChange, onStartup, rule } from "@home-engine/sdk";

rule("narrowing", [onStartup(), onChange("sun.sun")], (event) => {
  if (event.type === "startup") {
    return;
  }
  console.log(event.entityId, event.to?.attributes);
});
```

A rule only receives the event types its triggers can produce. If one change matches two
triggers of the same rule, the body runs twice, once per trigger.

State events have these fields:

| Field                               | Meaning                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `entityId`                          | The entity that changed.                                                         |
| `from`, `to`                        | Old and new state objects (`state`, `attributes`, `last_changed`, …).            |
| `attribute`, `oldValue`, `newValue` | For attribute triggers: the attribute and its old and new value.                 |
| `causedBy`                          | `"engine"` if a rule of this engine made exactly this change, else `"external"`. |
| `causedByEngine`                    | Shorthand for `causedBy === "engine"`.                                           |
| `causedByRule`                      | The rule that made the change, when known.                                       |
| `resynced`                          | The change happened while the engine was disconnected.                           |
| `restored`                          | Fired by a hold restored when the rule started.                                  |

### Who changed it: `causedBy`

`causedBy` is `"engine"` only when one of your rules wrote this change itself. Devices, people,
Home Assistant automations (even ones reacting to an engine write) are `"external"`. Use it to
tell manual changes apart from your own, or to avoid feedback loops:

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("log manual switching", onChange("light.hall"), (event) => {
  if (event.causedByEngine) {
    return;
  }
  console.log(`someone switched the hall light ${event.to?.state}`);
});
```

### Changes missed while disconnected

After a reconnect (for example when Home Assistant restarted), the engine compares all states
with what it knew before. For every entity that differs, rules receive one event from the old
to the new state with `resynced: true`. A door opened during a Home Assistant restart still
runs your "door opened" rule. An entity that changed and changed back is not reported.

## Setup rules and `listen()`

Setup rules register listeners with `listen()` instead of a trigger list. Listeners use the same
triggers and events; they always run in parallel. If a setup function registers listeners only
under some condition, give them an `id`, so their holds are recognised after a reload even when
the number of listeners before them changes:

```ts
import { listen, onChange, setup } from "@home-engine/sdk";

setup("porch", () => {
  const nightMode = process.env.PORCH_NIGHT_MODE === "1";
  if (nightMode) {
    listen(onChange("binary_sensor.porch_motion", { to: "on" }), () => {});
  }
  listen(
    onChange("light.porch", { to: "on", for: "10m" }),
    () => console.log("porch light on for 10 minutes"),
    { id: "porch-light-on" },
  );
});
```

A listener `id` must be unique within its rule: a second `listen()` with an id that an active
listener of the same rule already uses throws, naming the id, and the first listener stays.
After `handle.cancel()` the id is free again. Different rules may use the same ids.

## Waiting inside a rule: `waitFor`

`waitFor(entity, filter, options)` waits until an entity matches a filter. It resolves with the
entity's state, or with `undefined` when the timeout passes:

```ts
import { onChange, rule, waitFor } from "@home-engine/sdk";

rule("garage closes behind me", onChange("light.garage", { to: "on" }), async () => {
  const off = await waitFor("light.garage", { to: "off" }, { timeout: "10m" });
  if (!off) {
    console.log("the garage light is still on after 10 minutes");
  }
});
```

With `for` in the options, the entity must keep matching that long. If it already matches when
you call `waitFor` and no `for` is given, it resolves immediately. `waitFor` rejects only when
the run is aborted (see `restart` below) or the rule is unloaded; the engine does not log those
as errors.

## Overlapping runs: `mode`

A triggered rule's `mode` decides what happens when a trigger fires while the body is still
running:

| Mode                 | Behaviour                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `parallel` (default) | Start another run. `max` limits how many run at once.                                                        |
| `single`             | Drop the new firing (a debug line is logged).                                                                |
| `queued`             | Run one at a time in arrival order; at most `max` (default 10) waiting or running, then drop with a warning. |
| `restart`            | Abort the running run and start a new one.                                                                   |

In `restart` mode the aborted run's `event.signal` aborts, and a pending `waitFor` rejects. Pass
the signal on to anything long-running that accepts one, such as `fetch`:

```ts
import { onChange, rule, waitFor } from "@home-engine/sdk";

rule(
  "presence light",
  onChange("binary_sensor.office_motion", { to: "on" }),
  async (event) => {
    await fetch("http://example.invalid/hook", { signal: event.signal }).catch(() => {});
    await waitFor("binary_sensor.office_motion", { to: "off" }, { for: "15m" });
  },
  { mode: "restart" },
);
```

Setup rules take no mode; their listeners always run in parallel.
