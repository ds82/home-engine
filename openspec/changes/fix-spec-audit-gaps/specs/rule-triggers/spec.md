# Spec Delta

## MODIFIED Requirements

### Requirement: Listeners in setup rules
The SDK SHALL provide a free function `listen(trigger | triggers, callback, options?)` that registers a listener for the calling setup rule. The optional `id` option gives the listener a stable identity for hold restoration, which is needed when setup registers listeners conditionally. It SHALL be unique within the rule; a duplicate SHALL make `listen()` throw. It SHALL be callable from the setup function and from code running on behalf of the same setup rule (listener callbacks, timers). Called anywhere else (file top level, a triggered rule's body), it SHALL throw an error stating that `listen()` is only available in setup rules. It SHALL return a handle that can cancel that single listener before the rule is unloaded. All listeners are released when the rule is unloaded.

#### Scenario: Listen in a triggered rule
- **WHEN** a triggered rule's body calls `listen(onChange("light.hall"), cb)`
- **THEN** the call throws an error stating that `listen()` is only available in setup rules, and the error is logged for that run

#### Scenario: Conditional listener with stable ID
- **WHEN** a setup function registers `listen(onChange("light.a", { to: "on", for: "10m" }), cb, { id: "a-on" })` only when some condition holds, and the file is reloaded while that hold is pending
- **THEN** the hold is restored under the ID `a-on`, regardless of how many listeners were registered before it

#### Scenario: Cancel a single listener
- **WHEN** a setup rule cancels one listener handle
- **THEN** that callback is no longer invoked while the rule's other listeners stay active

#### Scenario: Duplicate listener ID
- **WHEN** a setup function calls `listen(…, { id: "a-on" })` twice
- **THEN** the second call throws an error naming the duplicate ID, and the first listener stays registered
