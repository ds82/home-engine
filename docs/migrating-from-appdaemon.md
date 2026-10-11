# Coming from AppDaemon

An AppDaemon app is a Python class whose `initialize()` registers callbacks. The closest
home-engine shape is a setup rule: `setup(name, fn)` runs once when the rule starts, and
`listen()` registers callbacks inside it. For a single trigger, a plain `rule()` is shorter.

## Mapping

| AppDaemon                                              | home-engine                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `class App(hass.Hass)` + `initialize()`                | `setup("app", () => { … })`                                   |
| `listen_state(cb, entity)`                             | `listen(onChange(entity), cb)`                                |
| `listen_state(cb, entity, new="on", old="off")`        | `onChange(entity, { to: "on", from: "off" })`                 |
| `listen_state(cb, entity, attribute="brightness")`     | `onChange(entity, { attribute: "brightness" })`               |
| `listen_state(cb, entity, new="off", duration=300)`    | `onChange(entity, { to: "off", for: "5m" })`                  |
| `listen_event(cb, "my_event", key="x")`                | `onEvent("my_event", { key: "x" })`                           |
| `run_daily(cb, time(7, 0))`                            | `daily("07:00")`                                              |
| `run_every(cb, "now", 300)`                            | `every("5m", { immediate: true })`                            |
| `run_at_sunset(cb, offset=-1800)`                      | `sun("sunset", { offset: "-30m" })`                           |
| `run_at_sunrise(cb)`                                   | `sun("sunrise")`                                              |
| `run_in(cb, 60)`                                       | `after("60s", cb)`                                            |
| `cancel_timer(handle)` / `cancel_listen_state(handle)` | `handle.cancel()`                                             |
| `get_state(entity)`                                    | `getState(entity)`                                            |
| `get_state(entity, attribute="x")`                     | `getEntity(entity)?.attributes.x`                             |
| `get_state(entity, attribute="all")`                   | `getEntity(entity)`                                           |
| `turn_on(entity, brightness=128)`                      | `forceOn(entity, { brightness: 128 })` (or `on`: only if off) |
| `turn_off(entity)` / `toggle(entity)`                  | `forceOff(entity)` / `toggle(entity)`                         |
| `call_service("light/turn_on", entity_id=e, …)`        | `call("light.turn_on", { … }, { entity_id: e })`              |
| `set_state(entity, state=…, attributes=…)`             | `setState(entity, state, attributes)`                         |
| `fire_event("my_event", key="x")`                      | `fire("my_event", { key: "x" })`                              |
| `get_history(entity_id=e, days=1)`                     | `await history(e, "1d")`                                      |
| `self.log("…")` / `self.error("…")`                    | `log.info("…")` / `log.error("…")`                            |
| `self.args["light"]` (apps.yaml)                       | a constant in the rule file, or `process.env.X`               |
| `global_vars`                                          | `shared`                                                      |
| persistent namespaces / files                          | `store`                                                       |
| `constrain_start_time`, `constrain_input_boolean`, …   | an `if` at the start of the body                              |
| `self.sun_up()` / `self.sun_down()`                    | `isSunUp()` / `!isSunUp()`                                    |

## Side by side

A motion light with a timeout, as an AppDaemon app:

```python
import appdaemon.plugins.hass.hassapi as hass

class MotionLight(hass.Hass):
    def initialize(self):
        self.listen_state(self.motion, "binary_sensor.hall_motion", new="on")
        self.listen_state(self.no_motion, "binary_sensor.hall_motion", new="off", duration=300)

    def motion(self, entity, attribute, old, new, kwargs):
        self.turn_on("light.hall")

    def no_motion(self, entity, attribute, old, new, kwargs):
        self.turn_off("light.hall")
```

home-engine:

```ts
import { listen, off, on, onChange, setup } from "@home-engine/sdk";

setup("motion light", () => {
  listen(onChange("binary_sensor.hall_motion", { to: "on" }), () => on("light.hall"));
  listen(onChange("binary_sensor.hall_motion", { to: "off", for: "5m" }), () => off("light.hall"));
});
```

A daily timer that cancels itself once someone is home, with `run_daily`, `run_in` and
`cancel_timer`:

```python
class Reminder(hass.Hass):
    def initialize(self):
        self.handle = None
        self.run_daily(self.start, time(18, 0))
        self.listen_state(self.home, "person.dennis", new="home")

    def start(self, kwargs):
        self.handle = self.run_in(self.remind, 1800)

    def remind(self, kwargs):
        self.call_service("notify/mobile_app_phone", message="Still not home?")

    def home(self, entity, attribute, old, new, kwargs):
        if self.handle:
            self.cancel_timer(self.handle)
```

```ts
import { after, call, daily, listen, onChange, setup, type TimerHandle } from "@home-engine/sdk";

setup("reminder", () => {
  let reminder: TimerHandle | undefined;

  listen(daily("18:00"), () => {
    reminder = after("30m", () => call("notify.mobile_app_phone", { message: "Still not home?" }));
  });

  listen(onChange("person.dennis", { to: "home" }), () => reminder?.cancel());
});
```

## Things that work differently

- **Callbacks receive one event object** instead of `(entity, attribute, old, new, kwargs)`:
  `event.entityId`, `event.from`, `event.to` (full state objects), `event.cause`.
- **`turn_on` versus `on`.** AppDaemon's `turn_on` always sends the service call; that is
  `forceOn`. `on` skips the call when the entity is already on.
- **No threads.** Rules run on one event loop. Waiting is `await sleep("5m")`, never a blocking
  call; a CPU-heavy loop in a rule blocks every other rule.
- **Reloads clean up.** Timers, listeners and holds of a rule are released when its file is
  saved; holds in progress are restored afterwards.
- **No `apps.yaml`.** Configuration lives in the rule files. Values that differ between
  installations or are secret come from environment variables of the container.
