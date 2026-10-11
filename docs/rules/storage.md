# Storage

Rules can keep small amounts of data that survive reloads, engine restarts and container
re-creation: counters, the last time something happened, a flag set by one rule and read by
another.

| Object   | Visible to                  | Typical use                                    |
| -------- | --------------------------- | ---------------------------------------------- |
| `store`  | only the rule that wrote it | a rule's own memory: counters, last run, …     |
| `shared` | every rule                  | deliberate coordination: vacation mode, a mute |

Both have the same four methods:

| Method            | Does                                       |
| ----------------- | ------------------------------------------ |
| `get(key)`        | returns the value (a copy), or `undefined` |
| `set(key, value)` | stores a value                             |
| `delete(key)`     | removes a key; returns whether it existed  |
| `keys()`          | lists the keys                             |

Reads and writes are synchronous: the values live in memory and are written to disk in the
background.

## A rule's own store

```ts
import { onChange, rule, store } from "@home-engine/sdk";

rule("doorbell counter", onChange("binary_sensor.doorbell", { to: "on" }), () => {
  const rings = (store.get<number>("rings") ?? 0) + 1;
  store.set("rings", rings);
  store.set("lastRing", new Date().toISOString());
  console.log(`Ring number ${rings}`);
});
```

Each rule's keys are separate: another rule reading `rings` gets `undefined`, even with the same
key. `store` must be used from rule code (a body, setup function or listener), because that is
how it knows which rule is asking; at the top level of a file it throws.

`get<T>` only tells TypeScript what you expect, it does not check the stored value.

## The shared store

```ts
import { daily, onChange, rule, shared } from "@home-engine/sdk";

rule("vacation switch", onChange("input_boolean.vacation"), (event) => {
  shared.set("vacation", event.to?.state === "on");
});

rule("morning blinds", daily("07:00"), () => {
  if (shared.get<boolean>("vacation")) return;
  // open the blinds
});
```

Any rule can read and overwrite any shared key, so pick distinctive key names. For state that
Home Assistant should see too, an `input_boolean` or `input_text` helper is often the better
choice.

## What you can store

Values must be plain JSON data: strings, finite numbers, booleans, `null`, arrays and plain
objects of those. `set` throws, and keeps the previous value, for anything else, naming the
part that does not fit:

- functions, class instances, `Map` and `Set`,
- `Date`: store `date.toISOString()` and parse it with `new Date(text)`,
- `NaN`, `Infinity` and `undefined` (use `delete` to remove a key),
- objects that contain themselves.

Values are copied when stored and when read, so changing an object after `set`, or changing what
`get` returned, does not change the store; call `set` again.

Storage is meant for small data (up to a few hundred kilobytes per rule). It is not a database.

## Where the data lives

Each rule's values are a JSON file in `<DATA_DIR>/storage` (normally `/data/storage`), named after
the encoded rule ID; the shared store is `_shared.json`. Keep `/data` on a volume and the values
survive container updates. The files are readable for humans.

Changes are written within half a second and on shutdown. Writes are atomic: a crash or power
loss leaves either the old or the new file, never a broken one. If a file is damaged anyway (for
example edited by hand), the engine logs an error, renames it with a timestamp suffix
(`…json.corrupt-2026-10-11T08-00-00-000Z`) and starts that store empty, so nothing is lost
for inspection.

Data of rules that no longer exist is not deleted: renaming or removing a rule for a while keeps
its values. A rule's ID is its path and name (`lights/hall.ts#motion`) unless you give it an
`id`, so moving or renaming a rule makes it start with an empty store; set `id` to keep it:

```ts
import { onStartup, rule, store } from "@home-engine/sdk";

rule(
  "motion",
  onStartup(),
  () => {
    console.log("runs so far:", store.get("runs"));
  },
  { id: "hall-motion" },
);
```

Delete a rule's file in `<DATA_DIR>/storage` by hand when you no longer need its data.
