// Trigger constructors: they only describe a trigger; the engine arms it when the rule starts.

import type { EntitySelector } from "./entities.js";
import { notInEngine } from "./stub.js";
import type {
  CronTrigger,
  DailyTrigger,
  Duration,
  EventDataFilter,
  EventTrigger,
  EveryTrigger,
  HaTrigger,
  HaTriggerConfig,
  StartupTrigger,
  StateTrigger,
  StateTriggerOptions,
  SunEventName,
  SunTrigger,
  Weekday,
} from "./triggers.js";

/**
 * Fires on state changes of the given entities (IDs or globs such as `light.*`). Runs receive
 * a {@link StateEvent}.
 * @category Triggers
 */
export function onChange(
  entities: EntitySelector | readonly EntitySelector[],
  options?: StateTriggerOptions,
): StateTrigger;
export function onChange(): StateTrigger {
  return notInEngine("onChange");
}

/**
 * Fires on Home Assistant bus events of a type, optionally filtered by their data. Runs
 * receive a {@link BusEvent}.
 * @category Triggers
 */
export function onEvent(eventType: string, dataFilter?: EventDataFilter): EventTrigger;
export function onEvent(): EventTrigger {
  return notInEngine("onEvent");
}

/**
 * Subscribes a native Home Assistant trigger (as in YAML automations). Runs receive an
 * {@link HaTriggerEvent}.
 * @category Triggers
 */
export function onTrigger(config: HaTriggerConfig): HaTrigger;
export function onTrigger(): HaTrigger {
  return notInEngine("onTrigger");
}

/**
 * Fires once each time the rule starts (engine start, reload, re-enable). Runs receive a
 * {@link StartupEvent}.
 * @category Triggers
 */
export function onStartup(): StartupTrigger {
  return notInEngine("onStartup");
}

/**
 * Fires on a 5- or 6-field cron schedule in the Site's time zone. Runs receive a
 * {@link TimeEvent}.
 * @category Scheduling
 */
export function cron(expression: string): CronTrigger;
export function cron(): CronTrigger {
  return notInEngine("cron");
}

/**
 * Fires every day at a local time (`"HH:MM"` or `"HH:MM:SS"`), optionally on some weekdays.
 * Runs receive a {@link TimeEvent}.
 * @category Scheduling
 */
export function daily(time: string, options?: { weekdays?: readonly Weekday[] }): DailyTrigger;
export function daily(): DailyTrigger {
  return notInEngine("daily");
}

/**
 * Fires repeatedly at a fixed interval after the rule starts. Runs receive a
 * {@link TimeEvent}.
 * @category Scheduling
 */
export function every(
  interval: Duration,
  options?: { alignTo?: string; immediate?: boolean },
): EveryTrigger;
export function every(): EveryTrigger {
  return notInEngine("every");
}

/**
 * Fires daily at sunrise, sunset, dawn or dusk, optionally offset (e.g. `"-30m"`). Runs
 * receive a {@link SunEvent}.
 * @category Scheduling
 */
export function sun(event: SunEventName, options?: { offset?: Duration }): SunTrigger;
export function sun(): SunTrigger {
  return notInEngine("sun");
}
