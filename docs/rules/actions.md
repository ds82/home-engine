# Reading state and acting

Rules read Home Assistant's state synchronously from the engine's local copy and act through
service calls, events and virtual entities. Every write is attributed to the calling rule: in
the logs, in [dry-run](#dry-run) output and in the `causedByRule` of the state changes it
causes.

## Reading state

| Function                   | Returns                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `getState(entity)`         | the state value (`"on"`, `"21.5"`, …) or `undefined` for unknown IDs  |
| `getEntity(entity)`        | the full state object: `state`, `attributes`, `last_changed`, …       |
| `getEntities(patterns)`    | state objects of all entities matching IDs or globs such as `light.*` |
| `members(group)`           | the entity IDs of a group, or `[]`                                    |
| `getNumber(entity, attr?)` | the state or an attribute as a number, or `undefined` if not numeric  |
| `is(entity, value)`        | whether the state equals `value`                                      |
| `isOn` / `isOff`           | whether the state is `on` / `off`                                     |
| `isOpen` / `isClosed`      | `open` / `closed`; for a `binary_sensor` also `on` / `off`            |

```ts
import { getEntities, getNumber, isOn, onChange, rule } from "@home-engine/sdk";

rule("too warm", onChange("sensor.living_room_temperature"), () => {
  const temperature = getNumber("sensor.living_room_temperature");
  if (temperature === undefined) return; // unknown, unavailable or not a number
  if (temperature > 26 && !isOn("switch.fan")) {
    const open = getEntities("binary_sensor.*_window").filter((w) => w.state === "on");
    console.log(`${open.length} windows open at ${temperature} °C`);
  }
});
```

Reads never throw for unknown entities and never wait for Home Assistant. The predicates return
`false` for entities that are `unavailable` or `unknown`, so `isOff("switch.pump")` is not true
just because the pump went offline.

## Switching: `on` versus `forceOn`

`on` and `off` only send something when the entity is not already in that state. `forceOn`,
`forceOff` and `toggle` always send.

```ts
import { forceOn, off, on, onChange, rule } from "@home-engine/sdk";

rule("hall light", onChange("binary_sensor.hall_motion", { to: "on" }), async () => {
  await on("light.hall"); // nothing is sent if the light is already on
  await forceOn("light.hall", { brightness_pct: 30 }); // dims it even when it is on
});

rule("fan off", onChange("binary_sensor.window", { to: "on" }), () => off("switch.fan"));
```

Use `on` for "make sure it is on" and `forceOn` when the data matters, such as a new brightness
or colour. A skipped `on` is logged at `debug` level. Each uses the domain's own service
(`light.turn_on`), or `homeassistant.turn_on` / `homeassistant.toggle` for domains that do not
have one.

## Covers: `up` and `down`

`up(cover, position = 100)` and `down(cover, position = 0)` move a cover to a position unless it
is already there or beyond: `up("cover.bath", 50)` does nothing when the cover is 70 % open, and
`down("cover.bath", 50)` does nothing when it is 30 % open. Covers without a known position are
always moved.

```ts
import { down, rule, sun, up } from "@home-engine/sdk";

rule("morning", sun("sunrise"), () => up("cover.bedroom"));
rule("evening", sun("sunset"), () => down("cover.living_room", 20)); // leave a gap
```

Positions follow Home Assistant: **0 is closed and 100 is open**. openHAB's rollershutters count
the other way round (0 = up, 100 = down), so when porting rules, `sendCommand(shutter, 80)`
becomes `down(cover, 20)`.

## Service calls: `call`

```ts
import { call, daily, rule } from "@home-engine/sdk";

rule("morning briefing", daily("07:00"), async () => {
  await call("notify.mobile_app_phone", { message: "Good morning" });
  await call("light.turn_on", { brightness_pct: 50 }, { area_id: "kitchen" });

  const forecast = await call(
    "weather.get_forecasts",
    { type: "daily" },
    { entity_id: "weather.home" },
    { returnResponse: true },
  );
  console.log(forecast);
});
```

`call(service, data?, target?, options?)` resolves once Home Assistant acknowledged the call,
with the service's response data when `returnResponse` is set. It rejects with Home Assistant's
error code and message, for example for an unknown service, and rejects at once while the
engine is not connected: writes are never queued.

You may leave out `await`. A write that fails without anyone awaiting it is logged as an error
of your rule; it never crashes the engine.

## Events: `fire`

```ts
import { fire, onChange, rule } from "@home-engine/sdk";

rule("alarm", onChange("binary_sensor.smoke", { to: "on" }), () =>
  fire("home_engine_alert", { level: "high" }),
);
```

Home Assistant automations listening to `home_engine_alert` receive the data. It must be
JSON-serialisable; anything else throws where you call `fire`.

## Virtual entities: `setState`

`setState(entity, state, attributes?)` creates or updates an entity in Home Assistant's state
machine, for example to show a computed value on a dashboard:

```ts
import { getNumber, onChange, rule, setState } from "@home-engine/sdk";

rule("comfort", onChange("sensor.living_room_humidity"), () => {
  const humidity = getNumber("sensor.living_room_humidity") ?? 0;
  void setState("sensor.living_room_comfort", humidity < 60 ? "good" : "humid", {
    friendly_name: "Comfort",
  });
});
```

Such entities are not real Home Assistant entities, and they have limitations:

- They have no unique ID, so they cannot be renamed or customised in the UI, assigned to an
  area or kept in the entity registry.
- Home Assistant forgets them when it restarts. The engine sets them again with their last value
  when it reconnects, as long as the rule that set them last is still loaded.
- The engine does not keep their values across its own restarts either. Until a rule sets an
  entity again, Home Assistant shows nothing (or `unavailable`) for it.

If an entity needs a value right after the engine starts, store it and set it again from
`onStartup`:

```ts
import { onChange, onStartup, rule, setState, store } from "@home-engine/sdk";

rule("last motion", [onStartup(), onChange("binary_sensor.hall_motion", { to: "on" })], (e) => {
  if (e.type === "state") store.set("lastMotion", new Date().toISOString());
  const last = store.get<string>("lastMotion");
  if (last) void setState("sensor.home_engine_last_motion", last, { device_class: "timestamp" });
});
```

## Raw WebSocket commands and the connection

`ws.command(message)` sends any WebSocket command the engine does not wrap and resolves with its
result. `connection` tells whether the engine is connected and notifies a rule about
disconnects and reconnects; the callbacks are released when the rule is unloaded.

```ts
import { connection, onStartup, rule, ws } from "@home-engine/sdk";

rule("registry", onStartup(), async () => {
  const entities = await ws.command<Array<{ entity_id: string }>>({
    type: "config/entity_registry/list",
  });
  console.log(`${entities.length} registered entities`);

  connection.onDisconnect(() => console.warn("Home Assistant went away"));
  connection.onConnect(() => console.log("back, connected:", connection.isConnected()));
});
```

## Dry run

With `DRY_RUN=true` the engine logs every service call, `fire` and `setState` at `info` level
instead of sending it, with the rule ID and the full payload:

```text
INFO: [dry-run] lights#porch light.turn_on
    target: { "entity_id": "light.porch" }
    data: {}
```

The write resolves as if it had succeeded (a call asking for response data receives `{}`).
Reads, history, triggers and the `on`/`off` skip work as usual, so you can run new rules against
your real home without them touching anything. Raw `ws.command()` messages are sent in dry-run
too, because they are mostly reads; avoid sending writes through them while testing.
