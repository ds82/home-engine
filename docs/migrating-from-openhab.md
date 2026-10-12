# Coming from openHAB

home-engine's rule API is modelled on openHAB JavaScript rules written with `@ds82/openhab`
(`addRule`, `changeStateTrigger`, `isOn`, `forceOn`, `up`/`down`, …), so most rules port line
by line. This page lists the differences that matter and a mapping of the functions.

## The big differences

- **Items become entities.** `Light_OG_Flur` becomes an entity ID such as `light.og_flur`.
  Groups become Home Assistant groups (read them with `members("group.x")`) or glob patterns in
  triggers (`onChange("binary_sensor.*_window")`).
- **Arguments are in trigger-first order.** `addRule(name, fn, triggers)` becomes
  `rule(name, triggers, fn)`.
- **There are no commands.** openHAB items take commands; Home Assistant entities are changed
  through services (`light.turn_on`). `on`, `off`, `forceOn`, `forceOff`, `toggle`, `up` and
  `down` do that for you; everything else is `call()`.
- **Cover positions are inverted.** openHAB rollershutters count 0 = up and 100 = down. Home
  Assistant counts 0 = closed and 100 = open. `down(cover, 20)` leaves a cover 20 % open, which
  was `sendCommand(shutter, 80)`.
- **History is asynchronous.** It comes from Home Assistant over the network, so `averageSince`
  and friends return promises: `await averageSince(...)`.
- **Rules reload safely.** Saving a file unloads its rules (timers, listeners) and loads the new
  version; `for` holds in progress are restored. A raw `setTimeout` in a rule file is cleared on
  reload too.

## Mapping

| openHAB (`@ds82/openhab`)                    | home-engine                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `addRule(name, fn, [triggers])`              | `rule(name, [triggers], fn)`                                                      |
| `changeStateTrigger(item)`                   | `onChange(entity)`                                                                |
| `changeStateTrigger(item, "ON")`             | `onChange(entity, { to: "on" })`                                                  |
| `changeStateTrigger(item, "ON", "OFF")`      | `onChange(entity, { to: "on", from: "off" })`                                     |
| `updateStateTrigger(item)`                   | `onChange(entity, { attribute: "*" })` (Home Assistant only reports real changes) |
| `timeTrigger("0 30 19 ? * *")`               | `daily("19:30")`, or `cron("0 30 19 * * *")`                                      |
| `timeTrigger("0 0/10 * * * ?")`              | `every("10m", { alignTo: "00:00" })`                                              |
| system start trigger                         | `onStartup()`                                                                     |
| `channelTrigger(channel, event)`             | `onEvent(type, data)` or `onTrigger({ platform: "device", … })`                   |
| `commandTrigger(item)`                       | `onEvent("call_service", { domain, service_data: … })`                            |
| `getState(item)`                             | `getState(entity)` (a string); numbers: `getNumber(entity)`                       |
| `isOn` / `isOff` / `isOpen` / `isClosed`     | the same names                                                                    |
| `on` / `off` (only if needed)                | `on` / `off` (only if needed)                                                     |
| `forceOn` / `forceOff` / `toggle`            | the same names                                                                    |
| `up(item, v)` / `down(item, v)`              | `up(cover, position)` / `down(cover, position)`, positions inverted               |
| `sendCommand(dimmer, 40)`                    | `forceOn(light, { brightness_pct: 40 })`                                          |
| `sendCommand(item, value)` (other)           | `call("<domain>.<service>", data, { entity_id })`                                 |
| `postUpdate(item, value)`                    | `setState(entity, value)` (a virtual entity)                                      |
| `historicState(item, date)`                  | `await stateAt(entity, date)`                                                     |
| `averageSince(item, date)`                   | `await averageSince(entity, date or "24h")`                                       |
| `minimumSince` / `maximumSince`              | `await minimumSince` / `await maximumSince`                                       |
| `sumSince(meter, date)`                      | `await changeSince(meter, date)`                                                  |
| `whenItemChangedTo(item, state, start, end)` | `await lastChangedTo(entity, state, start)`                                       |
| `lastUpdate(item)`                           | `getEntity(entity)?.last_updated`                                                 |
| `isBeforeSunrise()` / `isAfterSunset()`      | the same names, plus `isSunUp()`                                                  |
| `getRandomInt(max, min)` (local utils)       | `randomInt(min, max)`                                                             |
| `setTimeout(fn, ms)`                         | `setTimeout` still works (and is cleaned up); or `after("5m", fn)`                |
| `console.log(...)`                           | `log.info(...)`: tagged with the rule ID                                          |
| cache / item-based flags                     | `store` (per rule) and `shared` (all rules)                                       |

## Side by side

A rule that mirrors a switch onto a lamp. openHAB:

```js
addRule(
  "Apple Lampe zusammen mit Monitoren schalten",
  function () {
    if (isOn("KG_AZ_Computer_Links_Peripherie")) forceOn("Light_KG_Apple");
    else forceOff("Light_KG_Apple");
  },
  [changeStateTrigger("KG_AZ_Computer_Links_Peripherie")],
);
```

home-engine:

```ts
import { forceOff, forceOn, isOn, onChange, rule } from "@home-engine/sdk";

rule("Apple Lampe zusammen mit Monitoren schalten", onChange("switch.az_peripherie"), async () => {
  if (isOn("switch.az_peripherie")) {
    await forceOn("light.kg_apple");
  } else {
    await forceOff("light.kg_apple");
  }
});
```

A dimmed evening light at a fixed time, `sendCommand` with a brightness:

```js
addRule(
  "Gedimmte Beleuchtung OG Flur um 19.30 Uhr",
  function () {
    sendCommand("Light_OG_Flur", 10);
    forceOn("Upstairs_Floor_Nightmode");
  },
  [timeTrigger("0 30 19 ? * *")],
);
```

```ts
import { daily, forceOn, rule } from "@home-engine/sdk";

rule("Gedimmte Beleuchtung OG Flur um 19.30 Uhr", daily("19:30"), async () => {
  await forceOn("light.og_flur", { brightness_pct: 10 });
  await forceOn("input_boolean.upstairs_floor_nightmode");
});
```

Rollershutters down at a random time while nobody is home, with a nested `setTimeout`:

```js
addRule(
  "rollershutter-down-nighttime-if-absent",
  function () {
    if (isClosed("Presence_Any")) {
      var wait = getRandomInt(30, 1) * 60 * 1000;
      setTimeout(function () {
        if (isClosed("Presence_Any")) sendCommand("RollershutterScene", 2);
      }, wait);
    }
  },
  [timeTrigger("0 0 22 ? * *")],
);
```

```ts
import { call, daily, isOff, randomInt, rule, sleep } from "@home-engine/sdk";

rule("rollershutter-down-nighttime-if-absent", daily("22:00"), async () => {
  if (!isOff("binary_sensor.presence_any")) {
    return;
  }
  await sleep(randomInt(1, 30) * 60_000);
  if (isOff("binary_sensor.presence_any")) {
    await call("scene.turn_on", {}, { entity_id: "scene.rollershutter_night" });
  }
});
```

`sleep` belongs to the run: if the file is reloaded meanwhile, the wait ends and nothing is
sent. The plain `setTimeout` version also works and is cleared on reload.

A 10-minute average, which openHAB answers synchronously:

```js
const avg = averageSince(item, now().minusMinutes(10));
```

```ts
import { averageSince, every, log, rule } from "@home-engine/sdk";

rule("power average", every("10m"), async () => {
  const avg = await averageSince("sensor.house_power", "10m");
  if (avg !== undefined) {
    log.info(`Average power: ${avg.toFixed(0)} W`);
  }
});
```

## Things that work differently

- **"Update" triggers.** openHAB fires `updateStateTrigger` on every update, even with the same
  value. Home Assistant only reports a state when it or an attribute changes, so
  `onChange(entity, { attribute: "*" })` is the closest match.
- **Groups.** An openHAB group item that aggregates its members (`gLightsOutdoor` is ON if any
  light is on) corresponds to a Home Assistant light group or `group.*` entity. Triggers can
  also watch many entities directly: `onChange(["light.garden", "light.porch"])` or
  `onChange("light.outdoor_*")`.
- **`for`.** Instead of a timer you cancel when the state changes back, use
  `onChange(entity, { to: "off", for: "10m" })`. The engine handles the cancel, and holds
  survive reloads and restarts.
- **Item metadata and transformations** have no equivalent; keep such data in your rule files
  or in `store`.
