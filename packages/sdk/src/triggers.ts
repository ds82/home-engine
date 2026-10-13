// Trigger descriptors: plain, frozen values that describe what starts a run. Constructors
// (onChange, cron, ...) only build these; the engine arms them when a rule starts.

import type { EntitySelector } from "./entities.js";

/**
 * Milliseconds, or a duration string such as `"30s"`, `"5m"`, `"1h30m"` or `"500ms"`.
 * @category Types
 */
export type Duration = number | string;

/**
 * A value filter: one value, any of several values, or a predicate.
 * @category Triggers
 */
export type ValueFilter<T = string> = T | readonly T[] | ((value: T) => boolean);

/**
 * Options of {@link onChange}.
 * @category Triggers
 */
export interface StateTriggerOptions {
  /** Fire only when the previous value matches. */
  from?: ValueFilter;
  /** Fire only when the new value matches. */
  to?: ValueFilter;
  /** Watch this attribute instead of the state value; `"*"` watches state and all attributes. */
  attribute?: string;
  /** Fire only after the value has matched for this long (a hold). */
  for?: Duration;
  /** With `for` on several entities: one hold per entity (default) or one shared hold. */
  holdAs?: "entity" | "group";
  /** Evaluate against the current state when the rule starts. Not combinable with `for` or `from`. */
  immediate?: boolean;
  /** Treat transitions into or out of `unavailable`/`unknown` as no change. */
  ignoreUnavailable?: boolean;
}

/**
 * Fires on state changes of entities; built by {@link onChange}. Produces a {@link StateEvent}.
 * @category Triggers
 */
export interface StateTrigger extends Readonly<StateTriggerOptions> {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "state";
  /** The watched entity IDs and glob patterns. */
  readonly entities: readonly EntitySelector[];
}

/**
 * Partial match on event data; leaves may be literals, arrays of allowed values or predicates.
 * @category Triggers
 */
export type EventDataFilter =
  Record<string, unknown> | ((data: Record<string, unknown>) => boolean);

/**
 * Fires on Home Assistant bus events; built by {@link onEvent}. Produces a {@link BusEvent}.
 * @category Triggers
 */
export interface EventTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "event";
  /** The bus event type to listen for, e.g. `zha_event`. */
  readonly eventType: string;
  /** Only events whose data matches fire. */
  readonly dataFilter?: EventDataFilter;
}

/**
 * A native Home Assistant trigger configuration, as used in YAML automations.
 * @category Triggers
 */
export interface HaTriggerConfig {
  /** The trigger platform, e.g. `numeric_state` (the older key; same as `trigger`). */
  platform?: string;
  /** The trigger platform, e.g. `numeric_state` (the key newer Home Assistant versions use). */
  trigger?: string;
  [key: string]: unknown;
}

/**
 * A native Home Assistant trigger; built by {@link onTrigger}. Produces an
 * {@link HaTriggerEvent}.
 * @category Triggers
 */
export interface HaTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "ha-trigger";
  /** The trigger configuration sent to Home Assistant. */
  readonly config: Readonly<HaTriggerConfig>;
}

/**
 * Fires once each time the rule starts; built by {@link onStartup}. Produces a {@link StartupEvent}.
 * @category Triggers
 */
export interface StartupTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "startup";
}

/**
 * A day of the week, for {@link daily}.
 * @category Scheduling
 */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Fires on a cron schedule; built by {@link cron}. Produces a {@link TimeEvent}.
 * @category Scheduling
 */
export interface CronTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "cron";
  /** A 5-field expression, or a 6-field one with seconds in front. */
  readonly expression: string;
}

/**
 * Fires every day at a local time; built by {@link daily}. Produces a {@link TimeEvent}.
 * @category Scheduling
 */
export interface DailyTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "daily";
  /** `"HH:MM"` or `"HH:MM:SS"`, local time of the Site. */
  readonly time: string;
  /** Fire only on these days; every day when omitted. */
  readonly weekdays?: readonly Weekday[];
}

/**
 * Fires repeatedly at a fixed interval; built by {@link every}. Produces a {@link TimeEvent}.
 * @category Scheduling
 */
export interface EveryTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "every";
  /** The time between two firings. */
  readonly interval: Duration;
  /** Align ticks to this local time (`"HH:MM"`). */
  readonly alignTo?: string;
  /** Also fire right after the rule starts. */
  readonly immediate?: boolean;
}

/**
 * A sun event, computed from the Site's coordinates.
 * @category Scheduling
 */
export type SunEventName = "sunrise" | "sunset" | "dawn" | "dusk";

/**
 * Fires daily at a sun event; built by {@link sun}. Produces a {@link SunEvent}.
 * @category Scheduling
 */
export interface SunTrigger {
  /** Discriminates the {@link Trigger} union. */
  readonly kind: "sun";
  /** The sun event to fire at. */
  readonly event: SunEventName;
  /** Shifts the firing time; positive or negative, e.g. `"-30m"`. */
  readonly offset?: Duration;
}

/**
 * The clock-based triggers. They all produce a {@link TimeEvent}.
 * @category Scheduling
 */
export type TimeTrigger = CronTrigger | DailyTrigger | EveryTrigger;

/**
 * Any trigger: a description of what starts a run. It does nothing until a rule starts with it.
 * @category Triggers
 */
export type Trigger =
  StateTrigger | EventTrigger | HaTrigger | StartupTrigger | TimeTrigger | SunTrigger;

/**
 * One trigger or a list of triggers (any of them fires).
 * @category Triggers
 */
export type Triggers = Trigger | readonly Trigger[];
