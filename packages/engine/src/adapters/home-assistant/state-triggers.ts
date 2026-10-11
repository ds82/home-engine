// The `onChange` trigger source (rule-triggers: State change trigger, State value filters,
// Ignoring unavailable states, Attribute change semantics, Hold-for-duration, Hold
// restoration, Immediate evaluation, Holds during a disconnect). One dispatcher per client routes
// state cache changes to armed triggers: an exact-ID map first, then glob patterns compiled
// once. Each armed trigger decides whether a change counts and whether its filters match.

import type { StateTrigger, ValueFilter } from "@home-engine/sdk";
import type { Disposable } from "../../core/adapter.js";
import { parseDuration } from "../../core/duration.js";
import type { FiredHolds } from "../../core/fired-holds.js";
import type { ArmContext, EventPayload, TriggerSource } from "../../core/trigger-source.js";
import type { WriteAttribution } from "./attribution.js";
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

  /** Changes waiting behind a held one, per entity, so order per entity is kept. */
  private readonly queues = new Map<string, StateChange[]>();

  constructor(
    cache: StateCache,
    private readonly attribution?: WriteAttribution,
  ) {
    this.subscription = cache.onChange((change) => this.receive(change));
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

  /** Resolves the change's cause (possibly held briefly), then dispatches in order. */
  private receive(change: StateChange): void {
    const queue = this.queues.get(change.entityId);
    if (queue) {
      queue.push(change);
      return;
    }
    const cause =
      change.resynced || !this.attribution
        ? ({ causedBy: "external" } as const)
        : this.attribution.resolve(change.context);
    if (!(cause instanceof Promise)) {
      this.dispatch({ ...change, cause });
      return;
    }
    const waiting: StateChange[] = [];
    this.queues.set(change.entityId, waiting);
    void cause.then((resolved) => {
      this.queues.delete(change.entityId);
      this.dispatch({ ...change, cause: resolved });
      for (const next of waiting) this.receive(next);
    });
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

/** Time for holds; injectable so tests can advance it deterministically. */
export interface HoldClock {
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

/** setTimeout cannot wait longer than ~24.8 days; longer holds re-arm in steps. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export const realClock: HoldClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const target = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      const remaining = target - Date.now();
      timer =
        remaining > MAX_TIMEOUT_MS
          ? setTimeout(arm, MAX_TIMEOUT_MS)
          : setTimeout(fn, Math.max(0, remaining));
    };
    arm();
    return () => clearTimeout(timer);
  },
};

/** Whether the client is connected and synchronised; holds wait for it before firing. */
export interface ConnectionState {
  isReady(): boolean;
  onReady(listener: () => void): () => void;
}

export interface StateSourceOptions {
  dispatcher: StateDispatcher;
  cache: StateCache;
  causeOf?: CauseResolver;
  clock?: HoldClock;
  firedHolds?: FiredHolds;
  connection?: ConnectionState;
}

/** Creates the trigger source for `state` triggers. */
export function stateTriggerSource(options: StateSourceOptions): TriggerSource {
  return (trigger, context) => {
    if (trigger.kind !== "state") throw new Error(`state source cannot arm ${trigger.kind}`);
    return new ArmedStateTrigger(trigger, context, options).arm();
  };
}

interface StatePayloadParts {
  from: HaState | undefined;
  attribute?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** A change that started a hold, or the current state a restored hold counts from. */
interface Hold {
  /** Entity whose state the hold counts from (the deciding one for group holds). */
  entityId: string;
  /** State timestamp the hold counts from (`last_changed`, or `last_updated` for attributes). */
  stamp: string;
  to: HaState | undefined;
  parts: StatePayloadParts;
  cause: ChangeCause;
  resynced: boolean;
  restored: boolean;
  cancel: () => void;
  /** Ran out while disconnected; re-checked after the resync. */
  deferred: boolean;
}

/** One armed `onChange` trigger: filters, holds, restoration and immediate evaluation. */
class ArmedStateTrigger {
  private readonly matcher: StateMatcher;
  private readonly durationMs: number | undefined;
  private readonly holds = new Map<string, Hold>();
  private readonly clock: HoldClock;
  private readonly group: boolean;
  private disposed = false;

  constructor(
    private readonly trigger: StateTrigger,
    private readonly context: ArmContext,
    private readonly options: StateSourceOptions,
  ) {
    this.matcher = new StateMatcher(trigger, options.cache);
    this.durationMs = trigger.for === undefined ? undefined : parseDuration(trigger.for);
    this.clock = options.clock ?? realClock;
    this.group = trigger.holdAs === "group";
  }

  arm(): Disposable {
    const watching = this.options.dispatcher.watch(this.trigger.entities, (change) =>
      this.onChange(change),
    );
    const offReady = this.options.connection?.onReady(() => this.recheckDeferred());
    if (
      this.context.restoreHolds &&
      this.durationMs !== undefined &&
      this.trigger.from === undefined
    ) {
      this.restore();
    }
    if (this.trigger.immediate) this.evaluateImmediately();
    return {
      dispose: () => {
        this.disposed = true;
        watching.dispose();
        offReady?.();
        for (const hold of this.holds.values()) hold.cancel();
        this.holds.clear();
      },
    };
  }

  private onChange(change: StateChange): void {
    const verdict = this.matcher.evaluate(change);
    if (verdict.kind === "ignore") return;
    const cause = change.resynced
      ? { causedBy: "external" as const }
      : (change.cause ?? (this.options.causeOf ?? externalCause)(change));

    if (this.durationMs === undefined) {
      if (verdict.kind === "match") {
        this.emit(change.entityId, change.newState, verdict.parts, cause, change.resynced, false);
      }
      return;
    }

    // Every counted change restarts the hold if it matches and cancels it otherwise.
    const key = this.group ? "*" : change.entityId;
    this.holds.get(key)?.cancel();
    this.holds.delete(key);
    this.options.firedHolds?.forget(this.context.scope.ruleId, this.context.identity, key);
    if (verdict.kind !== "match" || !change.newState) return;

    const stamp = this.stampOf(change.newState);
    // Resynced changes happened while disconnected: count from the state's own timestamp.
    const since = change.resynced ? Date.parse(stamp) : this.clock.now();
    this.startHold(key, {
      entityId: change.entityId,
      stamp,
      to: change.newState,
      parts: verdict.parts,
      cause,
      resynced: change.resynced,
      restored: false,
      since,
    });
  }

  private startHold(
    key: string,
    hold: Omit<Hold, "cancel" | "deferred"> & { since: number },
  ): void {
    const remaining = hold.since + (this.durationMs ?? 0) - this.clock.now();
    const entry: Hold = { ...hold, deferred: false, cancel: () => {} };
    entry.cancel = this.clock.setTimeout(() => this.expire(key, entry), Math.max(0, remaining));
    this.holds.set(key, entry);
  }

  private expire(key: string, hold: Hold): void {
    if (this.disposed || this.holds.get(key) !== hold) return;
    if (this.options.connection && !this.options.connection.isReady()) {
      hold.deferred = true;
      return;
    }
    this.complete(key, hold);
  }

  /** After a reconnect: fire deferred holds whose entity is unchanged and still matches. */
  private recheckDeferred(): void {
    for (const [key, hold] of [...this.holds]) {
      if (!hold.deferred) continue;
      const current = this.options.cache.get(hold.entityId);
      if (current && this.stampOf(current) === hold.stamp && this.matcher.matchesCurrent(current)) {
        this.complete(key, hold);
      } else {
        this.holds.delete(key);
      }
    }
  }

  private complete(key: string, hold: Hold): void {
    this.holds.delete(key);
    this.options.firedHolds?.record({
      ruleId: this.context.scope.ruleId,
      identity: this.context.identity,
      entityId: key,
      since: this.recordStamp(hold.entityId, hold.stamp),
    });
    this.emit(hold.entityId, hold.to, hold.parts, hold.cause, hold.resynced, hold.restored);
  }

  /** Restores pending holds from the cached states when the rule starts. */
  private restore(): void {
    const candidates = this.options.cache.all().filter((s) => this.watches(s.entity_id));
    const decide = this.group
      ? candidates.sort((a, b) => this.stampOf(b).localeCompare(this.stampOf(a))).slice(0, 1)
      : candidates;
    for (const state of decide) {
      if (!this.matcher.matchesCurrent(state)) continue;
      const key = this.group ? "*" : state.entity_id;
      const stamp = this.stampOf(state);
      const fired = this.options.firedHolds?.has({
        ruleId: this.context.scope.ruleId,
        identity: this.context.identity,
        entityId: key,
        since: this.recordStamp(state.entity_id, stamp),
      });
      if (fired) continue;
      this.startHold(key, {
        entityId: state.entity_id,
        stamp,
        to: state,
        parts: this.matcher.currentParts(state),
        cause: { causedBy: "external" },
        resynced: false,
        restored: true,
        since: Date.parse(stamp),
      });
    }
  }

  /** `immediate`: fire once for every watched entity whose current value matches. */
  private evaluateImmediately(): void {
    for (const state of this.options.cache.all()) {
      if (!this.watches(state.entity_id) || !this.matcher.matchesCurrent(state)) continue;
      this.emit(
        state.entity_id,
        state,
        this.matcher.currentParts(state),
        { causedBy: "external" },
        false,
        false,
      );
    }
  }

  private emit(
    entityId: string,
    to: HaState | undefined,
    parts: StatePayloadParts,
    cause: ChangeCause,
    resynced: boolean,
    restored: boolean,
  ): void {
    if (this.disposed) return;
    const event: EventPayload = {
      type: "state",
      entityId,
      from: parts.from,
      to,
      ...(parts.attribute !== undefined
        ? { attribute: parts.attribute, oldValue: parts.oldValue, newValue: parts.newValue }
        : {}),
      causedBy: cause.causedBy,
      causedByEngine: cause.causedBy === "engine",
      ...(cause.causedBy === "engine" && cause.causedByRule
        ? { causedByRule: cause.causedByRule }
        : {}),
      resynced,
      restored,
    };
    this.context.fire(event);
  }

  private watches(entityId: string): boolean {
    return this.trigger.entities.some((sel) =>
      sel.includes("*") ? globToRegex(sel).test(entityId) : sel === entityId,
    );
  }

  /** Attribute triggers count from `last_updated`, state triggers from `last_changed`. */
  private stampOf(state: HaState): string {
    return this.trigger.attribute !== undefined ? state.last_updated : state.last_changed;
  }

  /** Group holds remember which entity decided, so another entity's state never matches. */
  private recordStamp(entityId: string, stamp: string): string {
    return this.group ? `${entityId}@${stamp}` : stamp;
  }
}

type Verdict =
  { kind: "ignore" } | { kind: "nomatch" } | { kind: "match"; parts: StatePayloadParts };

/**
 * Per-trigger change semantics: whether a change counts at all (`ignore`), counts but does
 * not match the filters (`nomatch`, cancels a hold) or matches.
 */
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

  evaluate(change: StateChange): Verdict {
    const { trigger } = this;
    if (trigger.attribute !== undefined && trigger.attribute !== "*") {
      return this.evaluateAttribute(change, trigger.attribute);
    }

    let from = change.oldState;
    const to = change.newState;

    if (trigger.ignoreUnavailable) {
      const entity = change.entityId;
      if (to && UNAVAILABLE.has(to.state)) {
        if (from && !UNAVAILABLE.has(from.state)) this.lastReal.set(entity, from);
        return { kind: "ignore" };
      }
      if (from && UNAVAILABLE.has(from.state)) from = this.lastReal.get(entity) ?? from;
      if (to) this.lastReal.set(entity, to);
      else this.lastReal.delete(entity);
    }

    const changed =
      trigger.attribute === "*"
        ? from?.state !== to?.state || !deepEqual(from?.attributes, to?.attributes)
        : from?.state !== to?.state;
    if (!changed) return { kind: "ignore" };
    if (!matchesFilter(trigger.from, from?.state) || !matchesFilter(trigger.to, to?.state)) {
      return { kind: "nomatch" };
    }
    return { kind: "match", parts: { from } };
  }

  /** Whether an entity's current state matches the `to` filter (for restoration/immediate). */
  matchesCurrent(state: HaState): boolean {
    if (this.trigger.ignoreUnavailable && UNAVAILABLE.has(state.state)) return false;
    return matchesFilter(this.trigger.to, this.valueOf(state));
  }

  /** Event parts for a current state, as if a transition into it had just happened. */
  currentParts(state: HaState): StatePayloadParts {
    const attribute = this.trigger.attribute;
    if (attribute !== undefined && attribute !== "*") {
      return {
        from: undefined,
        attribute,
        oldValue: undefined,
        newValue: state.attributes[attribute],
      };
    }
    return { from: undefined };
  }

  private valueOf(state: HaState): unknown {
    const attribute = this.trigger.attribute;
    return attribute !== undefined && attribute !== "*" ? state.attributes[attribute] : state.state;
  }

  private evaluateAttribute(change: StateChange, attribute: string): Verdict {
    const oldValue = change.oldState?.attributes[attribute];
    const newValue = change.newState?.attributes[attribute];
    if (deepEqual(oldValue, newValue)) return { kind: "ignore" };
    if (!matchesFilter(this.trigger.from, oldValue) || !matchesFilter(this.trigger.to, newValue)) {
      return { kind: "nomatch" };
    }
    return { kind: "match", parts: { from: change.oldState, attribute, oldValue, newValue } };
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
