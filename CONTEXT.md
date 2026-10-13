# home-engine

A rule engine that runs user-written TypeScript/JavaScript rules against a smart-home backend (today: Home Assistant). This glossary fixes the words used in specs, code, logs and docs.

## Rules

**Rule**:
A named unit of automation registered from a rule file, with a rule ID, a status and its own storage. There are two kinds: triggered rules and setup rules.
_Avoid_: automation, script, app

**Triggered rule**:
A rule registered with `rule(name, triggers, body)`: one body that runs whenever any of its triggers fires, under one concurrency mode.
_Avoid_: trigger-style rule

**Setup rule**:
A rule registered with `setup(name, fn)`: a function that runs once when the rule starts and registers listeners imperatively, keeping local state in closures.
_Avoid_: setup-style rule, app

**Listener**:
A subscription registered with `listen()` inside a setup rule, made of a trigger and a callback. It is part of its rule, not a rule itself.
_Avoid_: handler, callback (for the subscription as a whole)

**Rule file**:
A `.ts`/`.js` file in the rules directory that registers zero or more rules when evaluated.

**Rule ID**:
The identity of a rule: `<file path>#<rule name>` by default, or an explicit ID declared by the rule. Storage, status and disabling are keyed by it.

**Run**:
One execution of a triggered rule's body or a listener's callback, caused by one firing.

**Rule status**:
Where a rule stands: `starting` (a setup rule whose async setup function has not finished yet; its listeners already fire), `running`, `disabled` (by configuration or `enabled: false`) or `failed` (its file or setup failed). Triggered rules are never `starting`.

**Concurrency mode**:
How a triggered rule handles a firing while a previous run is still in progress: `parallel`, `single`, `queued` or `restart`.

## Triggers

**Trigger**:
A description of what should start a run (a state change, an event, a time, startup). It does nothing until a rule is started with it.

**Firing**:
One occurrence of a trigger's condition, which leads to a run (or is dropped, depending on the concurrency mode).

**Hold**:
The `for` duration an entity must keep a matching value before its trigger fires; every new change restarts or cancels it. Holds are tracked per entity, or shared by all listed entities as a group hold.
_Avoid_: debounce, delay

**Restored hold**:
A hold rebuilt from an entity's last change time when its rule starts, so reloads and restarts don't lose it. Holds that already fired are not restored again; holds with a `from` filter are not restored at all.

**Missed run**:
A time-trigger firing whose planned time passed while the engine was stopped, or more than a minute before the engine could run it (for example while the host was suspended). Missed runs are skipped, never replayed.
_Avoid_: catch-up, late run

**Change cause**:
Who caused a state change: the engine, when a rule wrote exactly this change (optionally naming that rule), or something external (a device, a person, a backend automation, even one reacting to an engine write).

**Resync**:
Reconciling the engine's view of all entity states after a reconnect. Differences found are delivered to rules as resynced state changes.

## Backend

**Backend**:
The smart-home system the engine is connected to. Only Home Assistant exists today.
_Avoid_: platform, hub

**Entity**:
Something in the backend with an ID, a state and attributes, such as a light or a sensor. An openHAB Item corresponds to an Entity.
_Avoid_: item, device

**Service call**:
A command sent to the backend to make something happen, such as `light.turn_on`.
_Avoid_: action, command (for this meaning)

**Event**:
A message on the backend's event bus. State changes are one kind of event.

**Site**:
The location context the backend provides: time zone, coordinates and units. Sun times and daily schedules are computed from it.
_Avoid_: location, home

**Virtual entity**:
An entity whose state a rule writes directly into the backend without a real device behind it. Its value is not kept across engine restarts.
