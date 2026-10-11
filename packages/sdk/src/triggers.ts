// Trigger descriptors: plain, frozen values that describe what starts a run. Constructors
// (onChange, cron, ...) only build these; the engine arms them when a rule starts.

import type { EntitySelector } from "./entities.js";

/** Milliseconds, or a duration string such as `"30s"`, `"5m"`, `"1h30m"` or `"500ms"`. */
export type Duration = number | string;

/** A value filter: one value, any of several values, or a predicate. */
export type ValueFilter<T = string> = T | readonly T[] | ((value: T) => boolean);

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

export interface StateTrigger extends Readonly<StateTriggerOptions> {
  readonly kind: "state";
  readonly entities: readonly EntitySelector[];
}

/** Partial match on event data; leaves may be literals, arrays of allowed values or predicates. */
export type EventDataFilter =
  Record<string, unknown> | ((data: Record<string, unknown>) => boolean);

export interface EventTrigger {
  readonly kind: "event";
  readonly eventType: string;
  readonly dataFilter?: EventDataFilter;
}

/** A native Home Assistant trigger configuration, as used in YAML automations. */
export interface HaTriggerConfig {
  platform?: string;
  trigger?: string;
  [key: string]: unknown;
}

export interface HaTrigger {
  readonly kind: "ha-trigger";
  readonly config: Readonly<HaTriggerConfig>;
}

export interface StartupTrigger {
  readonly kind: "startup";
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface CronTrigger {
  readonly kind: "cron";
  readonly expression: string;
}

export interface DailyTrigger {
  readonly kind: "daily";
  /** `"HH:MM"` or `"HH:MM:SS"`, local time of the Site. */
  readonly time: string;
  readonly weekdays?: readonly Weekday[];
}

export interface EveryTrigger {
  readonly kind: "every";
  readonly interval: Duration;
  /** Align ticks to this local time (`"HH:MM"`). */
  readonly alignTo?: string;
  /** Also fire right after the rule starts. */
  readonly immediate?: boolean;
}

export type SunEventName = "sunrise" | "sunset" | "dawn" | "dusk";

export interface SunTrigger {
  readonly kind: "sun";
  readonly event: SunEventName;
  /** Positive or negative, e.g. `"-30m"`. */
  readonly offset?: Duration;
}

export type TimeTrigger = CronTrigger | DailyTrigger | EveryTrigger;

export type Trigger =
  StateTrigger | EventTrigger | HaTrigger | StartupTrigger | TimeTrigger | SunTrigger;

/** One trigger or a list of triggers (any of them fires). */
export type Triggers = Trigger | readonly Trigger[];
