// The events a rule body or listener receives. `type` discriminates the union, so checking
// it narrows the event to the fields of that trigger kind.

import type { HassContext, HassEntity } from "./entities.js";
import type {
  EventTrigger,
  HaTrigger,
  StartupTrigger,
  StateTrigger,
  SunEventName,
  SunTrigger,
  TimeTrigger,
  Trigger,
  Triggers,
} from "./triggers.js";

interface BaseEvent<T extends Trigger> {
  /** The trigger that fired. */
  readonly trigger: T;
  /** Aborted when the run is cancelled (restart mode) or the rule is unloaded. */
  readonly signal: AbortSignal;
}

/**
 * Who caused a state change: a direct write by this engine, or anything else.
 * @category Triggers
 */
export type ChangeCause = "engine" | "external";

/**
 * A state change of an entity, from a {@link StateTrigger} (`onChange`).
 * @category Triggers
 */
export interface StateEvent extends BaseEvent<StateTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "state";
  /** The entity that changed. */
  readonly entityId: string;
  /** Previous state object; undefined when the entity was created. */
  readonly from: HassEntity | undefined;
  /** New state object; undefined when the entity was removed. */
  readonly to: HassEntity | undefined;
  /** For attribute triggers: the watched attribute and its old and new values. */
  readonly attribute?: string;
  /** For attribute triggers: the watched attribute's previous value. */
  readonly oldValue?: unknown;
  /** For attribute triggers: the watched attribute's new value. */
  readonly newValue?: unknown;
  /** `"engine"` if a rule of this engine wrote exactly this change, else `"external"`. */
  readonly causedBy: ChangeCause;
  /** Shorthand for `causedBy === "engine"`. */
  readonly causedByEngine: boolean;
  /** The rule whose write caused the change, when known. Only set for engine-caused changes. */
  readonly causedByRule?: string;
  /** Synthesised after a reconnect for a change missed while disconnected. */
  readonly resynced: boolean;
  /** Fired by a hold restored when the rule started. */
  readonly restored: boolean;
}

/**
 * A Home Assistant bus event, from an {@link EventTrigger} (`onEvent`).
 * @category Triggers
 */
export interface BusEvent extends BaseEvent<EventTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "event";
  /** The bus event type, e.g. `zha_event`. */
  readonly eventType: string;
  /** The event's data. */
  readonly data: Record<string, unknown>;
  /** Where Home Assistant says the event came from: `LOCAL` or `REMOTE`. */
  readonly origin: string;
  /** When Home Assistant fired the event. */
  readonly timeFired: Date;
  /** Home Assistant's context of the event. */
  readonly context: HassContext;
}

/**
 * A firing of a native Home Assistant trigger, from an {@link HaTrigger} (`onTrigger`).
 * @category Triggers
 */
export interface HaTriggerEvent extends BaseEvent<HaTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "ha-trigger";
  /** The trigger variables Home Assistant provides (`trigger.*` in YAML templates). */
  readonly variables: Record<string, unknown>;
}

/**
 * The start of a rule, from a {@link StartupTrigger} (`onStartup`).
 * @category Triggers
 */
export interface StartupEvent extends BaseEvent<StartupTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "startup";
}

/**
 * A scheduled time, from a {@link TimeTrigger} (`cron`, `daily` or `every`).
 * @category Scheduling
 */
export interface TimeEvent extends BaseEvent<TimeTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "time";
  /** When the trigger was scheduled to fire. */
  readonly scheduledAt: Date;
}

/**
 * A sun event, from a {@link SunTrigger} (`sun`).
 * @category Scheduling
 */
export interface SunEvent extends BaseEvent<SunTrigger> {
  /** Discriminates the {@link RuleEvent} union. */
  readonly type: "sun";
  /** Which sun event fired. */
  readonly event: SunEventName;
  /** When the trigger was scheduled to fire, including its offset. */
  readonly scheduledAt: Date;
}

/**
 * Any event a run can receive. Check `type` to narrow it to the fields of one trigger kind; a
 * rule only receives the event types its triggers can produce.
 * @category Triggers
 */
export type RuleEvent =
  StateEvent | BusEvent | HaTriggerEvent | StartupEvent | TimeEvent | SunEvent;

/**
 * The event a single trigger produces.
 * @category Triggers
 */
export type EventOf<T extends Trigger> = T extends StateTrigger
  ? StateEvent
  : T extends EventTrigger
    ? BusEvent
    : T extends HaTrigger
      ? HaTriggerEvent
      : T extends StartupTrigger
        ? StartupEvent
        : T extends TimeTrigger
          ? TimeEvent
          : T extends SunTrigger
            ? SunEvent
            : never;

/**
 * The union of events a trigger list can produce.
 * @category Triggers
 */
export type EventFor<T extends Triggers> = T extends readonly Trigger[]
  ? EventOf<T[number]>
  : T extends Trigger
    ? EventOf<T>
    : never;
