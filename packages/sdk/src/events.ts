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

/** Who caused a state change: a direct write by this engine, or anything else. */
export type ChangeCause = "engine" | "external";

export interface StateEvent extends BaseEvent<StateTrigger> {
  readonly type: "state";
  readonly entityId: string;
  /** Previous state object; undefined when the entity was created. */
  readonly from: HassEntity | undefined;
  /** New state object; undefined when the entity was removed. */
  readonly to: HassEntity | undefined;
  /** For attribute triggers: the watched attribute and its old and new values. */
  readonly attribute?: string;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
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

export interface BusEvent extends BaseEvent<EventTrigger> {
  readonly type: "event";
  readonly eventType: string;
  readonly data: Record<string, unknown>;
  readonly origin: string;
  readonly timeFired: Date;
  readonly context: HassContext;
}

export interface HaTriggerEvent extends BaseEvent<HaTrigger> {
  readonly type: "ha-trigger";
  /** The trigger variables Home Assistant provides (`trigger.*` in YAML templates). */
  readonly variables: Record<string, unknown>;
}

export interface StartupEvent extends BaseEvent<StartupTrigger> {
  readonly type: "startup";
}

export interface TimeEvent extends BaseEvent<TimeTrigger> {
  readonly type: "time";
  /** When the trigger was scheduled to fire. */
  readonly scheduledAt: Date;
}

export interface SunEvent extends BaseEvent<SunTrigger> {
  readonly type: "sun";
  readonly event: SunEventName;
  readonly scheduledAt: Date;
}

export type RuleEvent =
  StateEvent | BusEvent | HaTriggerEvent | StartupEvent | TimeEvent | SunEvent;

/** The event a single trigger produces. */
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

/** The union of events a trigger list can produce. */
export type EventFor<T extends Triggers> = T extends readonly Trigger[]
  ? EventOf<T[number]>
  : T extends Trigger
    ? EventOf<T>
    : never;
