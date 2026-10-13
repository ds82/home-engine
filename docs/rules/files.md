# Rule files

A rule file is a TypeScript or JavaScript file in the rules directory (`RULES_DIR`, `/rules`
in the container). The engine loads every rule file at startup, runs it once, and starts the
rules it registered. When you save a file, the engine reloads it without restarting.

You write TypeScript as it is: the engine compiles it on load, so there is no build step.
It does not type-check your rules; run `tsc` in your editor or CI for that.

## Which files are rule files

Every `.ts`, `.mts`, `.js` and `.mjs` file in the rules directory and its subdirectories is a
rule file, except:

- anything in `node_modules`,
- files and directories whose name starts with `_` or `.`,
- type declarations (`*.d.ts`) and tests (`*.test.*`, `*.spec.*`).

So `lights/hallway.ts` and `climate.js` are rule files, `_lib/helpers.ts` is not. Do not keep
two files that differ only in their extension (`hallway.ts` and `hallway.js`): their rules
would get the same IDs, so the engine loads neither and logs an error.

## Registering rules

A rule file registers rules by calling `rule()` or `setup()` while it is loaded, at the top
level or in functions called from there. What a file exports does not matter to the engine.

### Triggered rules: `rule(name, triggers, body, options?)`

The body runs whenever one of the triggers fires. `triggers` is one trigger or a list.

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("hallway light follows motion", onChange("binary_sensor.hall_motion"), (event) => {
  console.log(`${event.entityId} is now ${event.to?.state}`);
});
```

With several triggers, the body receives the event of the one that fired. Check `event.type`
to find out which kind it was; TypeScript then knows the event's fields:

```ts
import { cron, onChange, onStartup, rule } from "@home-engine/sdk";

rule(
  "bathroom shutter",
  [onStartup(), cron("0 22 * * *"), onChange("binary_sensor.bath_window_open", { for: "30s" })],
  async (event) => {
    if (event.type === "state") {
      console.log(`window ${event.to?.state}`);
    } else if (event.type === "time") {
      console.log(`scheduled for ${event.scheduledAt.toISOString()}`);
    }
  },
  { mode: "restart", description: "Close the shutter at night unless the window is open" },
);
```

The options are:

| Option        | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mode`        | What happens when a trigger fires while the body still runs: `parallel` (default), `single`, `queued` or `restart`. |
| `max`         | For `queued` and `parallel`: how many runs may be in progress or waiting (queued: 10).                              |
| `enabled`     | `false` registers the rule without starting it.                                                                     |
| `id`          | An explicit rule ID (see below).                                                                                    |
| `description` | Shown in the rule status output.                                                                                    |

Every event carries an `AbortSignal` (`event.signal`). It aborts when a `restart` rule fires
again or the rule is unloaded; pass it to anything long-running.

### Setup rules: `setup(name, fn, options?)`

A setup rule runs `fn` once each time it starts. Inside, register listeners with `listen()`
and keep state in local variables. Listeners always run in parallel, so setup rules take no
`mode`. Return a function to clean up when the rule is unloaded.

```ts
import { daily, listen, onChange, setup } from "@home-engine/sdk";

setup("doorbell burst counter", () => {
  let presses = 0;

  listen(onChange("binary_sensor.doorbell", { to: "on" }), () => {
    presses++;
    if (presses === 3) {
      console.log("Someone really wants in");
    }
  });
  listen(daily("00:00"), () => {
    presses = 0;
  });

  return () => console.log(`unloaded after ${presses} presses`);
});
```

`listen()` returns a handle; `handle.cancel()` removes that one listener early. It only works
in setup rules (and in code they run, such as listener callbacks).

## Rule IDs

Each rule has an ID: the file path relative to the rules directory, without extension, then
`#` and the rule name. `rule("motion", …)` in `lights/hallway.ts` has the ID
`lights/hallway#motion`. Logs, the status output, stored values and `DISABLED_RULES` use it.

Rule names must be unique within a file, across `rule()` and `setup()`. Moving or renaming a
file changes its IDs, which would orphan the rules' stored values. Give a rule an explicit,
globally unique `id` (without `#`) to keep it stable:

```ts
import { onChange, rule } from "@home-engine/sdk";

rule("motion", onChange("binary_sensor.kitchen_motion", { to: "on" }), () => {}, {
  id: "kitchen-motion",
});
```

Two files using the same explicit `id` are an error: the file loaded second fails as a whole,
and the log names both files. While the engine runs, moving a file with explicit IDs keeps
its rules and their stored values, because the old path is unloaded before the new one loads.
That relies on the deletion and the addition reaching the engine within the 200 ms hot reload
batch, which is the case for `mv`, editors and file managers. If the new path arrives on its
own first (for example a slow copy followed by a delete), it collides with the old path and
fails. Save the moved file once more and it loads.

To switch rules off without editing them, list ID patterns in `DISABLED_RULES`, for example
`lights/*, climate#heating`. `*` matches any characters, including `/` and `#`.

## Rules from loops and factories

`rule()` is a normal function call, so you can create rules in loops or in your own
functions, with names computed at runtime:

```ts
import { onChange, rule } from "@home-engine/sdk";

function notifyOnArrival(person: string, entity: string): void {
  rule(`presence-${person}`, onChange(entity, { to: "home" }), () => {
    console.log(`${person} is home`);
  });
}

for (const [person, entity] of [
  ["dennis", "person.dennis"],
  ["lydia", "person.lydia"],
] as const) {
  notifyOnArrival(person, entity);
}
```

Registration must happen while the file is loaded. Calling `rule()` later, for example inside
a trigger callback, throws an error.

## Helper modules

Shared code goes into files or directories starting with `_`, such as `_lib/helpers.ts`. They
are not rule files themselves, but rule files can import them with relative imports. When you
edit a helper, the engine reloads every rule file that imports it.

```ts nocheck
// _lib/rooms.ts
export const rooms = ["kitchen", "hall", "bath"] as const;

// lights.ts
import { rooms } from "./_lib/rooms";
```

## Timers

Plain `setTimeout` and `setInterval` work as usual in rule files and helper modules, but the
engine tracks them per rule. When a file is reloaded, timers started by its previous version
are cancelled, so they never fire twice. Clearing a timer stored in a module-level variable
works as in plain JavaScript:

```ts
import { onChange, rule } from "@home-engine/sdk";

let timer: ReturnType<typeof setTimeout> | undefined;

rule("lawn watering off after 20 min", onChange("switch.lawn_watering", { to: "on" }), () => {
  timer = setTimeout(() => console.log("time is up"), 20 * 60 * 1000);
});

rule("lawn watering stopped by hand", onChange("switch.lawn_watering", { to: "off" }), () => {
  clearTimeout(timer);
});
```

Timers started inside npm packages are not tracked.

## Configuration and secrets

Rules can read the engine's environment variables, so you can pass settings and secrets
through the container environment:

```ts
const pushoverKey = process.env.PUSHOVER_KEY;
if (!pushoverKey) {
  throw new Error("PUSHOVER_KEY is not set");
}
```

A rule file that throws while loading is reported as failed; its rules do not start, and the
other files load normally.

## npm packages

To use npm packages, add a `package.json` (and ideally a `package-lock.json`) to the rules
directory. At startup the engine installs the dependencies into the data directory, with
`npm ci` when there is a lockfile and `npm install` otherwise. It skips the installation when
neither file changed. The rules directory itself is never written to, so it can be mounted
read-only. After changing `package.json`, restart the engine. Set `NPM_INSTALL=false` to skip
installing entirely.

If the installation fails, the engine logs npm's output and still loads your rules; files
that import a missing package fail on their own with an error.
