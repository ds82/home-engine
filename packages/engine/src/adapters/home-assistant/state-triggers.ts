// The `onChange` trigger source (rule-triggers: State change trigger, State value filters,
// Ignoring unavailable states, Attribute change semantics). One dispatcher per client routes
// state cache changes to armed triggers: an exact-ID map first, then glob patterns compiled
// once. Each armed trigger decides whether a change counts and whether its filters match.

import type { StateTrigger, ValueFilter } from "@home-engine/sdk";
import type { Disposable } from "../../core/adapter.js";
import type { ArmContext, EventPayload, TriggerSource } from "../../core/trigger-source.js";
import { deepEqual, type StateCache, type StateChange } from "./state-cache.js";
import type { HaState } from "./types.js";

/** Who caused a change; task-specific logic (engine user, causing rule) plugs in here. */
export interface ChangeCause {
  causedBy: "engine" | "external";
  causedByRule?: string;
}

export type CauseResolver = (change: StateChange) => ChangeCause;

const externalCause: CauseResolver = () => ({ causedBy: "external" });

const UNAVAILABLE = new Set(["unavailable", "unknown"]);

type Listener = (change: StateChange) => void;

/** Routes state changes to listeners by exact entity ID or glob pattern. */
export class StateDispatcher {
  private readonly exact = new Map<string, Set<Listener>>();
  private readonly globs = new Map<string, { regex: RegExp; listeners: Set<Listener> }>();
  private readonly subscription: Disposable;

  constructor(cache: StateCache) {
    this.subscription = cache.onChange((change) => this.dispatch(change));
  }

  /** Calls `listener` for changes of entities matching any of `selectors`. */
  watch(selectors: readonly string[], listener: Listener): Disposable {
    const removers: Array<() => void> = [];
    for (const selector of new Set(selectors)) {
      if (selector.includes("*")) {
        let entry = this.globs.get(selector);
        if (!entry) {
          entry = { regex: globToRegex(selector), listeners: new Set() };
          this.globs.set(selector, entry);
        }
        const e = entry;
        e.listeners.add(listener);
        removers.push(() => {
          e.listeners.delete(listener);
          if (e.listeners.size === 0) this.globs.delete(selector);
        });
      } else {
        let set = this.exact.get(selector);
        if (!set) this.exact.set(selector, (set = new Set()));
        const s = set;
        s.add(listener);
        removers.push(() => {
          s.delete(listener);
          if (s.size === 0) this.exact.delete(selector);
        });
      }
    }
    return { dispose: () => removers.forEach((r) => r()) };
  }

  dispose(): void {
    this.subscription.dispose();
    this.exact.clear();
    this.globs.clear();
  }

  private dispatch(change: StateChange): void {
    // A listener watching an entity through several selectors still runs once.
    const listeners = new Set<Listener>(this.exact.get(change.entityId));
    for (const { regex, listeners: ls } of this.globs.values()) {
      if (regex.test(change.entityId)) for (const l of ls) listeners.add(l);
    }
    for (const listener of listeners) listener(change);
  }
}

export function globToRegex(glob: string): RegExp {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Creates the trigger source for `state` triggers. */
export function stateTriggerSource(
  dispatcher: StateDispatcher,
  cache: StateCache,
  causeOf: CauseResolver = externalCause,
): TriggerSource {
  return (trigger, context) => {
    if (trigger.kind !== "state") throw new Error(`state source cannot arm ${trigger.kind}`);
    const matcher = new StateMatcher(trigger, cache);
    return dispatcher.watch(trigger.entities, (change) => {
      const payload = matcher.match(change);
      if (payload) fire(context, payload, change, causeOf);
    });
  };
}

function fire(
  context: ArmContext,
  payload: StatePayloadParts,
  change: StateChange,
  causeOf: CauseResolver,
): void {
  const cause = change.resynced ? { causedBy: "external" as const } : causeOf(change);
  const event: EventPayload = {
    type: "state",
    entityId: change.entityId,
    from: payload.from,
    to: change.newState,
    ...(payload.attribute !== undefined
      ? { attribute: payload.attribute, oldValue: payload.oldValue, newValue: payload.newValue }
      : {}),
    causedBy: cause.causedBy,
    causedByEngine: cause.causedBy === "engine",
    ...(cause.causedBy === "engine" && cause.causedByRule
      ? { causedByRule: cause.causedByRule }
      : {}),
    resynced: change.resynced,
    restored: false,
  };
  context.fire(event);
}

interface StatePayloadParts {
  from: HaState | undefined;
  attribute?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Decides for one armed trigger whether a change fires, and with which "from" state. */
export class StateMatcher {
  /** For ignoreUnavailable: the last state with a real value, per entity. */
  private readonly lastReal = new Map<string, HaState>();

  constructor(
    private readonly trigger: StateTrigger,
    cache: StateCache,
  ) {
    if (trigger.ignoreUnavailable) {
      for (const state of cache.all()) {
        if (!UNAVAILABLE.has(state.state)) this.lastReal.set(state.entity_id, state);
      }
    }
  }

  match(change: StateChange): StatePayloadParts | undefined {
    const { trigger } = this;
    if (trigger.attribute !== undefined && trigger.attribute !== "*") {
      return this.matchAttribute(change, trigger.attribute);
    }

    let from = change.oldState;
    const to = change.newState;

    if (trigger.ignoreUnavailable) {
      const entity = change.entityId;
      if (to && UNAVAILABLE.has(to.state)) {
        if (from && !UNAVAILABLE.has(from.state)) this.lastReal.set(entity, from);
        return undefined;
      }
      if (from && UNAVAILABLE.has(from.state)) from = this.lastReal.get(entity) ?? from;
      if (to) this.lastReal.set(entity, to);
      else this.lastReal.delete(entity);
    }

    const changed =
      trigger.attribute === "*"
        ? from?.state !== to?.state || !deepEqual(from?.attributes, to?.attributes)
        : from?.state !== to?.state;
    if (!changed) return undefined;
    if (!matchesFilter(trigger.from, from?.state)) return undefined;
    if (!matchesFilter(trigger.to, to?.state)) return undefined;
    return { from };
  }

  private matchAttribute(change: StateChange, attribute: string): StatePayloadParts | undefined {
    const oldValue = change.oldState?.attributes[attribute];
    const newValue = change.newState?.attributes[attribute];
    if (deepEqual(oldValue, newValue)) return undefined;
    if (!matchesFilter(this.trigger.from, oldValue)) return undefined;
    if (!matchesFilter(this.trigger.to, newValue)) return undefined;
    return { from: change.oldState, attribute, oldValue, newValue };
  }
}

/**
 * A missing filter always matches. Undefined values (entity created/removed, attribute
 * missing) never match a filter, and predicates are not called with them.
 */
export function matchesFilter(filter: ValueFilter | undefined, value: unknown): boolean {
  if (filter === undefined) return true;
  if (value === undefined) return false;
  if (typeof filter === "function") return (filter as (v: unknown) => boolean)(value);
  const allowed = Array.isArray(filter) ? (filter as unknown[]) : [filter];
  return allowed.some((f) => f === value || String(f) === String(value));
}
